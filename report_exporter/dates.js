'use strict';

const PLANT_TIME_ZONE = 'Europe/Helsinki';

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new Error('Dates must be valid YYYY-MM-DD values.');
  }
  return value;
}

function previousDate(value) {
  return new Date(Date.parse(value + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

function plantDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PLANT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(Number(timestamp)));
}

module.exports = { validateDate, previousDate, plantDate };
