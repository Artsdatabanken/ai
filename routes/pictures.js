const fs = require("fs");
const path = require("path");
const { adminLimiter, pictureLimiter } = require("../middleware/rateLimiters");
const { authenticateAdminToken, authenticateAdminQueryToken } = require("../middleware/auth");
const { writeErrorLog, writeAdminLog } = require("../services/logging");
const {
  PICTURE_SIZES,
  REQUIRED_SIZES,
  INAT_LICENSES,
  normalizeName,
  pictureFilePath,
  getPicture,
  describePicture,
  savePicture,
  removePicture,
  fetchWebsitePictureList,
  findInatPhotos,
  fetchPhoto
} = require("../services/pictures");

const resource = (file) => path.resolve(__dirname, "../resources", file);

const sendError = (res, req, error, fallback) => {
  if (error?.status && error.status < 500) {
    return res.status(error.status).json({ error: error.message });
  }
  writeErrorLog(`Error for ${req.method} ${req.path}`, error);
  res.status(error?.status || 500).json({ error: fallback });
};

const sendAdminPage = (file) => (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.sendFile(resource(file));
};

module.exports = (app, upload) => {
  app.get("/taxon/picture/:id/:file", pictureLimiter, (req, res) => {
    const match = /^(\d+)\.jpg$/.exec(req.params.file);
    const filePath = match && pictureFilePath(req.params.id, Number(match[1]));

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Not found" });
    }

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  });

  app.get("/admin/pictures", adminLimiter, authenticateAdminQueryToken, sendAdminPage("pictureAdmin.html"));
  app.get("/admin/pictures/import", adminLimiter, authenticateAdminQueryToken, sendAdminPage("pictureImport.html"));

  app.get("/admin/pictures/tools.js", adminLimiter, (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(resource("pictureTools.js"));
  });

  app.get("/admin/pictures/config", adminLimiter, authenticateAdminToken, (req, res) => {
    res.status(200).json({ sizes: PICTURE_SIZES, requiredSizes: REQUIRED_SIZES, licenses: INAT_LICENSES });
  });

  app.post("/admin/pictures/lookup", adminLimiter, authenticateAdminToken, (req, res) => {
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    if (names.length > 2000) {
      return res.status(400).json({ error: "At most 2000 names at a time" });
    }

    const seen = new Set();
    const results = [];

    for (const raw of names) {
      const name = normalizeName(raw);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      results.push({ name, picture: describePicture(getPicture(name)) });
    }

    res.status(200).json({ results });
  });

  app.get("/admin/pictures/import/list", adminLimiter, authenticateAdminToken, async (req, res) => {
    try {
      res.status(200).json({ items: await fetchWebsitePictureList() });
    } catch (error) {
      sendError(res, req, error, "Could not read the picture list from artsdatabanken.no");
    }
  });

  app.get("/admin/pictures/inat", adminLimiter, authenticateAdminToken, async (req, res) => {
    try {
      const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 100);
      const taxonId = /^\d+$/.test(String(req.query.taxonId || "")) ? Number(req.query.taxonId) : null;
      res.status(200).json(await findInatPhotos(req.query.name, String(req.query.license || ""), page, taxonId));
    } catch (error) {
      sendError(res, req, error, "Could not search iNaturalist");
    }
  });

  app.get("/admin/pictures/proxy", adminLimiter, authenticateAdminToken, async (req, res) => {
    try {
      const { contentType, buffer } = await fetchPhoto(req.query.url);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(buffer);
    } catch (error) {
      sendError(res, req, error, "Could not fetch that photo");
    }
  });

  app.post("/admin/pictures/save", adminLimiter, authenticateAdminToken, upload.any(), async (req, res) => {
    try {
      let meta = {};
      try {
        meta = req.body?.meta ? JSON.parse(req.body.meta) : {};
      } catch {
        return res.status(400).json({ error: "meta is not valid JSON" });
      }

      const result = await savePicture(req.body?.name, req.files || [], meta);
      if (!result.skipped) {
        const source = result.picture.source;
        writeAdminLog(
          "Taxon picture saved",
          `Name: ${result.name}, Id: ${result.picture.id}, Source: ${source.type}` +
            (source.url ? ` ${source.url}` : "") +
            `, Admin IP: ${req.ip}`
        );
      }
      res.status(200).json(result);
    } catch (error) {
      sendError(res, req, error, "Could not save the picture");
    }
  });

  app.post("/admin/pictures/remove", adminLimiter, authenticateAdminToken, async (req, res) => {
    try {
      const name = normalizeName(req.body?.name);
      const removed = await removePicture(name);
      if (removed) {
        writeAdminLog("Taxon picture removed", `Name: ${name}, Admin IP: ${req.ip}`);
      }
      res.status(200).json({ name, removed });
    } catch (error) {
      sendError(res, req, error, "Could not remove the picture");
    }
  });
};
