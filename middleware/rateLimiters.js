const rateLimit = require("express-rate-limit");
const { getClientIP } = require("../services/geolocation");
const { writeErrorLog } = require("../services/logging");

const cacheLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many cache requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const idLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many ID requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many misc API requests`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).send(options.message);
  },
});

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW || 15) * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIP,
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many authentication attempts`,
      `IP ${getClientIP(request)}`
    );
    return response.status(options.statusCode).json({
      error: "Too many authentication attempts. Please try again later.",
      retryAfter: Math.round(options.windowMs / 1000)
    });
  },
});

module.exports = {
  cacheLimiter,
  idLimiter,
  apiLimiter,
  authLimiter
};
