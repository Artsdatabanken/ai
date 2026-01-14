const axios = require("axios");
const FormData = require("form-data");
const stream = require("stream");
const { server_url } = require("../config/constants");
const { writeErrorLog } = require("./logging");
const { getName, getPicture } = require("./taxon");
const { getCountryFromCoordinatesOrIP } = require("./geolocation");
const { getWarnings } = require("./warnings");

const simplifyJson = (json) => {
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

const getId = async (req) => {
  try {
    const form = new FormData();
    const formHeaders = form.getHeaders();
    const receivedParams = Object.keys(req.body);

    receivedParams.forEach((key, index) => {
      form.append(key, req.body[key]);
    });

    for (const file of req.files) {
      var bufferStream = new stream.PassThrough();
      bufferStream.end(file.buffer);
      form.append("image", bufferStream, {
        filename: "" + Date.now() + "." + file.mimetype.split("image/").pop(),
      });
    }

    const geoResult = getCountryFromCoordinatesOrIP(
      req.body.latitude,
      req.body.longitude,
      req
    );
    const country = geoResult.country;
    const detectedIP = geoResult.detectedIP;

    let locationSource = 'unknown';
    if (req.body.latitude && req.body.longitude) {
      locationSource = 'coordinates';
    } else if (country !== 'Unknown') {
      locationSource = 'ip';
    }

    let token;
    let modelUsed;

    let username = process.env.NATURALIS_USERNAME_NORWAY
    let password = process.env.NATURALIS_PASSWORD_NORWAY


    if (receivedParams.includes('model') && req.body.model && req.body.model.toLowerCase() === "global") {
      token = process.env.NATURALIS_TOKEN_EUROPE;
      modelUsed = 'European';
    } else if (country === 'SE') {
      username = process.env.NATURALIS_USERNAME_SWEDEN
      password = process.env.NATURALIS_PASSWORD_SWEDEN
      token = process.env.NATURALIS_TOKEN_SWEDEN;
      modelUsed = 'Swedish';
    } else if (country === 'NO' || country === 'Unknown') {
      token = process.env.NATURALIS_TOKEN_NORWAY;
      modelUsed = 'Norwegian';
    } else {
      token = process.env.NATURALIS_TOKEN_EUROPE;
      modelUsed = 'European';
    }

    let recognition;

    recognition = await axios
      .post(
        `https://multi-source.identify.biodiversityanalysis.eu/v2/observation/identify/token/${token}`,
        form,
        {
          headers: {
            ...formHeaders,
            'User-Agent': 'Artsorakel backend bot/4.0 (https://www.artsdatabanken.no) axios/0.21.1'
          },
          auth: {
            username: username,
            password: password,
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

    if (
      !recognition.data.predictions[0].taxa ||
      !recognition.data.predictions[0].taxa.items
    ) {
      throw `Naturalis API v2 lookup gave no predictions.\n${JSON.stringify(
        recognition.data
      )}`;
    }

    let taxa = recognition.data.predictions[0].taxa.items;

    taxa = taxa.slice(0, 5);
    let filteredTaxa = taxa.filter((taxon) => taxon.probability >= 0.02);

    if (filteredTaxa.length) {
      taxa = filteredTaxa;
    } else {
      taxa = taxa.slice(0, 2);
    }

    for (let pred of taxa) {

      try {
        let nameResult;

        if (
          req.body.application &&
          req.body.application.toLowerCase() === "artsobservasjoner"
        ) {
          pred.name = pred.scientific_name;
        } else {

          let splitId = pred.scientific_name_id.split(":")
          let sciNameId = (splitId[0] === "NBIC" ? splitId[1] : null)

          nameResult = await getName(sciNameId, pred.scientific_name, false, country);

          pred.vernacularName = nameResult.vernacularName
          pred.vernacularNames = nameResult.vernacularNames
          pred.groupName = nameResult.groupName
          pred.groupNames = nameResult.groupNames
          pred.scientificName = nameResult.scientificName

          if (Object.keys(nameResult.redListCategories).length > 0) {
            pred.redListCategories = nameResult.redListCategories
            if (nameResult?.redListCategories?.NO) {
              pred.redListCategory = nameResult.redListCategories.NO
            }
          }

          if (Object.keys(nameResult.invasiveCategories).length > 0) {
            pred.invasiveCategories = nameResult.invasiveCategories
            if (nameResult?.invasiveCategories?.NO) {
              pred.invasiveCategory = nameResult.invasiveCategories.NO
            }
          }

          pred.infoUrl = nameResult.infoUrl
          pred.name = pred.scientificName;
        }

        pred.picture = getPicture(pred.scientificName);
      } catch (error) {
        writeErrorLog(
          `Error while processing getName(${pred.sciNameId
          }, ${pred.scientific_name
          }). You can force a recache on ${encodeURI(
            server_url + "/admin/taxon/reload/id/" +
            pred.sciNameId
          )} or ${encodeURI(
            server_url + "/admin/taxon/reload/name/" +
            pred.scientific_name
          )}.`,
          error
        );
      }
    }

    recognition.data.predictions[0].taxa.items = taxa;

    recognition.data.application = req.body.application;

    recognition.data.modelInfo = {
      model: modelUsed,
      country: country || 'Unknown',
      locationSource: locationSource
    };

    const metadata = {
      country: country,
      lat: req.body.latitude ? parseFloat(req.body.latitude) : undefined,
      lon: req.body.longitude ? parseFloat(req.body.longitude) : undefined,
      date: req.body.date || new Date().toISOString()
    };

    const warnings = getWarnings(recognition.data.predictions[0].taxa.items, metadata);

    if (warnings.general.length > 0 || Object.keys(warnings.predictions).length > 0) {
      recognition.data.warnings = warnings;
    }

    return recognition.data;
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getId,
  simplifyJson
};
