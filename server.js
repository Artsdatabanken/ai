const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./taxonMapping");
const taxonPics = require("./taxonPictures");

// Use the crypto library for encryption and decryption
const crypto = require("crypto");

let appInsights = require("applicationinsights");

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
}

dotenv.config({ path: "./config/config.env" });

var corsOptions = {
  origin: "*",
};

const app = express();
const port = process.env.PORT;
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({"extended": false}));

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
    date = new Date().toISOString();
    console.log(date, error);
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

app.get("/", (req, res) => {
  res.status(200).end("Aiai!");
});

// ---------------------------------------------------------------------------
// Code for the NTNU experiment
// ---------------------------------------------------------------------------

let isValidUser = (username) => {
  return fs.existsSync("./log/users/" + username);
};

let userHasAI = (username) => {
  const jsonfile = "./log/users/" + username + "/settings.json";
  var obj = JSON.parse(fs.readFileSync(jsonfile, "utf8"));

  let now = new Date().getTime();
  for (aitime of obj.aitimes) {
    if (Date.parse(aitime.from) < now && Date.parse(aitime.to) > now) {
      return true;
    }
  }
  return false;
};

app.post("/report", express.static("public"), async (req, res) => {
  const reportdir = "./log/users/" + req.body.user + "/reports";
  if (!fs.existsSync(reportdir)) {
    fs.mkdirSync(reportdir);
  }

  let data = JSON.stringify(req.body);
  fs.writeFileSync(reportdir + "/" + req.body.obsId + ".json", data);

  if (!fs.existsSync(reportdir)) {
    fs.mkdirSync(reportdir);
  }

  let csvRow = "";

  if (!fs.existsSync(reportdir + "/reports.csv")) {
    csvRow +=
      "date,user,obsId,ai,species,certainty,knowledgeSource,usedTools,comment\n";
  }

  csvRow +=
    '"' +
    new Date().toISOString() +
    '","' +
    req.body.user +
    '","' +
    req.body.obsId +
    '","' +
    req.body.ai +
    '","' +
    req.body.species +
    '",' +
    req.body.certainty +
    ',"' +
    req.body.knowledgeSource +
    '","' +
    req.body.usedTools +
    '","' +
    req.body.comment +
    '"\n';

  fs.appendFileSync(reportdir + "/reports.csv", csvRow);
  res.status(200).json("success");
});

app.post("/", upload.array("image"), async (req, res) => {
  const user = req.body.user;

  console.log(user, "sent some data");

  if (!user || !isValidUser(user)) {
    res.status(200).json("Invalid user");
    return;
  }

  try {
    id = await saveImages(req);

    if (userHasAI(user)) {
      json = await getIdExperiment(req);
    } else {
      json = { predictions: [] };
    }

    json["obsid"] = id;

    res.status(200).json(json);
  } catch (error) {
    res.status(error.response.status).end(error.response.statusText);
    date = new Date().toISOString();

    console.log(date, "Error", error.response.status);
    fs.appendFileSync(
      "./log/log.txt",
      "Error identifying: " + error.response.status + "\n"
    );
  }
});

let saveImages = async (req) => {
  const user = req.body.user;
  imgdir = "./log/users/" + user + "/img/";

  if (!fs.existsSync(imgdir)) {
    fs.mkdirSync(imgdir);
  }

  let counter = 0;
  let id = makeRandomHash().substr(0, 5);
  while (fs.existsSync(imgdir + id + "_0.jpg")) {
    id = makeRandomHash().substr(0, 5);
  }

  for (let image of req.files) {
    fs.writeFile(imgdir + id + "_" + counter + ".jpg", image.buffer, (err) => {
      if (err) throw err;
    });
    counter += 1;
  }
  return id;
};

let getIdExperiment = async (req) => {
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
      "https://artsdatabanken.biodiversityanalysis.eu/v1/observation/identify/noall/auth",
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
};

// ---------------------------------------------------------------------------

app.listen(port, console.log(`Research server now running on port ${port}`));
