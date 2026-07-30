const { idLimiter } = require("../middleware/rateLimiters");
const { authenticateApiToken, verifyAllowedOrigin } = require("../middleware/auth");
const { verifyRequestSignature } = require("../middleware/signature");
const { getId, simplifyJson } = require("../services/identification");
const { saveImagesAndGetToken } = require("../services/encryption");
const { writelog, writeErrorLog } = require("../services/logging");
const { maybeRecache } = require("../services/taxon");

module.exports = (app, upload) => {
  app.post("/identify", idLimiter, authenticateApiToken, verifyAllowedOrigin, upload.array("image"), verifyRequestSignature, async (req, res) => {
    try {
      let json = await getId(req);

      const savedImages = await saveImagesAndGetToken(req);
      json.uploadId = savedImages.id;
      json.uploadSecret = savedImages.password;

      writelog(req, json, req.auth);

      if (req.body.application === undefined) {
        res.status(200).json(simplifyJson({...json}));
      } else {
        res.status(200).json(json);
      }

      if (json?.predictions?.[0]?.taxa) {
        json.predictions[0].taxa.items.forEach((taxon) => {
          const splitId = String(taxon.scientific_name_id || "").split(":");
          const sciNameId = splitId[0] === "NBIC" ? splitId[1] : null;

          maybeRecache(sciNameId, taxon.scientific_name).catch((e) => {
            writeErrorLog(`Background recache failed for ${taxon.scientific_name}`, e);
          });
        });
      }
    } catch (error) {
      writeErrorLog(`Error while running getId() on /identify endpoint`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.post("/", idLimiter, upload.array("image"), async (req, res) => {
    try {
      let json = await getId(req);

      writelog(req, json);

      let responseJson;
      if (req.body.application === undefined) {
        responseJson = simplifyJson({...json});
        responseJson.predictions = [{}].concat(responseJson.predictions);
      } else {
        responseJson = {...json};
      }

      responseJson.predictions[0].probability = 1;
      responseJson.predictions[0].taxon = {
        vernacularName: "*** Utdatert versjon ***",
        name: "Vennligst oppdater Artsorakel via app store, eller Ctrl-Shift-R på pc",
      };

      res.status(200).json(responseJson);
    } catch (error) {
      writeErrorLog(`Error while running getId()`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
