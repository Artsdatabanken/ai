const { apiLimiter, authLimiter } = require("../middleware/rateLimiters");
const { authenticateAdminToken } = require("../middleware/auth");
const { writeErrorLog } = require("../services/logging");
const {
  getName,
  getPicture,
  getTaxonPics,
  reloadTaxonImages,
  reloadTaxonPics
} = require("../services/taxon");

module.exports = (app) => {
  app.get("/taxon/image/*", apiLimiter, (req, res) => {
    try {
      let taxon = decodeURI(req.originalUrl.replace("/taxon/image/", ""));
      res.status(200).send(getPicture(taxon));
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/taxon/images", apiLimiter, (req, res) => {
    try {
      res.status(200).json(getTaxonPics());
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/taxon/images/view", apiLimiter, (req, res) => {
    try {
      const taxonPics = getTaxonPics();
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
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/admin/taxon/reload/name/*", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      let taxonName = decodeURI(req.originalUrl.replace("/admin/taxon/reload/name/", ""));
      let name = await getName(null, taxonName, true);
      res.status(200).json(name);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/admin/taxon/reload/id/*", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      let taxonId = decodeURI(req.originalUrl.replace("/admin/taxon/reload/id/", ""));
      let name = await getName(taxonId, "", true);
      res.status(200).json(name);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/admin/taxon/reload/images", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      reloadTaxonPics();

      let number = await reloadTaxonImages();
      res.status(200).send(`${number} pictures found`);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
