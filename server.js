const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./taxonMapping");
const taxonPics = require("./taxonPictures");
const cron = require('node-cron');

// Use the crypto library for encryption and decryption
const crypto = require('crypto');
const encryption_algorithm = 'aes-256-ctr';
// Generate a secure, pseudo random initialization vector for encryption
const initVect = crypto.randomBytes(16);

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
  //console.log('Running cleanup every 30th minute');
  
  // Loop over all files in uploads/ 
  fs.readdir('./uploads/', (err, files) => {
    files.forEach(file => {
        // gets timestamp from filename
        let filename = file.split("_")[1]; 
        // gets current timestamp
        let timestamp = Math.round((new Date()).getTime() / 1000);
        // Check timestamp vs. time now
        let time_between = timestamp - filename;
        // Image Survival length, if change this - ensure to change in artsobs-mobile too...
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

function encrypt( file, password ) {  
  // Create a new cipher using the algorithm, key, and initVect
  const cipher = crypto.createCipheriv(encryption_algorithm, password, initVect);
  // file is already a string - base64
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
  return encrypted;
}

const decrypt = (encrypted_content,password) => {
  // Use the same things to create the decipher vector
  const decipher = crypto.createDecipheriv(encryption_algorithm, password, initVect);
  // Apply the deciphering
  const decrypted = Buffer.concat([decipher.update(encrypted_content), decipher.final()]);
  return decrypted.toString();
};

function makeRandomHash() {  
  // TODO check that this is not used. To do this, loop over uploads folder
  // It would be shocking if it is used considering we use the current date as input, and 
  // clean out images every 30 minutes. But you never know.
  let current_date = (new Date()).valueOf().toString();
  let random = Math.random().toString();
  return crypto.createHash('sha1').update(current_date + random).digest('hex');
}

let saveImagesAndGetToken = async(req) => {
  // Create random, unused id & password, password must be a certain length
  let id = makeRandomHash();
  let password = makeRandomHash().substring(0,32);
  let counter = 0;

  for (let image of req.files) {    
    let timestamp = Math.round((new Date()).getTime() / 1000);
    
    // Turn image into base64 to allow both encryption and future transfer
    let base64image = image.buffer.toString('base64');

    // Perform encryption
    let encrypted_file = encrypt(base64image,password);    

    // Save encrypted file to disk and put id & date (unix timestamp) in filename
    let filename = id + '_' + counter + '_' + timestamp + '_'; 

    // ensure uniqueness in case the other factors end up the same (unlikely)
    counter += 1; 

    // Upload to uploads folder
    fs.writeFile('./uploads/' + filename , encrypted_file, (err) => {
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
  // image saving request from the orakel service
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

app.get("/image/*", (req, res) => {
    // image request from the orakel service
    // On the form /image/id&password

    // Url used to arrive here from outside
    let url = req.originalUrl.replace('/image/','');

    // Obtain password from the end of the url
    let password = url.split('&')[1].toString();

    // Obtain the image id's from the url
    url = url.split('&')[0]

    // Loop over all files in uploads/     
    fs.readdir('./uploads/', (err, files) => {
      let image_list = [];

      files.forEach(file => {
          // The id's in upload are of the format:
          // sessionid_number_timestamp this to ensure unique id's
          // to get all entries from one session, we use only the first of these
          const fileid = file.split('_')[0]; 

          if(fileid === url){
            // If the request has a match in the database (it should unless the user was too slow)
            const image_to_fetch = "./uploads/"+file;

            // read the file
            const file_buffer  = fs.readFileSync(image_to_fetch);

            // decrypt the file
            let decrypted_file = decrypt(file_buffer,password);

            // add the file to the return list
            image_list.push(decrypted_file);
          }
      });
      // generate json object to return at request
      let json = {image:image_list}
      try {
        res.status(200).json(json);
      } catch (error) {
        console.error("Error", error);
      }
    })
});

app.listen(port, console.log(`Server running on port ${port}`));
