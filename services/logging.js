const fs = require("fs");
const sanitize = require("sanitize-filename");
const { logdir } = require("../config/constants");

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
  if (!!error) {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr("d")}.txt`,
      `\n${dateStr("s")}: ${message}\n   ${error}\n`
    );
  } else {
    fs.appendFileSync(
      `${logdir}/errorlog_${dateStr("d")}.txt`,
      `${dateStr("s")}: ${message}\n`
    );
  }
};

const writelog = (req, json, auth = null) => {
  let application;

  if (auth?.application) {
    application = sanitize(auth.application);
  } else if (req.body.application) {
    application = sanitize(req.body.application);
  }

  let logPrefix = application;

  if (!fs.existsSync(`${logdir}/${logPrefix}_${dateStr("d")}.csv`)) {
    fs.appendFileSync(
      `${logdir}/${logPrefix}_${dateStr("d")}.csv`,
      "Datetime," +
        "IP," +
        "Latitude," +
        "Longitude," +
        "Country," +
        "Model," +
        "Number_of_pictures," +
        "Result_1_name,Result_1_group,Result_1_probability," +
        "Result_2_name,Result_2_group,Result_2_probability," +
        "Result_3_name,Result_3_group,Result_3_probability," +
        "Result_4_name,Result_4_group,Result_4_probability," +
        "Result_5_name,Result_5_group,Result_5_probability\n"
    );
  }

  const latitude = req.body.latitude || "";
  const longitude = req.body.longitude || "";
  const country = json.modelInfo ? json.modelInfo.country : "";
  const model = json.modelInfo ? json.modelInfo.model : "";
  const clientIP = json.modelInfo && json.modelInfo.detectedIP ? json.modelInfo.detectedIP : "";

  let row = `${dateStr("s")},"${clientIP}","${latitude}","${longitude}","${country}","${model}",${
    Array.isArray(req.files) ? req.files.length : 0
  }`;

  for (let i = 0; i < json.predictions[0].taxa.items.length; i++) {
    const prediction = json.predictions[0].taxa.items[i];
    row += `,"${prediction.name}","${prediction.groupName}",${prediction.probability}`;
  }

  row += "\n";

  fs.appendFileSync(`${logdir}/${application}_${dateStr("d")}.csv`, row);
};

module.exports = {
  dateStr,
  writeErrorLog,
  writelog
};
