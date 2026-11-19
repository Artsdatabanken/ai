const { apiLimiter, authLimiter } = require("../middleware/rateLimiters");
const { authenticateAdminToken } = require("../middleware/auth");
const { writeErrorLog } = require("../services/logging");
const { getName, getPicture } = require("../services/taxon");
const { getPicture: getStoredPicture, getPictureNames, pictureUrl } = require("../services/pictures");
const {
  getDescriptionStub,
  getRandomAcceptedSpeciesId
} = require("../services/descriptionStub");

module.exports = (app) => {
  app.get("/taxon/image/*splat", apiLimiter, (req, res) => {
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
      res.status(200).json(
        Object.fromEntries(getPictureNames().map((name) => [name, getPicture(name)]))
      );
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/taxon/images/view", apiLimiter, (req, res) => {
    try {
      const escape = (value) =>
        String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const names = getPictureNames();

      let html = "<html><head><meta charset=\"utf-8\"><style>";
      html += "img {border-radius: 50%}";
      html += "img:hover {border-radius: 0}";
      html += "</style></head><body>";
      html += `<h1>Alle ${names.length} "profilbilder"</h1>`;
      html += "<table>";

      names.forEach((name) => {
        const picture = getStoredPicture(name);
        const largest = Math.max(...picture.sizes);
        html += `<tr><td style="padding: 20px"><a href="${escape(pictureUrl(picture.id, largest))}" target="_blank"><img src="${escape(pictureUrl(picture.id, 128))}" width="128" height="128" loading="lazy"/></a></td>`;
        html += `<td><h3><i>${escape(name)}</i></h3></td></tr>`;
      });
      html += "</table></body></html>";

      res.status(200).send(html);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/taxon/description/view", apiLimiter, (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8">
<title>Artsbeskrivelse-stubb</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; }
  input, button { font-size: 16px; padding: 8px 12px; }
  input { width: 220px; }
  #out { margin-top: 24px; padding: 16px; background: #f4f4f4; border-radius: 6px; min-height: 2em; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>Artsbeskrivelse-stubb</h1>
<div class="row">
  <input id="id" type="text" placeholder="scientificNameId" />
  <button id="go">Hent beskrivelse</button>
  <button id="rand">Tilfeldig art</button>
</div>
<div id="out"></div>
<script>
  const idEl = document.getElementById('id');
  const out = document.getElementById('out');
  async function fetchDesc(id) {
    out.textContent = 'Laster…';
    const r = await fetch('/taxon/description/' + encodeURIComponent(id));
    if (!r.ok) { out.textContent = 'Feil: ' + r.status; return; }
    out.innerHTML = await r.text();
  }
  document.getElementById('go').onclick = () => {
    if (idEl.value.trim()) fetchDesc(idEl.value.trim());
  };
  idEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('go').click(); });
  document.getElementById('rand').onclick = async () => {
    out.textContent = 'Henter tilfeldig id…';
    const r = await fetch('/taxon/description/random/id');
    if (!r.ok) { out.textContent = 'Feil: ' + r.status; return; }
    const j = await r.json();
    idEl.value = j.scientificNameId;
    fetchDesc(j.scientificNameId);
  };
</script>
</body>
</html>`;
    res.status(200).type("text/html").send(html);
  });

  app.get("/taxon/description/random/id", apiLimiter, async (req, res) => {
    try {
      const id = await getRandomAcceptedSpeciesId();
      if (!id) return res.status(404).json({ error: "No species available" });
      res.status(200).json({ scientificNameId: id });
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/taxon/description/:sciNameId", apiLimiter, async (req, res) => {
    try {
      const html = await getDescriptionStub(req.params.sciNameId);
      if (!html) return res.status(404).json({ error: "Not found" });
      res.status(200).type("text/html").send(html);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/admin/taxon/reload/name/*splat", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      let taxonName = decodeURI(req.originalUrl.replace("/admin/taxon/reload/name/", ""));
      let name = await getName(null, taxonName, true);
      res.status(200).json(name);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/admin/taxon/reload/id/*splat", authLimiter, authenticateAdminToken, async (req, res) => {
    try {
      let taxonId = decodeURI(req.originalUrl.replace("/admin/taxon/reload/id/", ""));
      let name = await getName(taxonId, "", true);
      res.status(200).json(name);
    } catch (error) {
      writeErrorLog(`Error for ${req.originalUrl}`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
};
