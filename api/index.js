// api/index.js — Vercel Serverless Function handler
const serverless = require("serverless-http");
const app = require("../server");

module.exports = serverless(app);
