const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./taxonMapping");
const taxonPics = require("./taxonPictures");
const crypto = require('crypto');
//const path = require('path');
const zlib = require('zlib');
var cron = require('node-cron');

function encrypt( file, password ) {
  // TODO, no encrypt 4 now

  // Generate a secure, pseudo random initialization vector.
  const initVect = crypto.randomBytes(16);

  // Generate a cipher key from the password.
  //const key = crypto.createHash('sha256').update(password).digest();
  const key = crypto.createHash('sha256').update(password).digest('base64').substr(0, 32);

  // Create a new cipher using the algorithm, key, and iv
  const cipher = crypto.createCipheriv('aes-256-ctr', key, initVect);
  //const cipher = crypto.createCipheriv('aes256', key, initVect);

  const gzip = zlib.createGzip();

  return file;
  /*
  // so this is obtained from different sources, but seem to handle text and not images. 
  // must research more the best approach.
  
  // Create the new (encrypted) buffer
    const result = Buffer.concat([initVect, cipher.update(buffer), cipher.final()]);   
    return result;
  
  // let readStream = file;
  // const readStream = fs.createReadStream(file);
  // const appendInitVect = new AppendInitVect(initVect);
  // Create a write stream with a different file extension.
  // const writeStream = fs.createWriteStream(path.join(file + ".enc"));
  */
}

let appInsights = require("applicationinsights");

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
}

dotenv.config({ path: "./config/config.env" });

const app = express();
const port = process.env.PORT;

var corsOptions = {
  origin: "*",
};

app.use(cors(corsOptions));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

let getPicture = (sciName) => {
  let pic = taxonPics.media[sciName];
  if (pic) {
    return `https://artsdatabanken.no/Media/${pic}?mode=128x128`;
  }
  return null;
};

let getName = async (sciName) => {
  let nameResult = {
    vernacularName: sciName,
    groupName: "",
    scientificName: sciName,
  };
  let name;

  try {
    let taxon = await axios.get(
      "https://artsdatabanken.no/api/Resource/?Take=10&Type=taxon&Name=" +
        sciName
    );

    if (!taxon.data.length) {
      return nameResult;
    }

    taxon.data = taxon.data.find(
      (t) => t.Name.includes(sciName) && t.AcceptedNameUsage
    );

    if (!taxon.data) {
      return nameResult;
    }

    nameResult.scientificName = taxon.data.AcceptedNameUsage.ScientificName;
    nameResult.scientificNameID = taxon.data.AcceptedNameUsage.ScientificNameId;

    nameResult.vernacularName =
      taxon.data["RecommendedVernacularName_nb-NO"] ||
      taxon.data["RecommendedVernacularName_nn-NO"] ||
      sciName;

    if (taxon.data.Description) {
      nameResult.infoUrl = taxon.data.Description[0].Id.replace(
        "Nodes/",
        "https://artsdatabanken.no/Pages/"
      );
    } else {
      nameResult.infoUrl = "https://artsdatabanken.no/" + taxon.data.Id;
    }

    name = await axios.get("https://artsdatabanken.no/Api/" + taxon.data.Id);
  } catch (error) {
    // console.log(error);
    throw error;
  }

  if (name && name.data.AcceptedName.dynamicProperties) {
    nameResult.groupName = name.data.AcceptedName.dynamicProperties.find(
      (dp) =>
        dp.Name === "GruppeNavn" &&
        dp.Properties.find((p) => p.Value === "Artsobservasjoner")
    ).Value;
  }

  return nameResult;
};

// Check if there are old files to be deleted every X minute:
cron.schedule('30 * * * *', () => {
  //console.log("running task every 20th second")
  console.log('Running cleanup every 30th minute');
  
  // Loop over all files in uploads/ 
  fs.readdir('./uploads/', (err, files) => {
    files.forEach(file => {
        // gets timestamp from filename
        let filename = file.split("_")[1]; 
        // gets current timestamp
        let timestamp = Math.round((new Date()).getTime() / 1000);
        // Check timestamp vs. time now
        let time_between = timestamp - filename;
        let survival_length = 3600 // 1 hr in seconds
        // If more than survival_length 
        if(time_between >= survival_length){
          // Delete the file 
          fs.unlink('./uploads/'+file, (err) => {
            if (err){console.log("could not delete file")};
            console.log('The file has been deleted!');
          });
        }
    });
  });
});

function makeRandomHash() {
  let current_date = (new Date()).valueOf().toString();
  let random = Math.random().toString();
  // TODO check that this is not used. To do this, loop over uploads folder
  return crypto.createHash('sha1').update(current_date + random).digest('hex');
  
}

let saveImagesAndGetToken = async(req) => {
  // Create random, unused id & password
  let id = makeRandomHash();
  let password = makeRandomHash();
  console.log("time to upload image wih id: ", id)
  for (let image of req.files) {
    let timestamp = Math.round((new Date()).getTime() / 1000);
    // Encrypt file with password
    let encrypted_file = encrypt(image,password);
    // Save encrypted file to disk and put id & date (unix timestamp, et heltall) in filename
    fs.writeFile('./uploads/' + id + '_' + timestamp + '_.jpg', encrypted_file.buffer, (err) => {
      if (err) throw err;
      console.log('The file has been saved!');
    });
  }
  return {'id':id, 'password':password};
}

let getId = async (req) => {
  const form = new FormData();
  const formHeaders = form.getHeaders();

  var stream = require("stream");

  for (const file of req.files) {
    var bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);
    form.append("image", bufferStream, {
      filename: "" + Date.now() + "." + file.mimetype.split("image/").pop(),
    });
  }

  let recognition;

  try {
    recognition = await axios.post(
      "http://artsdatabanken.demo.naturalis.io/v1/observation/identify/noall/auth",
      form,
      {
        headers: {
          ...formHeaders,
          Authorization: "Basic " + process.env.NATURALIS_TOKEN,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
  } catch (error) {
    // console.log(error);
    throw error;
  }

  // get the best 5
  recognition.data.predictions = recognition.data.predictions.slice(0, 5);

  // Check against list of misspellings and unknown synonyms
  recognition.data.predictions = recognition.data.predictions.map((pred) => {
    pred.taxon.name = taxonMapper.taxa[pred.taxon.name] || pred.taxon.name;
    return pred;
  });

  // Get the data from the APIs (including accepted names of synonyms)
  for (let pred of recognition.data.predictions) {
    try {
      let nameResult = await getName(pred.taxon.name);
      pred.taxon.vernacularName = nameResult.vernacularName;
      pred.taxon.groupName = nameResult.groupName;
      pred.taxon.scientificNameID = nameResult.scientificNameID;
      pred.taxon.name = nameResult.scientificName;
      pred.taxon.infoUrl = nameResult.infoUrl;
      pred.taxon.picture = getPicture(nameResult.scientificName);
    } catch (error) {
      // console.log(error);
      throw error;
    }
  }

  // -------------- Code that checks for duplicates, that may come from synonyms as well as accepted names being used
  // One known case: Speyeria aglaja (as Speyeria aglaia) and Argynnis aglaja

  // if there are duplicates, add the probabilities and delete the duplicates
  for (let pred of recognition.data.predictions) {
    let totalProbability = recognition.data.predictions
      .filter((p) => p.taxon.name === pred.taxon.name)
      .reduce((total, p) => total + p.probability, 0);

    if (totalProbability !== pred.probability) {
      pred.probability = totalProbability;
      recognition.data.predictions = recognition.data.predictions.filter(
        (p) => p.taxon.name !== pred.taxon.name
      );
      recognition.data.predictions.unshift(pred);
    }
  }

  // sort by the new probabilities
  recognition.data.predictions = recognition.data.predictions.sort((a, b) => {
    return b.probability - a.probability;
  });
  // -------------- end of duplicate checking code

  return recognition.data;
};

app.post("/", upload.array("image"), async (req, res) => {
  try {
    json = await getId(req);

    res.status(200).json(json);
  } catch (error) {
    res.status(error.response.status).end(error.response.statusText);
    console.log("Error", error.response.status);
    fs.appendFileSync(
      "./log/log.txt",
      "Error identifying: " + error.response.status + "\n"
    );
  }
});

app.post("/save", upload.array("image"), async (req, res) => {
  try {
    json = await saveImagesAndGetToken(req);
    res.status(200).json(json);
  } catch (error) {
    console.log("Error", error);
  }
});

app.get("/", (req, res) => {
  res.status(200).end("Aiai!");
});

app.listen(port, console.log(`Server running on port ${port}`));
