const cron = require("node-cron");
const fs = require("fs");
const { uploadsdir } = require("../config/constants");
const { writeErrorLog } = require("../services/logging");
const { updateIpDatabase } = require("../services/geolocation");

const setupCronJobs = () => {
  cron.schedule("30 * * * *", () => {
    fs.readdir(`${uploadsdir}/`, (err, files) => {
      if (files) {
        files.forEach((file) => {
          let filename = file.split("_")[1];
          let timestamp = Math.round(new Date().getTime() / 1000);
          let time_between = timestamp - filename;
          let survival_length = 3600;
          if (time_between >= survival_length) {
            fs.unlink(`${uploadsdir}/${file}`, (err) => {
              if (err) {
                console.log("could not delete file");
              }
              console.log("The file has been deleted!");
            });
          }
        });
      }
    });
  });

  cron.schedule("0 3 * * 0", async () => {
    console.log("Running weekly GeoIP database update...");
    try {
      await updateIpDatabase();
      console.log("GeoIP database update completed");
    } catch (error) {
      writeErrorLog("Failed to update GeoIP database", error);
    }
  });
};

module.exports = { setupCronJobs };
