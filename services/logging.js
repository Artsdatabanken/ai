const fs = require("fs");
const sanitize = require("sanitize-filename");
const { logdir } = require("../config/constants");
const { getClientIP } = require("./clientip");
const { bucketFor, isWatched } = require("./ipbucket");

const dateStr = (resolution = "d", date = false) => {
  if (!date) {
    date = new Date();
  }

  let iso = date
    .toLocaleString("en-CA", { timeZone: "Europe/Oslo", hour12: false })
    .replace(", ", "T");
  iso = iso.replace("T24", "T00");
  iso += "." + date.getMilliseconds().toString().padStart(3, "0");
  const lie = new Date(iso + "Z");
  const offset = -(lie - date) / 60 / 1000;

  if (resolution === "m") {
    return `${new Date(date.getTime() - offset * 60 * 1000)
      .toISOString()
      .substring(0, 7)}`;
  } else if (resolution === "s") {
    return `${new Date(date.getTime() - offset * 60 * 1000)
      .toISOString()
      .substring(0, 19)
      .replace("T", " ")}`;
  }

  return `${new Date(date.getTime() - offset * 60 * 1000)
    .toISOString()
    .substring(0, 10)}`;
};

const writeErrorLog = (message, error) => {
  const content = error
    ? `\n${dateStr("s")}: ${message}\n   ${error}\n`
    : `${dateStr("s")}: ${message}\n`;

  fs.appendFile(`${logdir}/errorlog_${dateStr("d")}.txt`, content, (err) => {
    if (err) console.error("Failed to write error log:", err.message);
  });
};

const CSV_HEADER =
  "Datetime," +
  "IP_bucket," +
  "Origin," +
  "Latitude," +
  "Longitude," +
  "Country," +
  "Model," +
  "Number_of_pictures," +
  "Result_1_name,Result_1_group,Result_1_probability," +
  "Result_2_name,Result_2_group,Result_2_probability," +
  "Result_3_name,Result_3_group,Result_3_probability," +
  "Result_4_name,Result_4_group,Result_4_probability," +
  "Result_5_name,Result_5_group,Result_5_probability\n";

const csvField = (value) =>
  String(value === undefined || value === null ? "" : value)
    .replace(/"/g, '""')
    .replace(/[\r\n]+/g, " ");

const firstLine = (filepath) => {
  let fd;
  try {
    fd = fs.openSync(filepath, "r");
    const buffer = Buffer.alloc(4096);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, read);
    const end = text.indexOf("\n");
    return end === -1 ? text : text.substring(0, end + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const reconcileLogHeaders = () => {
  const today = dateStr("d");
  let files = [];
  try {
    files = fs.readdirSync(logdir);
  } catch {
    return 0;
  }

  let updated = 0;
  for (const file of files) {
    if (!file.endsWith(`_${today}.csv`)) continue;

    const filepath = `${logdir}/${file}`;
    const existing = firstLine(filepath);
    if (existing === null || existing === "" || existing === CSV_HEADER) continue;

    let target = filepath.replace(/\.csv$/, " (previous format).csv");
    let attempt = 2;
    while (fs.existsSync(target)) {
      target = filepath.replace(/\.csv$/, ` (previous format ${attempt}).csv`);
      attempt++;
    }

    try {
      fs.renameSync(filepath, target);
      updated++;
    } catch (error) {
      console.error(`Could not set aside ${file} after the log format changed:`, error.message);
    }
  }

  return updated;
};

const requestOrigin = (req) => {
  const origin = req.headers?.origin;
  if (origin) return origin.replace(/"/g, "");

  const referer = req.headers?.referer;
  if (!referer) return "";

  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
};

const writelog = (req, json, auth = null) => {
  let application;

  if (auth?.application) {
    application = sanitize(auth.application);
  } else if (req.body.application) {
    application = `unauth-${sanitize(req.body.application)}`;
  } else {
    application = "unauth-undefined";
  }

  let logPrefix = application;
  const logFile = `${logdir}/${logPrefix}_${dateStr("d")}.csv`;

  const writeRow = () => {
    // Already normalized to dot notation by the identification service
    const latitude = req.body.latitude || "";
    const longitude = req.body.longitude || "";
    const country = json.modelInfo ? json.modelInfo.country : "";
    const model = json.modelInfo ? json.modelInfo.model : "";
    const clientIP = getClientIP(req);
    const bucket = bucketFor(clientIP);
    const origin = requestOrigin(req);

    if (isWatched(bucket)) {
      const watchRow =
        `${dateStr("s")},"${csvField(clientIP)}","${csvField(origin)}","${csvField(logPrefix)}",` +
        `"${csvField(req.headers?.["user-agent"])}"\n`;
      fs.appendFile(`${logdir}/ipwatch-${bucket}_${dateStr("d")}.csv`, watchRow, (err) => {
        if (err) console.error("Failed to write IP watch log:", err.message);
      });
    }

    let row = `${dateStr("s")},"${csvField(bucket)}","${csvField(origin)}","${csvField(latitude)}",` +
      `"${csvField(longitude)}","${csvField(country)}","${csvField(model)}",${
        Array.isArray(req.files) ? req.files.length : 0
      }`;

    for (let i = 0; i < json.predictions[0].taxa.items.length; i++) {
      const prediction = json.predictions[0].taxa.items[i];
      row += `,"${csvField(prediction.name)}","${csvField(prediction.groupName)}",${Number(prediction.probability)}`;
    }

    row += "\n";

    fs.appendFile(logFile, row, (err) => {
      if (err) console.error("Failed to write log:", err.message);
    });
  };

  fs.access(logFile, fs.constants.F_OK, (err) => {
    if (err) {
      fs.appendFile(logFile, CSV_HEADER, (headerErr) => {
        if (headerErr) console.error("Failed to write log header:", headerErr.message);
        writeRow();
      });
    } else {
      writeRow();
    }
  });
};

const writeAdminLog = (message, details) => {
  const content = details
    ? `${dateStr("s")}: [ADMIN] ${message} - ${details}\n`
    : `${dateStr("s")}: [ADMIN] ${message}\n`;

  fs.appendFile(`${logdir}/admin_${dateStr("d")}.txt`, content, (err) => {
    if (err) console.error("Failed to write admin log:", err.message);
  });
};

module.exports = {
  dateStr,
  requestOrigin,
  reconcileLogHeaders,
  writeErrorLog,
  writeAdminLog,
  writelog
};
