const fs = require("fs");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ path: "./config/config.env", quiet: true });
dotenv.config({ path: "./auth/secrets.env", quiet: true });

const {
  logdir,
  uploadsdir,
  cachedir,
  cacheIsPersistent,
  preferredCacheDir
} = require("./config/constants");
const { writeErrorLog } = require("./services/logging");

process.on("uncaughtException", (error) => {
  writeErrorLog("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  writeErrorLog("Unhandled rejection", reason);
});

const { initializeIpLookup } = require("./services/geolocation");
const { reloadTaxonImages } = require("./services/taxon");
const { setupCronJobs } = require("./jobs/cron");

const identifyRoutes = require("./routes/identify");
const adminRoutes = require("./routes/admin");
const taxonRoutes = require("./routes/taxon");
const miscRoutes = require("./routes/misc");

let appInsights = require("applicationinsights");
const { SpanKind } = require("@opentelemetry/api");

class FilterHealthCheckProcessor {
  onStart() {}
  onEnd(span) {
    if (
      span.kind === SpanKind.SERVER &&
      span.name === "GET /" &&
      span.status && span.status.code !== 2
    ) {
      span.attributes["_filtered"] = true;
    }
  }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

if (process.env.IKEY) {
  appInsights.setup(process.env.IKEY).start();
  const { trace } = require("@opentelemetry/api");
  const provider = trace.getTracerProvider();
  if (provider && typeof provider.addSpanProcessor === "function") {
    provider.addSpanProcessor(new FilterHealthCheckProcessor());
  }
}

const ensureDir = (dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    console.warn(`Could not create directory "${dir}": ${error.message}`);
  }
};

ensureDir(logdir);
ensureDir(uploadsdir);

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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

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
const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

identifyRoutes(app, upload);
adminRoutes(app, upload);
taxonRoutes(app);
miscRoutes(app, upload);

setupCronJobs();

if (!cacheIsPersistent) {
  writeErrorLog(
    `Cache dir "${preferredCacheDir}" is not writable` +
    (cachedir === preferredCacheDir ? "" : `, using "${cachedir}" instead`) +
    `. Nothing can be cached, so every request refetches and slow ones fall ` +
    `back to scientific names.`
  );
}

const persistenceStamp = `${cachedir}/.persistence`;
try {
  const writtenAt = Number(fs.readFileSync(persistenceStamp, "utf8").trim());
  const ageHours = ((Date.now() - writtenAt) / (1000 * 60 * 60)).toFixed(1);
  console.log(`Taxon cache survived the restart (stamp written ${ageHours}h ago)`);
} catch {
  writeErrorLog(
    `No cache persistence stamp in "${cachedir}". Either this is the first ` +
    `start after deploying this version, or the restart wiped the cache. If ` +
    `this line appears on every restart the cache is not persistent, and ` +
    `users get scientific names until it refills each time.`
  );
}
fs.writeFileSync(persistenceStamp, String(Date.now()));

reloadTaxonImages().catch((error) =>
  writeErrorLog("Failed to reload taxon images on startup", error)
);

initializeIpLookup()
  .then(() => {
    app.listen(port, () => console.log(`Server now running on port ${port}`));
  })
  .catch((error) => {
    console.error("Failed to initialize IP lookup database:", error);
    app.listen(port, () =>
      console.log(`Server running on port ${port} (IP geolocation unavailable)`)
    );
  });
