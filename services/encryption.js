const crypto = require("crypto");
const fs = require("fs");
const { uploadsdir } = require("../config/constants");
const { writeErrorLog } = require("./logging");

const encryption_algorithm = "aes-256-ctr";
const initVect = crypto.randomBytes(16);

function encrypt(file, password) {
  const cipher = crypto.createCipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
  return encrypted;
}

const decrypt = (encrypted_content, password) => {
  const decipher = crypto.createDecipheriv(
    encryption_algorithm,
    password,
    initVect
  );
  const decrypted = Buffer.concat([
    decipher.update(encrypted_content),
    decipher.final(),
  ]);
  return decrypted.toString();
};

function makeRandomHash() {
  let current_date = new Date().valueOf().toString();
  let random = Math.random().toString();
  return crypto
    .createHash("sha1")
    .update(current_date + random)
    .digest("hex");
}

const saveImagesAndGetToken = async (req) => {
  let id = makeRandomHash();
  let password = makeRandomHash().substring(0, 32);
  let counter = 0;

  for (let image of req.files) {
    let timestamp = Math.round(new Date().getTime() / 1000);
    let base64image = image.buffer.toString("base64");
    let encrypted_file = encrypt(base64image, password);
    let filename = id + "_" + counter + "_" + timestamp + "_";
    counter += 1;

    fs.writeFile(`${uploadsdir}/${filename}`, encrypted_file, (error) => {
      if (error) {
        writeErrorLog(
          `Failed to write file "${uploadsdir}/${filename}".`,
          error
        );
      }
      console.log("The file has been saved!");
    });
  }
  return { id: id, password: password };
};

module.exports = {
  encrypt,
  decrypt,
  makeRandomHash,
  saveImagesAndGetToken
};
