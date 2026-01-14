const { warningsConfig } = require("../config/constants");

const matchesCondition = (value, condition) => {
  if (typeof condition === 'string' || typeof condition === 'number' || typeof condition === 'boolean') {
    return value === condition;
  }

  if (typeof condition === 'object' && !Array.isArray(condition)) {
    if (condition.min !== undefined && value < condition.min) return false;
    if (condition.max !== undefined && value > condition.max) return false;
    return true;
  }

  if (Array.isArray(condition)) {
    return condition.includes(value);
  }

  return false;
};

const matchesDateCondition = (observationDate, dateCondition) => {
  if (!observationDate) return false;

  const obsDate = new Date(observationDate);
  const currentYear = obsDate.getFullYear();

  if (dateCondition.before) {
    const [month, day] = dateCondition.before.split('-').map(Number);
    const beforeDate = new Date(currentYear, month - 1, day);
    if (obsDate >= beforeDate) return false;
  }

  if (dateCondition.after) {
    const [month, day] = dateCondition.after.split('-').map(Number);
    const afterDate = new Date(currentYear, month - 1, day);
    if (obsDate <= afterDate) return false;
  }

  return true;
};

const evaluateWarning = (warning, context) => {
  const { conditions } = warning;

  if (conditions.groupNames) {
    if (!context.groupNames) return false;
    const hasMatch = conditions.groupNames.some(groupName =>
      Object.values(context.groupNames).some(translated =>
        translated.toLowerCase() === groupName.toLowerCase()
      )
    );
    if (!hasMatch) return false;
  }

  if (conditions.scientificName) {
    if (Array.isArray(conditions.scientificName)) {
      if (!conditions.scientificName.includes(context.scientificName)) {
        return false;
      }
    } else {
      if (context.scientificName !== conditions.scientificName) {
        return false;
      }
    }
  }

  if (conditions.country) {
    if (Array.isArray(conditions.country)) {
      if (!conditions.country.includes(context.country)) {
        return false;
      }
    } else {
      if (context.country !== conditions.country) {
        return false;
      }
    }
  }

  if (conditions.invasiveCategory && !matchesCondition(context.invasiveCategory, conditions.invasiveCategory)) {
    return false;
  }

  if (conditions.redListCategory && !matchesCondition(context.redListCategory, conditions.redListCategory)) {
    return false;
  }

  if (conditions.lat && !matchesCondition(context.lat, conditions.lat)) {
    return false;
  }

  if (conditions.lon && !matchesCondition(context.lon, conditions.lon)) {
    return false;
  }

  if (conditions.date && !matchesDateCondition(context.date, conditions.date)) {
    return false;
  }

  if (conditions.certainty && !matchesCondition(context.certainty, conditions.certainty)) {
    return false;
  }

  return true;
};

const getWarnings = (predictions, metadata) => {
  const warnings = {
    general: [],
    predictions: {}
  };

  for (const warning of warningsConfig) {
    if (warning.type === 'general') {
      const context = {
        country: metadata.country,
        lat: metadata.lat,
        lon: metadata.lon,
        date: metadata.date
      };

      for (const prediction of predictions) {
        const predictionContext = {
          ...context,
          groupNames: prediction.groupNames,
          scientificName: prediction.scientific_name || prediction.name,
          invasiveCategory: prediction.invasiveCategory,
          redListCategory: prediction.redListCategory,
          certainty: prediction.probability
        };

        if (evaluateWarning(warning, predictionContext)) {
          const warningData = {
            category: warning.category || 'info',
            title: warning.title,
            message: warning.message
          };
          if (warning.link) {
            warningData.link = warning.link;
          }
          warnings.general.push(warningData);
          break;
        }
      }
    } else if (warning.type === 'prediction') {
      for (let i = 0; i < predictions.length; i++) {
        const prediction = predictions[i];
        const context = {
          country: metadata.country,
          lat: metadata.lat,
          lon: metadata.lon,
          date: metadata.date,
          groupNames: prediction.groupNames,
          scientificName: prediction.scientific_name || prediction.name,
          invasiveCategory: prediction.invasiveCategory,
          redListCategory: prediction.redListCategory,
          certainty: prediction.probability
        };

        if (evaluateWarning(warning, context)) {
          if (!warnings.predictions[i]) {
            warnings.predictions[i] = [];
          }
          const warningData = {
            category: warning.category || 'info',
            title: warning.title,
            message: warning.message
          };
          if (warning.link) {
            warningData.link = warning.link;
          }
          warnings.predictions[i].push(warningData);
        }
      }
    }
  }

  return warnings;
};

module.exports = {
  matchesCondition,
  matchesDateCondition,
  evaluateWarning,
  getWarnings
};
