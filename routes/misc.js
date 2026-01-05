const fs = require("fs");
const axios = require("axios");
const express = require("express");
const { apiLimiter } = require("../middleware/rateLimiters");
const { writeErrorLog, dateStr } = require("../services/logging");
const { saveImagesAndGetToken, decrypt } = require("../services/encryption");
const { branch, uploadsdir } = require("../config/constants");

module.exports = (app, upload) => {
  app.get("/", apiLimiter, (req, res) => {
    let v = "Gitless";

    if (branch) {
      const gitfile = ".git/FETCH_HEAD";
      if (fs.existsSync(gitfile)) {
        v = fs
          .readFileSync(gitfile)
          .toString()
          .split("\n")
          .find((x) => x.includes(branch));
        if (v) {
          v = v.split("\t")[0];
        }
      }
    }

    fs.stat("./server.js", function (err, stats) {
      res
        .status(200)
        .send(
          `<h3>Aiaiai!</h3><hr/>${v} (${branch})<br/>${dateStr("s", stats.mtime)}`
        );
    });
  });

  app.post("/save", apiLimiter, upload.array("image"), async (req, res) => {
    try {
      const json = await saveImagesAndGetToken(req);
      res.status(200).json(json);
    } catch (error) {
      writeErrorLog(`Failed to save image(s)`, error);
    }
  });

  app.get("/image/*", apiLimiter, async (req, res) => {
    const urlParam = req.originalUrl.replace("/image/", "");
    const password = urlParam.split("&")[1].toString();
    const id = urlParam.split("&")[0];

    fs.readdir(`${uploadsdir}/`, async (err, files) => {
      let image_list = [];

      files.forEach((file) => {
        const fileid = file.split("_")[0];

        if (fileid === id) {
          const image_to_fetch = `${uploadsdir}/${file}`;
          const file_buffer = fs.readFileSync(image_to_fetch);
          let decrypted_file = decrypt(file_buffer, password);
          image_list.push(decrypted_file);
        }
      });

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

      try {
        res.status(200).json({ image: image_list });
      } catch (error) {
        writeErrorLog(`Failed to return json of saved images`, error);
        res.status(500).json({ error: "Internal server error" });
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
};
