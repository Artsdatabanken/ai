const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./taxonMapping");
const taxonPics = require("./log/taxonPictures");
const cron = require("node-cron");

// Use the crypto library for encryption and decryption
const crypto = require("crypto");
const encryption_algorithm = "aes-256-ctr";
// Generate a secure, pseudo random initialization vector for encryption
const initVect = crypto.randomBytes(16);

let appInsights = require("applicationinsights");

var dir = './log/taxa';
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

/** Filter for not logging requests for root url when success */
var filteringAiFunction = (envelope, context) => {
  if (
    envelope.data.baseData.success &&
    envelope.data.baseData.name === "GET /"
  ) {
    return false;
  }

  return true;
};

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
  appInsights.defaultClient.addTelemetryProcessor(filteringAiFunction);
}

dotenv.config({ path: "./config/config.env" });
dotenv.config({ path: "./config/secrets.env" });

const app = express();
const port = process.env.PORT;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

var corsOptions = {
  origin: "*",
};

app.use(cors(corsOptions));

app.use(function (req, res, next) {
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

let getPicture = (sciName) => {
  let pic = taxonPics.media[sciName];
  if (pic) {
    return `https://artsdatabanken.no/Media/${pic}?mode=128x128`;
  }
  return null;
};

let writelog = (req, json) => {
  let today = new Date();
  let year = today.getFullYear();
  let month = ("0" + (today.getMonth() + 1)).slice(-2);
  let day = ("0" + today.getDate()).slice(-2);
  let hours = ("0" + today.getHours()).slice(-2);
  let minutes = ("0" + today.getMinutes()).slice(-2);
  let seconds = ("0" + today.getSeconds()).slice(-2);
  let date = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

  let application = req.body.application;

  if (!fs.existsSync(`./log/${application}_${year}-${month}.csv`)) {
    fs.appendFileSync(
      `./log/${application}_${year}-${month}.csv`,
      "Datetime," +
      "Number_of_pictures," +
      "Result_1_name,Result_1_group,Result_1_probability," +
      "Result_2_name,Result_2_group,Result_2_probability," +
      "Result_3_name,Result_3_group,Result_3_probability," +
      "Result_4_name,Result_4_group,Result_4_probability," +
      "Result_5_name,Result_5_group,Result_5_probability\n"
    );
  }

  // TODO
  // Add encrypted IP (req.client._peername.address)

  let row = `${date},${req.files.length}`;

  if (!req.body.application) {
    for (let i = 0; i < json.predictions.length; i++) {
      const prediction = json.predictions[i];
      row += `,"${prediction.taxon.name}","${prediction.taxon.groupName}",${prediction.probability}`;
    }
  } else {
    for (let i = 0; i < json.predictions[0].taxa.items.length; i++) {
      const prediction = json.predictions[0].taxa.items[i];
      row += `,"${prediction.name}","${prediction.groupName}",${prediction.probability}`;
    }
  }

  row += "\n";

  fs.appendFileSync(`./log/${application}_${year}-${month}.csv`, row);
};

let getName = async (sciName) => {

  let jsonfilename = `./log/taxa/${sciName}.json`

  if (fs.existsSync(jsonfilename)) {
    let taxon = JSON.parse(fs.readFileSync(jsonfilename));
    return taxon;
  }

  let nameResult = {
    vernacularName: sciName,
    groupName: "",
    scientificName: sciName,
  };
  let name;

  try {
    let taxon = await axios.get(
      "https://artsdatabanken.no/api/Resource/?Take=10&Type=taxon&Name=" +
      sciName,
      {
        timeout: 5000, // Set a timeout of 5 seconds
      }
    )
      .catch(error => {
        if (error.code === 'ECONNABORTED') {
          console.log('Request timed out');
        } else {
          console.log(error.message);
        }
        error = true
      });

    if (!taxon || !taxon.data.length) {
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
      nameResult.scientificName ||
      sciName;

    if (taxon.data.Description) {
      const description =
        taxon.data.Description.find(
          (desc) =>
            desc.Language == "nb" ||
            desc.Language == "no" ||
            desc.Language == "nn"
        ) || taxon.data.Description[0];

      nameResult.infoUrl = description.Id.replace(
        "Nodes/",
        "https://artsdatabanken.no/Pages/"
      );
    } else {
      nameResult.infoUrl = "https://artsdatabanken.no/" + taxon.data.Id;
    }

    name = await axios.get("https://artsdatabanken.no/Api/" + taxon.data.Id,
      {
        timeout: 5000, // Set a timeout of 5 seconds
      });
  } catch (error) {
    date = new Date().toISOString();
    console.log(date, error);

    fs.appendFileSync(
      "./log/log.txt",
      "Error getting names: " + error.response.status + " (" + date + ")\n"
    );

    throw error;
  }

  if (name && name.data.AcceptedName.dynamicProperties) {
    let artsobsname = nameResult.groupName = name.data.AcceptedName.dynamicProperties.find(
      (dp) =>
        dp.Name === "GruppeNavn" &&
        dp.Properties.find((p) => p.Value === "Artsobservasjoner")
    )

    if (artsobsname && artsobsname.Value) {
      nameResult.groupName = artsobsname.Value
    }
  }


  if (!fs.existsSync(jsonfilename)) {
    let data = JSON.stringify(nameResult);
    fs.writeFileSync(jsonfilename, data);
  }

  return nameResult;
};

// Check if there are old files to be deleted every X minute:
cron.schedule("30 * * * *", () => {
  //console.log('Running cleanup every 30th minute');

  // Loop over all files in uploads/
  fs.readdir("./uploads/", (err, files) => {

    if (files) {
      files.forEach((file) => {
        // gets timestamp from filename
        let filename = file.split("_")[1];
        // gets current timestamp
        let timestamp = Math.round(new Date().getTime() / 1000);
        // Check timestamp vs. time now
        let time_between = timestamp - filename;
        // Image Survival length, if change this - ensure to change in artsobs-mobile too...
        let survival_length = 3600; // 1 hr in seconds
        // If more than survival_length
        if (time_between >= survival_length) {
          // Delete the file
          fs.unlink("./uploads/" + file, (err) => {
            if (err) {
              console.log("could not delete file");
            }
            console.log("The file has been deleted!");
          });
        }
      });
    }
  });
});

function encrypt(file, password) {
  // Create a new cipher using the algorithm, key, and initVect
  const cipher = crypto.createCipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  // file is already a string - base64
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
  return encrypted;
}

const decrypt = (encrypted_content, password) => {
  // Use the same things to create the decipher vector
  const decipher = crypto.createDecipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  // Apply the deciphering
  const decrypted = Buffer.concat([
    decipher.update(encrypted_content),
    decipher.final(),
  ]);
  return decrypted.toString();
};

function makeRandomHash() {
  // TODO check that this is not used. To do this, loop over uploads folder
  // It would be shocking if it is used considering we use the current date as input, and
  // clean out images every 30 minutes. But you never know.
  let current_date = new Date().valueOf().toString();
  let random = Math.random().toString();
  return crypto
    .createHash("sha1")
    .update(current_date + random)
    .digest("hex");
}

let saveImagesAndGetToken = async (req) => {
  // Create random, unused id & password, password must be a certain length
  let id = makeRandomHash();
  let password = makeRandomHash().substring(0, 32);
  let counter = 0;

  for (let image of req.files) {
    let timestamp = Math.round(new Date().getTime() / 1000);

    // Turn image into base64 to allow both encryption and future transfer
    let base64image = image.buffer.toString("base64");

    // Perform encryption
    let encrypted_file = encrypt(base64image, password);

    // Save encrypted file to disk and put id & date (unix timestamp) in filename
    let filename = id + "_" + counter + "_" + timestamp + "_";

    // ensure uniqueness in case the other factors end up the same (unlikely)
    counter += 1;

    // Upload to uploads folder
    fs.writeFile("./uploads/" + filename, encrypted_file, (err) => {
      if (err) throw err;
      console.log("The file has been saved!");
    });
  }
  return { id: id, password: password };
};

let simplifyJson = (json) => {
  if (json.predictions[0].taxa) {
    json.predictions = json.predictions[0].taxa.items.map((p) => {
      let simplified = {
        probability: p.probability,
        taxon: p,
      };
      simplified.taxon.probability = undefined;
      return simplified;
    });
  }

  return json;
};

let refreshtaxonimages = async () => {
  const pages = [342548, 342550, 342551, 342552, 342553, 342554];
  let taxa = {};

  for (let index = 0; index < pages.length; index++) {
    let pageId = pages[index];
    let page = await axios.get(
      `https://www.artsdatabanken.no/api/Content/${pageId}`,
      {
        timeout: 10000, // Set a timeout of 10 seconds
      }
    );

    if (!!page) {
      page.data.Files.forEach((f) => {
        // Unpublished files have no FileUrl
        if (f.FileUrl) {
          let name = f.Title.split(".")[0].replaceAll("_", " ");
          let value = f.Id.split("/")[1];
          taxa[name] = value;
        }
      });

    }
  }

  let data = JSON.stringify(taxa);
  fs.writeFileSync("log/taxonPictures.js", `module.exports = {media: ${data}};`);
  return Object.keys(taxa).length;

};

let getId = async (req) => {
  const form = new FormData();
  const formHeaders = form.getHeaders();

  const receivedParams = Object.keys(req.body);

  receivedParams.forEach((key, index) => {
    form.append(key, req.body[key]);
  });

  var stream = require("stream");

  for (const file of req.files) {
    var bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);
    form.append("image", bufferStream, {
      filename: "" + Date.now() + "." + file.mimetype.split("image/").pop(),
    });
  }

  let token;
  if (receivedParams.model && receivedParams.model.toLowerCase() === "global") {
    token = process.env.SH_TOKEN; // Shared token
  } else {
    token = process.env.SP_TOKEN; // Specialized (Norwegian) token
  }

  let recognition;

  if (!req.body.application) {
    try {
      recognition = await axios.post(
        "https://artsdatabanken.biodiversityanalysis.eu/v1/observation/identify/noall/auth",
        form,

        {
          headers: {
            ...formHeaders,
            Authorization: "Basic " + process.env.LEGACY_TOKEN,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );
    } catch (error) {
      date = new Date().toISOString();
      console.log(date, error);
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
        date = new Date().toISOString();
        console.log(date, error);
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
  } else {
    try {
      recognition = await axios.post(
        `https://multi-source.identify.biodiversityanalysis.eu/v2/observation/identify/token/${token}`,
        form,
        {
          headers: {
            ...formHeaders,
          },
          auth: {
            username: process.env.NATURALIS_USERNAME,
            password: process.env.NATURALIS_PASSWORD,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );
    } catch (error) {
      date = new Date().toISOString();
      console.log(date, error);
      throw error;
    }
  }

  for (let index = 0; index < recognition.data.predictions.length; index++) {
    let taxa = recognition.data.predictions[index].taxa.items;

    // get the best 5
    taxa = taxa.slice(0, 5);
    filteredTaxa = taxa.filter(taxon => taxon.probability >= .02)

    if (filteredTaxa.length) {
      taxa = filteredTaxa
    }
    else {
      taxa = taxa.slice(0, 2);
    }




    // Check against list of misspellings and unknown synonyms
    taxa = taxa.map((pred) => {
      pred.scientific_name =
        taxonMapper.taxa[pred.scientific_name] || pred.scientific_name;
      return pred;
    });

    // Get the data from the APIs (including accepted names of synonyms)
    for (let pred of taxa) {
      try {
        let nameResult;
        if (req.body.application.toLowerCase() === "artsobservasjoner") {
          pred.name = pred.scientific_name;
        }
        else {
          nameResult = await getName(pred.scientific_name);
          pred.vernacularName = nameResult.vernacularName;
          pred.groupName = nameResult.groupName;
          pred.scientificNameID = nameResult.scientificNameID;
          pred.name = nameResult.scientificName;
          pred.infoUrl = nameResult.infoUrl;
        }

        pred.picture = getPicture(pred.scientific_name);
      } catch (error) {
        date = new Date().toISOString();
        console.log(date, error);
        throw error;
      }
    }

    recognition.data.predictions[index].taxa.items = taxa;
  }

  // -------------- Code that checks for duplicates, that may come from synonyms as well as accepted names being used
  // One known case: Speyeria aglaja (as Speyeria aglaia) and Argynnis aglaja

  // if there are duplicates, add the probabilities and delete the duplicates
  // for (let pred of recognition.data.predictions) {
  //   let totalProbability = recognition.data.predictions
  //     .filter((p) => p.name === pred.name)
  //     .reduce((total, p) => total + p.probability, 0);

  //   if (totalProbability !== pred.probability) {
  //     pred.probability = totalProbability;
  //     recognition.data.predictions = recognition.data.predictions.filter(
  //       (p) => p.name !== pred.name
  //     );
  //     recognition.data.predictions.unshift(pred);
  //   }
  // }

  // // sort by the new probabilities
  // recognition.data.predictions = recognition.data.predictions.sort((a, b) => {
  //   return b.probability - a.probability;
  // });
  // -------------- end of duplicate checking code

  recognition.data.application = req.body.application;

  return recognition.data;
};

app.get("/taxonimage/*", (req, res) => {
  let taxon = decodeURI(req.originalUrl.replace("/taxonimage/", ""));

  res.status(200).end(getPicture(taxon));
});

app.get("/refreshtaxonimages", async (req, res) => {
  let number = await refreshtaxonimages();
  res.status(200).end(`${number} pictures found`);
});

app.post("/", upload.array("image"), async (req, res) => {
  // Future simple token check

  // if (req.headers["authorization"] !== `Bearer ${process.env.AI_TOKEN}`) {
  //   res.status(401).end("Unauthorized");
  //   return true;
  // }

  try {
    json = await getId(req);

    // Write to the log
    writelog(req, json);

    if (req.body.application === undefined) {
      res.status(200).json(simplifyJson(json));
    } else {
      res.status(200).json(json);
    }
  } catch (error) {
    console.log(error);
    date = new Date().toISOString();

    if(error.response) {
      res.status(error.response.status).end(error.response.statusText);
      console.log(date, "Error", error.response.status);
    }
    else {
      console.log(date, "Error", error);
    }

    fs.appendFileSync(
      "./log/log.txt",
      "Error identifying: " + error.response.status + " (" + date + ")\n"
    );
  }
});

app.post("/save", upload.array("image"), async (req, res) => {
  // image saving request from the orakel service
  try {
    json = await saveImagesAndGetToken(req);
    res.status(200).json(json);
  } catch (error) {
    date = new Date().toISOString();
    console.log(date, "Error", error);
  }
});

app.get("/", (req, res) => {
  res.status(200).end("Aiai!");
});

app.get("/image/*", (req, res) => {
  // image request from the orakel service
  // On the form /image/id&password

  // Url used to arrive here from outside
  let url = req.originalUrl.replace("/image/", "");

  // Obtain password from the end of the url
  let password = url.split("&")[1].toString();

  // Obtain the image id's from the url
  url = url.split("&")[0];

  // Loop over all files in uploads/
  fs.readdir("./uploads/", (err, files) => {
    let image_list = [];

    files.forEach((file) => {
      // The id's in upload are of the format:
      // sessionid_number_timestamp this to ensure unique id's
      // to get all entries from one session, we use only the first of these
      const fileid = file.split("_")[0];

      if (fileid === url) {
        // If the request has a match in the database (it should unless the user was too slow)
        const image_to_fetch = "./uploads/" + file;

        // read the file
        const file_buffer = fs.readFileSync(image_to_fetch);

        // decrypt the file
        let decrypted_file = decrypt(file_buffer, password);

        // add the file to the return list
        image_list.push(decrypted_file);
      }
    });
    // generate json object to return at request
    let json = { image: image_list };
    try {
      res.status(200).json(json);
    } catch (error) {
      date = new Date().toISOString();
      console.error(date, "Error", error);
    }
  });
});

app.listen(port, console.log(`Server now running on port ${port}`));
