const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ path: "./config/config.env" });
dotenv.config({ path: "./auth/secrets.env" });

const { taxadir, logdir, uploadsdir } = require("./config/constants");
const { initializeIpLookup } = require("./services/geolocation");
const { setupCronJobs } = require("./jobs/cron");

const identifyRoutes = require("./routes/identify");
const adminRoutes = require("./routes/admin");
const taxonRoutes = require("./routes/taxon");
const miscRoutes = require("./routes/misc");

let appInsights = require("applicationinsights");

var filteringAiFunction = (envelope, context) => {
  if (
    envelope.data.baseData.success &&
    envelope.data.baseData.name === "GET /"
  ) {
    return false;
  }

  return true;
};

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
  appInsights.defaultClient.addTelemetryProcessor(filteringAiFunction);
}

if (!fs.existsSync(taxadir)) {
  fs.mkdirSync(taxadir, { recursive: true });
}

if (!fs.existsSync(logdir)) {
  fs.mkdirSync(logdir);
}

if (!fs.existsSync(uploadsdir)) {
  fs.mkdirSync(uploadsdir);
}

const app = express();
const port = process.env.PORT;

const trustProxyConfig = process.env.TRUST_PROXY || "1";
if (trustProxyConfig === "false") {
  app.set("trust proxy", false);
} else if (/^\d+$/.test(trustProxyConfig)) {
  app.set("trust proxy", parseInt(trustProxyConfig));
} else {
  app.set("trust proxy", trustProxyConfig);
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

var corsOptions = {
  origin: "*",
};

app.use(cors(corsOptions));

app.use(function (req, res, next) {
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

identifyRoutes(app, upload);
adminRoutes(app, upload);
taxonRoutes(app);
miscRoutes(app, upload);

setupCronJobs();

initializeIpLookup()
  .then(() => {
    app.listen(port, console.log(`Server now running on port ${port}`));
  })
  .catch((error) => {
    console.error("Failed to initialize IP lookup database:", error);
    app.listen(
      port,
      console.log(`Server running on port ${port} (IP geolocation unavailable)`)
    );
  });
