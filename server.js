const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

const taxonMapper = require("./taxonMapping");
const taxonPics = require("./taxonPictures");

// Use the crypto library for encryption and decryption
const crypto = require("crypto");

let appInsights = require("applicationinsights");

const colors = [
  { name: "rød", h: "0", s: "100%", l: "30%" },
  { name: "oransj", h: "35", s: "100%", l: "40%" },
  { name: "gul", h: "55", s: "100%", l: "40%" },
  { name: "grønn", h: "115", s: "100%", l: "30%" },
  { name: "turkis", h: "175", s: "100%", l: "30%" },
  { name: "blå", h: "210", s: "100%", l: "30%" },
  { name: "fiolett", h: "275", s: "100%", l: "30%" },
  { name: "rosa", h: "300", s: "100%", l: "40%" },
  { name: "svart", h: "0", s: "0%", l: "0%" },
  { name: "grå", h: "0", s: "0%", l: "50%" },
];

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
app.use(express.urlencoded({ extended: false }));

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

  if (obj.aitimes) {
    let now = new Date().getTime();
    for (aitime of obj.aitimes) {
      if (Date.parse(aitime.from) < now && Date.parse(aitime.to) > now) {
        return true;
      }
    }
  }

  if (obj.ai) {
    const now = parseInt(new Date().getTime() / (1000 * 60 * 60 * 24)); // Days since 1970-1-1
    return (now + obj.ai.offset) % obj.ai.days == 0;
  }

  return false;
};

app.post("/report", express.static("public"), async (req, res) => {
  const reportdir = "./log/users/" + req.body.user + "/reports";
  const jsonfile = "./log/users/" + req.body.user + "/settings.json";
  var user = JSON.parse(fs.readFileSync(jsonfile, "utf8"));
  const projectdir = "./log/projects/" + user.project;

  if (!fs.existsSync(reportdir)) {
    fs.mkdirSync(reportdir);
  }

  let data = JSON.stringify(req.body);
  fs.writeFileSync(reportdir + "/" + req.body.obsId + ".json", data);

  if (!fs.existsSync(reportdir)) {
    fs.mkdirSync(reportdir);
  }

  if (!fs.existsSync(reportdir + "/reports.csv")) {
    fs.appendFileSync(
      reportdir + "/reports.csv",
      "date,user,username,obsId,ai,reportFirst,hasReadMore,species,certainty,knowledgeSource,usedTools,comment\n"
    );
  }

  if (!fs.existsSync(projectdir + "/observations.csv")) {
    fs.appendFileSync(
      projectdir + "/observations.csv",
      "date,user,username,obsId,ai,reportFirst,hasReadMore,species,certainty,knowledgeSource,usedTools,comment\n"
    );
  }

  let csvRow =
    '"' +
    new Date().toISOString() +
    '","' +
    req.body.user +
    '","' +
    req.body.username +
    '","' +
    req.body.obsId +
    '","' +
    req.body.ai +
    '","' +
    req.body.reportFirst +
    '","' +
    req.body.hasReadMore +
    '","' +
    req.body.species +
    '","' +
    req.body.certainty +
    '","' +
    req.body.knowledgeSource +
    '","' +
    req.body.usedTools +
    '","' +
    req.body.comment +
    '"\n';

  fs.appendFileSync(reportdir + "/reports.csv", csvRow);
  fs.appendFileSync(projectdir + "/observations.csv", csvRow);

  res.status(200).json("success");
});

app.post("/newProject", express.static("public"), async (req, res) => {
  let id = makeRandomHash().substr(0, 5);
  let projectDir = "./log/projects/" + id;

  while (fs.existsSync(projectDir)) {
    id = makeRandomHash().substr(0, 5);
    projectDir = "./log/projects/" + id;
  }
  fs.mkdirSync(projectDir);

  let data = {
    id: id,
    name: req.body.name,
    contact: req.body.contact,
    ai: req.body.ai,
    reportFirst: req.body.reportFirst,
    dailyRegime: req.body.dailyRegime,
    users: [],
  };
  let colorlist = colors.sort(() => (Math.random() > 0.5 ? 1 : -1));

  for (let i = 0; i < parseInt(req.body.users); i++) {
    let user = {
      id: makeRandomHash().substr(0, 3),
      project: id,
      color: { ...colorlist[i % colors.length] },
      ai: {
        offset: i,
      },
      reportFirst: {},
    };

    if (parseInt(req.body.users) > colors.length) {
      user.color.name =
        user.color.name + " " + (parseInt(i / colors.length) + 1);
    }

    if (parseFloat(req.body.ai) == 0) {
      user.ai.days = 32 + parseInt(req.body.users);
    } else {
      user.ai.days = req.body.dailyRegime ? 1 / parseFloat(req.body.ai) : 1;
    }

    user.reportFirst.offset = i + parseInt(user.ai.days / 2);
    if (parseFloat(req.body.reportFirst) == 0) {
      user.reportFirst.days = 32 + parseInt(req.body.users);
    } else {
      user.reportFirst.days = req.body.dailyRegime
        ? 1 / parseFloat(req.body.reportFirst)
        : 1;
    }

    while (fs.existsSync("./log/users/" + user.id)) {
      user.id = makeRandomHash().substr(0, 3);
    }
    fs.mkdirSync("./log/users/" + user.id);

    data["users"].push(user);
    fs.writeFileSync(
      "./log/users/" + user.id + "/settings.json",
      JSON.stringify(user)
    );
  }

  fs.writeFileSync(projectDir + "/settings.json", JSON.stringify(data));
  res.status(201).json(id);
});

app.get("/getImg/:user/:obsId", function (req, res) {
  console.log(user);

  const file = `./log/users/${user}/img/${obsId}_0.jpg`;
  res.sendFile(file);
});

app.post("/addUser", express.static("public"), async (req, res) => {
  const projectDir = "./log/projects/" + req.body.project;
  const jsonfile = projectDir + "/settings.json";
  const project = JSON.parse(fs.readFileSync(jsonfile, "utf8"));
  const i = project.users.length;

  const existingUser = project.users.find(
    (user) => user.customName.trim().toLowerCase() === req.body.username.trim().toLowerCase()
  );

  if (existingUser) {
    res.status(202).json(existingUser.id);
    return;
  }

  let user = {
    id: makeRandomHash().substr(0, 3),
    customName: req.body.username.trim(),
    project: project.id,
    color: { ...colors[i % colors.length] },
    ai: {
      offset: i,
    },
    reportFirst: {},
  };

  if (parseFloat(req.body.ai) == 0) {
    user.ai.days = -1;
  } else {
    user.ai.days = project.dailyRegime ? 1 / parseFloat(project.ai) : 1;
  }

  user.reportFirst.offset = i + parseInt(user.ai.days / 2);
  if (parseFloat(project.reportFirst) == 0) {
    user.reportFirst.days = -1;
  } else {
    user.reportFirst.days = project.dailyRegime
      ? 1 / parseFloat(project.reportFirst)
      : 1;
  }

  while (fs.existsSync("./log/users/" + user.id)) {
    user.id = makeRandomHash().substr(0, 3);
  }
  fs.mkdirSync("./log/users/" + user.id);

  project["users"].push(user);
  fs.writeFileSync(projectDir + "/settings.json", JSON.stringify(project));
  fs.writeFileSync(
    "./log/users/" + user.id + "/settings.json",
    JSON.stringify(user)
  );
  res.status(201).json(user.id);
});

app.post("/getObs", express.static("public"), async (req, res) => {
  const csvfile = "./log/projects/" + req.body.project + "/observations.csv";

  if (
    !fs.existsSync("./log/projects/" + req.body.project + "/observations.csv")
  ) {
    res.status(200).json([]);
    return;
  }

  let data = fs.readFileSync(csvfile, "utf8").split("\n");
  const headers = data.slice(0, 1)[0].split(",");
  data = data.slice(1);

  if (!data.slice(-1)[0]) {
    data = data.slice(0, -1);
  }

  let observations = [];

  for (let obs of data) {
    obs = obs.slice(1, -1).split('","');
    let obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = obs[i];
    }
    observations.push(obj);
  }

  res.status(200).json(observations);
});

app.post("/auth", express.static("public"), async (req, res) => {
  const user = req.body.user;
  if (!user || !isValidUser(user)) {
    res.status(401).json("Invalid user");
  } else {
    const jsonfile = "./log/users/" + user + "/settings.json";
    var obj = JSON.parse(fs.readFileSync(jsonfile, "utf8"));

    res.status(200).json(obj);
  }
});

app.post("/getProject", express.static("public"), async (req, res) => {
  const project = req.body.project;
  if (!project || !fs.existsSync("./log/projects/" + project)) {
    res.status(401).json("Invalid project");
  } else {
    const jsonfile = "./log/projects/" + project + "/settings.json";
    var obj = JSON.parse(fs.readFileSync(jsonfile, "utf8"));

    res.status(200).json(obj);
  }
});

app.post("/", upload.array("image"), async (req, res) => {
  const user = req.body.user;

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
    console.log(error);

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

  console.log("creating", imgdir);

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
      // "https://artsdatabanken.biodiversityanalysis.eu/v1/observation/identify/noall/auth",
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
