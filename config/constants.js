const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

const logdir = "./log";
const cachedir = "./cache";
const taxadir = `${cachedir}/taxa`;
const pictureFile = `${cachedir}/taxonPictures.json`;
const uploadsdir = "./uploads";
const listVersionsFile = `${cachedir}/listversions.json`;
const TOKENS_FILE = "./auth/tokens.json";

const headfile = ".git/HEAD";

let branch = "";
let server_url = "https://ai.test.artsdatabanken.no";
if (fs.existsSync(headfile)) {
  branch = fs.readFileSync(headfile).toString().split("/");
  branch = branch[branch.length - 1].split("\n")[0];
}

if (branch === "master") {
  server_url = "https://ai.artsdatabanken.no";
}

let warningsConfig = [];
try {
  warningsConfig = JSON.parse(fs.readFileSync("./config/warnings.json", "utf8"));
} catch (error) {
  console.error("Warning: Could not load warnings configuration:", error.message);
}

const groupNameTranslations = {
  "biller": { "nb": "Biller", "nn": "Biller", "en": "Beetles", "sv": "Skalbaggar", "se": " Coleoptera ", "nl": "Kevers", "es": "Escarabajos" },
  "bløtdyr": { "nb": "Bløtdyr", "nn": "Blautdyr", "en": "Molluscs", "sv": "Blötdjur", "se": "Šlieddaealli", "nl": "Weekdieren", "es": "Moluscos" },
  "døgnfluer, øyenstikkere, steinfluer, vårfluer": { "nb": "Døgnfluer, øyenstikkere, steinfluer, vårfluer", "nn": "Døgnfluger osv", "en": "Mayflies etc", "sv": "Dagsländor etc", "se": "Ephemeroptera jna", "nl": "Eendagsvliegen etc", "es": "Efímeras etc" },
  "edderkoppdyr": { "nb": "Edderkoppdyr", "nn": "Edderkoppdyr", "en": "Arachnids", "sv": "Spindeldjur", "se": "Heavnnit", "nl": "Spinachtigen", "es": "Arácnidos" },
  "fisker": { "nb": "Fisker", "nn": "Fiskar", "en": "Fish", "sv": "Fiskar", "se": "Guolli", "nl": "Vissen", "es": "Peces" },
  "fugler": { "nb": "Fugler", "nn": "Fuglar", "en": "Birds", "sv": "Fåglar", "se": "Lottit", "nl": "Vogels", "es": "Aves" },
  "karplanter": { "nb": "Karplanter", "nn": "Karplantar", "en": "Vascular plants", "sv": "Kärlväxter", "se": "Šattut", "nl": "Vaatplanten", "es": "Plantas vasculares" },
  "lav": { "nb": "Lav", "nn": "Lav", "en": "Lichens", "sv": "Lavar", "se": "Čuovggat", "nl": "Korstmossen", "es": "Líquenes" },
  "moser": { "nb": "Moser", "nn": "Mosar", "en": "Mosses", "sv": "Mossor", "se": "Muohta", "nl": "Mossen", "es": "Musgos" },
  "nebbmunner": { "nb": "Nebbmunner", "nn": "Nebbmunnar", "en": "Hemipterans", "sv": "Halvvingar", "se": "Hemiptera", "nl": "Halfvleugeligen", "es": "Hemípteros" },
  "nebbfluer, kamelhalsfluer, mudderfluer, nettvinger": { "nb": "Nebbfluer, kamelhalsfluer, mudderfluer, nettvinger", "nn": "Nettvenger osv", "en": "Lacewings etc", "sv": "Nätvingar etc", "se": "Neuroptera jna", "nl": "Netvleugeligen etc", "es": "Neurópteros etc" },
  "pattedyr": { "nb": "Pattedyr", "nn": "Pattedyr", "en": "Mammals", "sv": "Däggdjur", "se": "Njiččehasat", "nl": "Zoogdieren", "es": "Mamíferos" },
  "armfotinger, pigghuder, kappedyr": { "nb": "Armfotinger, pigghuder, kappedyr", "nn": "Pigghudingar osv", "en": "Echinoderms etc", "sv": "Tagghudingar etc", "se": "Echinodermata jna", "nl": "Stekelhuidigen etc", "es": "Equinodermos etc" },
  "amfibier, reptiler": { "nb": "Amfibier, reptiler", "nn": "Amfibia, reptilar", "en": "Amphibians, reptiles", "sv": "Groddjur, reptiler", "se": "Rihcceeallit, njoammut", "nl": "Amfibieën, reptielen", "es": "Anfibios, reptiles etc" },
  "sommerfugler": { "nb": "Sommerfugler", "nn": "Sommarfuglar", "en": "Butterflies & moths", "sv": "Fjärilar", "se": "Beaivelottit", "nl": "Vlinders", "es": "Mariposas y polillas" },
  "sopper": { "nb": "Sopper", "nn": "Soppar", "en": "Fungi", "sv": "Svampar", "se": "Guobbarat", "nl": "Paddenstoelen en schimmels", "es": "Hongos" },
  "tovinger": { "nb": "Tovinger", "nn": "Tovenger", "en": "Flies", "sv": "Tvåvingar", "se": "Diptera", "nl": "Tweevleugeligen", "es": "Dípteros" },
  "veps": { "nb": "Veps", "nn": "Veps", "en": "Wasps", "sv": "Getingar", "se": "Hymenoptera", "nl": "Wespen", "es": "Avispas" }
};

const capitalizeFirstLetter = (str) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

module.exports = {
  rootDir,
  logdir,
  cachedir,
  taxadir,
  pictureFile,
  uploadsdir,
  listVersionsFile,
  TOKENS_FILE,
  branch,
  server_url,
  warningsConfig,
  groupNameTranslations,
  capitalizeFirstLetter
};
