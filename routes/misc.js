const fs = require("fs");
const axios = require("axios");
const express = require("express");
const { apiLimiter } = require("../middleware/rateLimiters");
const { writeErrorLog, dateStr } = require("../services/logging");
const { saveImagesAndGetToken, decrypt } = require("../services/encryption");
const { branch, commit, uploadsdir } = require("../config/constants");

module.exports = (app, upload) => {
  app.get("/", apiLimiter, (req, res) => {
    fs.stat("./server.js", function (err, stats) {
      const built = err ? "unknown" : dateStr("s", stats.mtime);
      res
        .status(200)
        .send(
          `<a href="/logo.png"><img src="/logo.png" height="48"/></a><h3>Aiaiai!</h3><hr/>${commit} (${branch || "unknown"})<br/>${built}`
        );
    });
  });

  app.post("/save", apiLimiter, upload.array("image"), async (req, res) => {
    try {
      const json = await saveImagesAndGetToken(req);
      res.status(200).json(json);
    } catch (error) {
      writeErrorLog(`Failed to save image(s)`, error);
      res.status(500).json({ error: "Unable to save images" });
    }
  });

  app.get("/image/*splat", apiLimiter, async (req, res) => {
    const urlParam = req.originalUrl.replace("/image/", "");
    const parts = urlParam.split("&");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return res.status(400).json({ error: "Missing id or password" });
    }
    const id = parts[0];
    const password = parts[1];

    fs.readdir(`${uploadsdir}/`, async (err, files) => {
     try {
      let image_list = [];

      if (err) {
        writeErrorLog("Could not read the uploads directory", err);
        return res.status(500).json({ error: "Unable to read stored images" });
      }

      for (const file of files) {
        const fileid = file.split("_")[0];

        if (fileid === id) {
          try {
            const image_to_fetch = `${uploadsdir}/${file}`;
            const file_buffer = fs.readFileSync(image_to_fetch);
            image_list.push(decrypt(file_buffer, password));
          } catch (error) {
            return res.status(400).json({ error: "Could not decrypt the stored image" });
          }
        }
      }

      if (image_list.length === 0 && branch === "master") {
        try {
          const testResponse = await axios.get(
            `https://ai.test.artsdatabanken.no/image/${id}&${password}`,
            {
              headers: {
                Authorization: req.headers["authorization"],
              },
              timeout: 10000,
            }
          );
          return res.status(200).json(testResponse.data);
        } catch (error) {
          writeErrorLog(`Failed to fetch image from test server`, error);
        }
      }

      if (image_list.length === 0) {
        return res.status(404).json({ error: "Image not found" });
      }

      res.status(200).json({ image: image_list });
     } catch (error) {
      writeErrorLog(`Failed to return saved images`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
     }
    });
  });

  app.get("/robots933456.txt", apiLimiter, (req, res) => {
    res.status(200).send("Hi, Azure");
  });

  app.get("/rss", apiLimiter, (_req, res) => {
    res.type("application/rss+xml");
    res.sendFile("./cache/feed.rss", { root: "." });
  });

  app.use("/favicon.ico", apiLimiter, express.static("favicon.ico"));
  app.use("/logo.png", apiLimiter, express.static("logo.png"));
};
