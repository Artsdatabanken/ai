/**
 * @fileoverview Main server file for the AI-powered species identification API.
 * This API provides endpoints for image-based species identification, taxon information retrieval,
 * and various utility functions related to species data management.
 * 
 * @requires axios
 * @requires form-data
 * @requires fs
 * @requires express
 * @requires body-parser
 * @requires multer
 * @requires cors
 * @requires dotenv
 * @requires ./resources/taxonMapping
 * @requires node-cron
 * @requires express-rate-limit
 * @requires sanitize-filename
 */

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const taxonMapper = require("./resources/taxonMapping");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const sanitize = require("sanitize-filename");

/**
 * Rate limiter for cache-related requests.
 * @type {Function}
 */

const cacheLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 30, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many cache requests`,
      `IP ${request.client._peername.address}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const idLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // Timeframe
  max: 9999, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many ID requests`,
      `IP ${request.client._peername.address}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 30, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many misc API requests`,
      `IP ${request.client._peername.address}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

// Use the crypto library for encryption and decryption
const crypto = require("crypto");
const encryption_algorithm = "aes-256-ctr";
// Generate a secure, pseudo random initialization vector for encryption
const initVect = crypto.randomBytes(16);

let appInsights = require("applicationinsights");
const { off } = require("process");
const { type } = require("os");

// --- Reading env variables
dotenv.config({ path: "./config/config.env" });
dotenv.config({ path: "./config/secrets.env" });

// --- Setting files and locations
const logdir = "./log";
const taxadir = "./resources/taxoncache";
const resourcesdir = "./resources";

const pictureFile = `${resourcesdir}/taxonPictures.json`;
const alertsFile = `${resourcesdir}/taxonAlerts.json`;
const uploadsdir = "./uploads";

// --- Get the taxon picture ids from file on start
var taxonPics = {};
if (fs.existsSync(pictureFile)) {
  taxonPics = JSON.parse(fs.readFileSync(pictureFile));
}

// --- Get the taxon alerts from file on start
var taxonAlerts = {};
if (fs.existsSync(alertsFile)) {
  taxonAlerts = JSON.parse(fs.readFileSync(alertsFile));
}

// --- Getting the date as a nice Norwegian-time string no matter where the server runs
const dateStr = (resolution = `d`, date = false) => {
  if (!date) {
    date = new Date();
  }

  let dateStr = date.toLocaleString("lt", { timeZone: "Europe/Oslo" });

  if (resolution === `d`) {
    return dateStr.split(" ")[0];
  }

  return dateStr;
};

const writeErrorLog = (message, error) => {
  if (!!error) {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr(`d`)}.txt`,
      `\n${dateStr(`s`)}: ${message}\n   ${error}\n`
    );
  } else {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr(`d`)}.txt`,
      `${dateStr(`s`)}: ${message}\n`
    );
  }
};

// --- Make sure the resources directory exists
if (!fs.existsSync(resourcesdir)) {
  fs.mkdirSync(resourcesdir);
}

// --- Make sure the log directory exists
if (!fs.existsSync(logdir)) {
  fs.mkdirSync(logdir);
}

// --- Make sure the upload directory exists
if (!fs.existsSync(uploadsdir)) {
  fs.mkdirSync(uploadsdir);
}

// --- Make sure the taxon cache directory exists
if (!fs.existsSync(taxadir)) {
  fs.mkdirSync(taxadir);
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

/**
 * Retrieves a picture URL for a given scientific name.
 * @param {string} sciName - The scientific name of the species.
 * @returns {string|null} The URL of the picture, or null if not found.
 */
let getPicture = (sciName) => {
  // Special characters do not work in all cases
  sciName = sciName.replaceAll("×", "x").replaceAll("ë", "e");

  let pic = taxonPics[sciName];
  if (pic) {
    return `https://artsdatabanken.no/Media/${pic}?mode=128x128`;
  }

  return null;
};

let writelog = (req, json) => {
  let application;
  if (req.body.application) {
    application = sanitize(req.body.application);
  }

  if (!fs.existsSync(`${logdir}/${application}_${dateStr(`d`)}.csv`)) {
    fs.appendFileSync(
      `${logdir}/${application}_${dateStr(`d`)}.csv`,
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

  let row = `${dateStr(`s`)},${
    Array.isArray(req.files) ? req.files.length : 0
  }`;

  for (let i = 0; i < json.predictions[0].taxa.items.length; i++) {
    const prediction = json.predictions[0].taxa.items[i];
    row += `,"${prediction.name}","${prediction.groupName}",${prediction.probability}`;
  }

  row += "\n";

  fs.appendFileSync(`${logdir}/${application}_${dateStr(`d`)}.csv`, row);
};

let getName = async (sciName, force = false) => {
  let unencoded_jsonfilename = `${taxadir}/${sanitize(sciName)}.json`;
  let jsonfilename = `${taxadir}/${encodeURIComponent(sciName)}.json`;

  if (
    fs.existsSync(unencoded_jsonfilename) &&
    unencoded_jsonfilename !== jsonfilename
  ) {
    fs.unlink(unencoded_jsonfilename, function (error) {
      if (error)
        writeErrorLog(
          `Could not delete "${unencoded_jsonfilename}" while updating old filename`,
          error
        );
    });
  }

  // --- Return the cached json if it exists, and it parses, and no recache is forced. In all other cases, try to delete that cache.
  if (fs.existsSync(jsonfilename)) {
    if (!force) {
      try {
        return JSON.parse(fs.readFileSync(jsonfilename));
      } catch (error) {
        writeErrorLog(`Could not parse "${jsonfilename}"`, error);

        fs.unlink(jsonfilename, function (error) {
          if (error)
            writeErrorLog(
              `Could not delete "${jsonfilename}" after JSON parse failed`,
              error
            );
        });
      }
    } else {
      fs.unlink(jsonfilename, function (error) {
        if (error)
          writeErrorLog(
            `Could not delete "${jsonfilename}" while forcing recache`,
            error
          );
      });
    }
  }

  let nameResult = {
    vernacularName: sciName,
    groupName: "",
    scientificName: sciName,
  };
  let name;

  let retrievedTaxon = { data: [] };

  try {
    let url = encodeURI(
      `https://artsdatabanken.no/api/Resource/?Take=10&Type=taxon&Name=${sciName}`
    );
    let taxon = await axios
      .get(url, {
        timeout: 3000,
      })
      .catch((error) => {
        writeErrorLog(
          `Failed to ${
            !force ? "get info for" : "*recache*"
          } ${sciName} from ${url}.`,
          error
        );
        throw "";
      });

    let acceptedtaxon = taxon.data.find(
      (t) => t.Name.includes(sciName) && t.AcceptedNameUsage
    );

    if (!!acceptedtaxon) {
      retrievedTaxon.data = acceptedtaxon;
    } else {
      let hit = taxon.data.find((t) =>
        t.ScientificNames.find((sn) =>
          sn.HigherClassification.find((h) => h.ScientificName === sciName)
        )
      );
      if (!hit) throw "No HigherClassification hit";
      hit = hit.ScientificNames.find((sn) =>
        sn.HigherClassification.find((h) => h.ScientificName === sciName)
      );
      hit = hit.HigherClassification.find((h) => h.ScientificName === sciName);
      hit = hit.ScientificNameId;
      url = `https://artsdatabanken.no/api/Resource/ScientificName/${hit}`;
      taxon = await axios
        .get(url, {
          timeout: 3000,
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${
              !force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });

      url = `https://artsdatabanken.no/api/Resource/Taxon/${taxon.data.Taxon.TaxonId}`;
      taxon = await axios
        .get(url, {
          timeout: 3000,
        })
        .catch((error) => {
          writeErrorLog(
            `Failed to ${
              !force ? "get info for" : "*recache*"
            } ${sciName} from ${url}.`,
            error
          );
          throw "";
        });

      retrievedTaxon.data = taxon.data;
    }

    nameResult.scientificName =
      retrievedTaxon.data.AcceptedNameUsage.ScientificName;
    nameResult.scientificNameID =
      retrievedTaxon.data.AcceptedNameUsage.ScientificNameId;

    nameResult.vernacularName =
      retrievedTaxon.data["RecommendedVernacularName_nb-NO"] ||
      retrievedTaxon.data["RecommendedVernacularName_nn-NO"] ||
      nameResult.scientificName ||
      sciName;

    if (retrievedTaxon.data.Description) {
      const description =
        retrievedTaxon.data.Description.find(
          (desc) =>
            desc.Language == "nb" ||
            desc.Language == "no" ||
            desc.Language == "nn"
        ) || retrievedTaxon.data.Description[0];

      nameResult.infoUrl = description.Id.replace(
        "Nodes/",
        "https://artsdatabanken.no/Pages/"
      );
    } else {
      nameResult.infoUrl =
        "https://artsdatabanken.no/" + retrievedTaxon.data.Id;
    }

    url = encodeURI(`https://artsdatabanken.no/Api/${retrievedTaxon.data.Id}`);
    name = await axios
      .get(url, {
        timeout: 3000,
      })
      .catch((error) => {
        writeErrorLog(
          `Failed to ${
            !force ? "get info for" : "*recache*"
          } ${sciName} from ${url}.`,
          error
        );
        throw "";
      });
  } catch (error) {
    writeErrorLog(
      `Error in getName(${sciName}). Retry: ${encodeURI(
        "https://ai.test.artsdatabanken.no/cachetaxon/" + sciName
      )}.`,
      error
    );
    return nameResult;
  }

  if (name && name.data.AcceptedName.dynamicProperties) {
    let artsobsname = name.data.AcceptedName.dynamicProperties.find(
      (dp) =>
        dp.Name === "GruppeNavn" &&
        dp.Properties.find((p) => p.Value === "Artsobservasjoner")
    );

    if (artsobsname && artsobsname.Value) {
      nameResult.groupName = artsobsname.Value;
    }
  }

  if (force || !fs.existsSync(jsonfilename)) {
    let data = JSON.stringify(nameResult);
    fs.writeFileSync(jsonfilename, data);
  }

  return nameResult;
};

// Check if there are old files to be deleted every X minute:
cron.schedule("30 * * * *", () => {
  //console.log('Running cleanup every 30th minute');

  // Loop over all files in uploads/
  fs.readdir(`${uploadsdir}/`, (err, files) => {
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
          fs.unlink(`${uploadsdir}/${file}`, (err) => {
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
    fs.writeFile(`${uploadsdir}/${filename}`, encrypted_file, (error) => {
      if (error) {
        writeErrorLog(
          `Failed to write file "${uploadsdir}/${filename}".`,
          error
        );
      }
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
    let url = encodeURI(`https://www.artsdatabanken.no/api/Content/${pageId}`);
    let page = await axios
      .get(url, {
        timeout: 10000,
      })
      .catch((error) => {
        writeErrorLog(
          `Error getting "${url}" while running refreshtaxonimages`,
          error
        );
        throw "";
      });

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

  taxonPics = taxa;
  fs.writeFileSync(pictureFile, JSON.stringify(taxa));
  return Object.keys(taxa).length;
};

let retrieveRecognition = async (req, token) => {
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

  return axios
    .post(
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
    )
    .catch((error) => {
      writeErrorLog(
        `Naturalis API v2 lookup with token ${token} failed`,
        error
      );
      throw "";
    });
};

let augmentRecognition = async (req, recognition) => {
  if (
    !recognition.data.predictions[0].taxa ||
    !recognition.data.predictions[0].taxa.items
  ) {
    throw `Naturalis API v2 lookup gave no predictions.\n${JSON.stringify(
      recognition.data
    )}`;
  }

  let taxa = recognition.data.predictions[0].taxa.items;

  // get the best 5
  taxa = taxa.slice(0, 5);
  filteredTaxa = taxa.filter((taxon) => taxon.probability >= 0.02);

  if (filteredTaxa.length) {
    taxa = filteredTaxa;
  } else {
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
      if (
        req.body.application &&
        req.body.application.toLowerCase() === "artsobservasjoner"
      ) {
        pred.name = pred.scientific_name;
      } else {
        nameResult = await getName(pred.scientific_name);

        pred.vernacularName = nameResult.vernacularName;
        pred.groupName = nameResult.groupName;
        pred.scientificNameID = nameResult.scientificNameID;
        pred.name = nameResult.scientificName;
        pred.infoUrl = nameResult.infoUrl;
      }

      pred.picture = getPicture(pred.scientific_name);
    } catch (error) {
      writeErrorLog(
        `Error while processing getName(${
          pred.scientific_name
        }). You can force a recache on ${encodeURI(
          "https://ai.test.artsdatabanken.no/cachetaxon/" + pred.scientific_name
        )}.`,
        error
      );
    }
  }

  recognition.data.predictions[0].taxa.items = taxa;

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

  return recognition.data;
};

let getAlerts = (recognition) => {
  let taxa = recognition.data.predictions[0].taxa.items.filter(
    (prediction) => prediction.probability > 0.02
  );


  taxa = taxa.filter((taxon) => {
    return taxonAlerts["Pest species"].includes(taxon.scientific_name);
  });

  taxa = taxa.map((taxon) => {
    taxon.alert = {
      type: "pest",
      message:
        "Pest species in Norway, mandatory reporting to the Norwegian Food Safety Authority",
    };
    return taxon;
  });

  return taxa;
};

let getId = async (req) => {
  const receivedParams = Object.keys(req.body);

  try {
    let tokens = [];
    if (
      !receivedParams.model ||
      !receivedParams.model.toLowerCase() === "global"
    ) {
      tokens.push(process.env.SP_TOKEN); // Norwegian token
    }

    tokens.push(process.env.SH_TOKEN); // Shared token

    let promises = [];

    tokens.forEach((token) => {
      promises.push(retrieveRecognition(req, token));
    });

    const results = await Promise.all(promises);



    let recognition = await augmentRecognition(req, results[0]);
    recognition.application = req.body.application;


    recognition.alerts = getAlerts(results[results.length - 1]);

    return recognition;
  } catch (error) {
    writeErrorLog(`Error while running getId()`, error);
    throw error;
  }
};

app.get("/taxonimage/*", apiLimiter, (req, res) => {
  try {
    let taxon = decodeURI(req.originalUrl.replace("/taxonimage/", ""));
    res.status(200).send(getPicture(taxon));
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/taxonimages", apiLimiter, (req, res) => {
  try {
    res.status(200).json(taxonPics);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/taxonimages/view", apiLimiter, (req, res) => {
  try {
    let pics = Object.entries(taxonPics);
    pics.sort();

    let html = "<html><head><style>";
    html += "img {border-radius: 50%}";
    html += "img:hover {border-radius: 0}";
    html += "</style></head><body>";
    html += `<h1>Alle ${pics.length} "profilbilder"</h1>`;
    html += "<table>";

    pics.forEach((pic) => {
      html += `<tr><td style="padding: 20px"><a href="https://artsdatabanken.no/Media/${pic[1]}" target="_blank"><img src="https://artsdatabanken.no/Media/${pic[1]}?mode=128x128"/></a></td>`;
      html += `<td><h3><i>${pic[0]}</i></h3></td></tr>`;
    });
    html += "</body></html>";

    res.status(200).send(html);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/cachetaxon/*", cacheLimiter, async (req, res) => {
  try {
    let taxon = decodeURI(req.originalUrl.replace("/cachetaxon/", ""));
    let name = await getName(taxon, (force = true));
    res.status(200).json(name);
  } catch (error) {
    writeErrorLog(`Error for ${req.originalUrl}`, error);
    res.status(500).end();
  }
});

app.get("/refreshtaxonimages", cacheLimiter, async (req, res) => {
  try {
    // Read the file first in case the fetches fail, so it can still be uploaded manually
    if (fs.existsSync(pictureFile)) {
      taxonPics = JSON.parse(fs.readFileSync(pictureFile));
    }

    let number = await refreshtaxonimages();
    res.status(200).send(`${number} pictures found`);
  } catch (error) {
    res.status(500).end();
  }
});

/**
 * @api {post} / Identify species from image
 * @apiName IdentifySpecies
 * @apiGroup Identification
 * 
 * @apiDescription Identifies species from uploaded images using AI.
 * 
 * @apiParam {File} image Image file(s) to be analyzed.
 * @apiParam {String} [application] Name of the application making the request.
 * 
 * @apiSuccess {Object} json Identification results including predictions and taxa information.
 * 
 * @apiError (500) {String} InternalServerError An error occurred during processing.
 */
app.post("/", idLimiter, upload.array("image"), async (req, res) => {
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
      json = simplifyJson(json);
      json.predictions = [{}].concat(json.predictions);
    }

    json.predictions[0].probability = 1;
    json.predictions[0].taxon = {
      vernacularName: "*** Utdatert versjon ***",
      name: "Vennligst oppdater Artsorakelet via app store, eller Ctrl-Shift-R på pc",
    };

    res.status(200).json(json);

    // --- Now that the reply has been sent, let each returned name have a 5% chance to be recached if its file is older than 10 days
    if (json.predictions[0].taxa) {
      json.predictions[0].taxa.items.forEach((taxon) => {
        if (Math.random() < 0.05) {
          let filename = `${taxadir}/${encodeURIComponent(
            taxon.scientific_name
          )}.json`;
          if (fs.existsSync(filename)) {
            fs.stat(filename, function (err, stats) {
              if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                getName(taxon.scientific_name, (force = true));
              }
            });
          }
        }
      });
    }
  } catch (error) {
    writeErrorLog(`Error while running getId()`, error);
    res.status(500).end();
  }
});

app.post("/save", apiLimiter, upload.array("image"), async (req, res) => {
  // image saving request from the orakel service
  try {
    json = await saveImagesAndGetToken(req);
    res.status(200).json(json);
  } catch (error) {
    writeErrorLog(`Failed to save image(s)`, error);
  }
});

app.get("/", apiLimiter, (req, res) => {
  let v = "Gitless";
  const gitfile = ".git/FETCH_HEAD";
  if (fs.existsSync(gitfile)) {
    v = fs.readFileSync(gitfile).toString().split("\t")[0];
  }

  fs.stat("./server.js", function (err, stats) {
    res
      .status(200)
      .send(`<h3>Aiaiai!</h3><hr/> ${v}<br/>${dateStr("s", stats.mtime)}`);
  });
});

app.get("/image/*", apiLimiter, (req, res) => {
  // image request from the orakel service
  // On the form /image/id&password

  // Url used to arrive here from outside
  let url = req.originalUrl.replace("/image/", "");

  // Obtain password from the end of the url
  let password = url.split("&")[1].toString();

  // Obtain the image id's from the url
  url = url.split("&")[0];

  // Loop over all files in uploads/
  fs.readdir(`${uploadsdir}/`, (err, files) => {
    let image_list = [];

    files.forEach((file) => {
      // The id's in upload are of the format:
      // sessionid_number_timestamp this to ensure unique id's
      // to get all entries from one session, we use only the first of these
      const fileid = file.split("_")[0];

      if (fileid === url) {
        // If the request has a match in the database (it should unless the user was too slow)
        const image_to_fetch = `${uploadsdir}/${file}`;

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
      writeErrorLog(
        `Failed to return json of saved images:\n${filelist.toString()}`,
        error
      );
      res.status(500).end();
    }
  });
});

app.get("/loglist/*", cacheLimiter, (req, res) => {
  const token = process.env.SP_TOKEN;
  let requestToken = req.originalUrl.replace("/loglist/", "");
  if (requestToken !== token) {
    res.status(403).send(`Nope`);
  } else {
    var json = [];
    fs.readdir("./log", function (err, files) {
      files.forEach(function (file, index) {
        json.push(file);
      });
      res.status(200).json(json);
    });
  }
});

app.get("/getlog/*", idLimiter, (req, res) => {
  const token = process.env.SP_TOKEN;
  let [requestToken, filename] = req.originalUrl
    .replace("/getlog/", "")
    .split("/");

  if (requestToken !== token) {
    res.status(403).end();
  } else {
    const file = `./log/${decodeURI(filename)}`;
    if (fs.existsSync(file)) {
      res.download(file);
    } else {
      res.status(404).end();
    }
  }
});

// --- Path that Azure uses to check health, prevents 404 in the logs
app.get("/robots933456.txt", apiLimiter, (req, res) => {
  res.status(200).send("Hi, Azure");
});

// --- Serve a favicon, prevents 404 in the logs
app.use("/favicon.ico", apiLimiter, express.static("favicon.ico"));

app.listen(port, console.log(`Server now running on port ${port}`));
