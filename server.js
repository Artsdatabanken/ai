const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

const taxonMapper = require("./taxonMapping");
const taxonPics = require("./taxonPictures");

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

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    let ext = file.mimetype.split("image/").pop(); //Get extension

    if (!ext) {
      console.log("Wrong file type");
      throw new Error({
        response: { status: 415, statusText: "Wrong file type" },
      });
    }
    cb(null, Date.now() + "." + ext); //Appending extension
  },
});

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
      "https://artsdatabanken.no/Api/Taxon/ScientificName?ScientificName=" +
        sciName
    );

    if (!taxon.data.length) {
      return nameResult;
    } else {
      if (taxon.data[0].acceptedNameUsage) {
        nameResult.scientificName =
          taxon.data[0].acceptedNameUsage.scientificName;
        nameResult.scientificNameID =
          taxon.data[0].acceptedNameUsage.scientificNameID;
      } else {
        nameResult.scientificNameID = taxon.data[0].scientificNameID;
      }

      name = await axios.get(
        "https://artsdatabanken.no/Api/Taxon/" + taxon.data[0].taxonID
      );
    }
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

  if (name && name.data.PreferredVernacularName) {
    nameResult.vernacularName =
      name.data.PreferredVernacularName.vernacularName;
  }
  return nameResult;
};

let getId = async (images) => {
  const form = new FormData();
  const formHeaders = form.getHeaders();

  images.forEach((image) => {
    form.append("image", image);
  });

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

  // -------------- Code that checks for duplicates, that may come from synonyms as well as accepted names being used
  // One known case: Speyeria aglaja (as Speyeria aglaia) and Argynnis aglaja that are handled manually until more are
  // found, as the method below takes quite some time

  // Check against list of misspellings and unknown synonyms
  recognition.data.predictions = recognition.data.predictions.map((pred) => {
    pred.taxon.name = taxonMapper.taxa[pred.taxon.name] || pred.taxon.name;
    return pred;
  });

  if (
    recognition.data.predictions.some(
      (p) => p.taxon.name === "Argynnis aglaja"
    ) &&
    recognition.data.predictions.some((p) => p.taxon.name === "Speyeria aglaja")
  ) {
    recognition.data.predictions.map((p) => {
      if (p.taxon.name === "Argynnis aglaja") {
        p.taxon.name = "Speyeria aglaja";
      }
      return p;
    });

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
  }
  // -------------- end of duplicate checking code

  // Get the data from the APIs (including accepted names of synonyms)
  for (let pred of recognition.data.predictions) {
    try {
      let nameResult = await getName(pred.taxon.name);
      pred.taxon.vernacularName = nameResult.vernacularName;
      pred.taxon.groupName = nameResult.groupName;
      pred.taxon.scientificNameID = nameResult.scientificNameID;
      pred.taxon.name = nameResult.scientificName;
      pred.taxon.picture = getPicture(nameResult.scientificName);
    } catch (error) {
      // console.log(error);
      throw error;
    }
  }

  return recognition.data;
};

app.post("/", upload.array("image"), async (req, res) => {
  files = [];

  for (let file of req.files) {
    files = [...files, fs.createReadStream(file.path)];
  }

  try {
    json = await getId(files);
    res.status(200).json(json);
  } catch (error) {
    res.status(error.response.status).end(error.response.statusText);
    console.log("Error", error.response.status);
  }
});

app.get("/", (req, res) => {
  res.status(200).end("Aiai!");
});

app.listen(port, console.log(`Server running on port ${port}`));
