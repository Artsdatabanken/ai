const fs = require("fs");
const { idLimiter } = require("../middleware/rateLimiters");
const { authenticateApiToken } = require("../middleware/auth");
const { getId, simplifyJson } = require("../services/identification");
const { saveImagesAndGetToken } = require("../services/encryption");
const { writelog, writeErrorLog } = require("../services/logging");
const { getName, taxadir } = require("../services/taxon");

module.exports = (app, upload) => {
  app.post("/identify", idLimiter, authenticateApiToken, upload.array("image"), async (req, res) => {
    try {
      let json = await getId(req);

      const savedImages = await saveImagesAndGetToken(req);
      json.uploadId = savedImages.id;
      json.uploadSecret = savedImages.password;

      writelog(req, json, req.auth);

      if (req.body.application === undefined) {
        json = simplifyJson(json);
      }

      res.status(200).json(json);

      if (json?.predictions?.[0]?.taxa) {
        json.predictions[0].taxa.items.forEach((taxon) => {
          if (Math.random() < 0.05) {
            let filename = `${taxadir}/${encodeURIComponent(
              taxon.scientific_name
            )}.json`;
            if (fs.existsSync(filename)) {
              fs.stat(filename, function (err, stats) {
                if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                  let splitId = taxon.scientific_name_id.split(":");
                  let sciNameId = splitId[0] === "NBIC" ? splitId[1] : null;
                  getName(sciNameId, taxon.scientific_name, true);
                }
              });
            }
          }
        });
      }
    } catch (error) {
      writeErrorLog(`Error while running getId() on /identify endpoint`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/", idLimiter, upload.array("image"), async (req, res) => {
    try {
      let json = await getId(req);

      writelog(req, json);

      if (req.body.application === undefined) {
        json = simplifyJson(json);
        json.predictions = [{}].concat(json.predictions);
      }

      json.predictions[0].probability = 1;
      json.predictions[0].taxon = {
        vernacularName: "*** Utdatert versjon ***",
        name:
          "Vennligst oppdater Artsorakelet via app store, eller Ctrl-Shift-R på pc",
      };

      res.status(200).json(json);

      if (json.predictions[0].taxa) {
        json.predictions[0].taxa.items.forEach((taxon) => {
          if (Math.random() < 0.05) {
            let filename = `${taxadir}/${encodeURIComponent(
              taxon.scientific_name
            )}.json`;
            if (fs.existsSync(filename)) {
              fs.stat(filename, function (err, stats) {
                if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                  let splitId = taxon.scientific_name_id.split(":");
                  let sciNameId = splitId[0] === "NBIC" ? splitId[1] : null;
                  getName(sciNameId, taxon.scientific_name, true);
                }
              });
            }
          }
        });
      }
    } catch (error) {
      writeErrorLog(`Error while running getId()`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
