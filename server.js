const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

let appInsights = require("applicationinsights");

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
}

dotenv.config({ path: "./config/config.env" });

const app = express();
const port = process.env.PORT;

var corsOptions = {
  origin: [
    "https://orakel.test.artsdatabanken.no",
    "https://orakel.artsdatabanken.no",
    "http://localhost:3000",
  ],
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
      throw new Error("Wrong file type");
    }
    cb(null, Date.now() + "." + ext); //Appending extension
  },
});

const upload = multer({ storage: storage });

let getName = async (sciName) => {
  let nameResult = { vernacularName: sciName, groupName: "" };
  let name;

  try {
    let taxon = await axios.get(
      "https://artsdatabanken.no/Api/Taxon/ScientificName?ScientificName=" +
        sciName
    );

    if (!taxon.data.length) {
      return nameResult;
    } else {
      nameResult.scientificNameID = taxon.data[0].scientificNameID;
      name = await axios.get(
        "https://artsdatabanken.no/Api/Taxon/" + taxon.data[0].taxonID
      );
    }
  } catch (error) {
    console.log(error);
    throw new Error(error);
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
    console.log(error);
    throw new Error(error);
  }

  recognition.data.predictions = recognition.data.predictions.slice(0, 5);

  for (let pred of recognition.data.predictions) {
    try {
      let nameResult = await getName(pred.taxon.name);
      pred.taxon.vernacularName = nameResult.vernacularName;
      pred.taxon.groupName = nameResult.groupName;
    } catch (error) {
      console.log(error);
      throw new Error(error);
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
    console.log(error);
    res.status(500).end(error);
    throw new Error(error);
  }
});

app.get("/", (req, res) => {
  res.status(200).end("Aiai!");
});

app.listen(port, console.log(`Server running on port ${port}`));
