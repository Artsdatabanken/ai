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
            let splitId = taxon.scientific_name_id.split(":");
            let sciNameId = splitId[0] === "NBIC" ? splitId[1] : null;

            let pattern;
            if (sciNameId) {
              pattern = `${encodeURIComponent(sciNameId)}_`;
            } else {
              pattern = `_${taxon.scientific_name}`;
            }

            try {
              const files = fs.readdirSync(taxadir).filter(f => f.startsWith(pattern) && f.endsWith('.json'));
              if (files.length > 0) {
                const filepath = `${taxadir}/${files[0]}`;
                const stats = fs.statSync(filepath);
                if ((new Date() - stats.mtime) / (1000 * 60 * 60 * 24) > 10) {
                  getName(sciNameId, taxon.scientific_name, true).catch((e) => {
                    writeErrorLog(`Background recache failed for ${taxon.scientific_name}`, e);
                  });
                }
              }
            } catch {}
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
        name: "Vennligst oppdater Artsorakel via app store, eller Ctrl-Shift-R på pc",
      };

      res.status(200).json(json);
    } catch (error) {
      writeErrorLog(`Error while running getId()`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
