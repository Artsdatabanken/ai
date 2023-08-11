const express = require("express");
const dotenv = require("dotenv");

// // --- Reading env variables
dotenv.config({ path: "./config/config.env" });
dotenv.config({ path: "./config/secrets.env" });

const app = express();
const port = process.env.PORT;


// --- Forward all requests to the production instance
const { createProxyMiddleware } = require('http-proxy-middleware');
app.use('*', createProxyMiddleware({target: 'https://ai.artsdatabanken.no', changeOrigin: true}));

app.listen(port, console.log(`Server now running on port ${port}`));