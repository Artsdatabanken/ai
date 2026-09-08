const { idLimiter } = require("../middleware/rateLimiters");
const { authenticateApiToken, verifyAllowedOrigin } = require("../middleware/auth");
const { verifyRequestSignature } = require("../middleware/signature");
const { getId, simplifyJson } = require("../services/identification");
const { saveImagesAndGetToken } = require("../services/encryption");
const { writelog, writeErrorLog, writeRejectionLog, requestOrigin } = require("../services/logging");
const { maybeRecache } = require("../services/taxon");

const LEGACY_ORIGIN = "https://orakel.artsdatabanken.no";
const LEGACY_APPLICATION = "legacy-root";

const allowLegacyOrigin = (req, res, next) => {
  const origin = requestOrigin(req);

  if (origin === LEGACY_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    req.auth = { type: "legacy", name: "Legacy root", application: LEGACY_APPLICATION };
    return next();
  }

  writeErrorLog(
    "Request rejected: root identification is only available to the legacy interface",
    `IP ${req.ip}, origin ${origin || "(none sent)"}`
  );
  writeRejectionLog(req, null, "root identification, origin not allowed");

  return res.status(410).json({ error: "410 Gone" });
};

const identify = async (req, res) => {
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
    writeErrorLog(`Error while running getId() on ${req.path} endpoint`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
};

module.exports = (app, upload) => {
  app.post("/identify", idLimiter, authenticateApiToken, verifyAllowedOrigin, upload.array("image"), verifyRequestSignature, identify);

  app.post("/", idLimiter, allowLegacyOrigin, upload.array("image"), identify);
};
