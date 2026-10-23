'use strict';

const PLANT_TIME_ZONE = 'Europe/Helsinki';
const plantDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
const plantTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

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

function validateMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('Months must be valid YYYY-MM values.');
  validateDate(value + '-01');
  return value;
}

function previousMonth(value) {
  return previousDate(validateMonth(value) + '-01').slice(0, 7);
}

function daysInMonth(value) {
  validateMonth(value);
  const [year, month] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function plantDate(timestamp) {
  return plantDateFormatter.format(new Date(Number(timestamp)));
}

function plantTimeParts(timestamp) {
  return Object.fromEntries(plantTimeFormatter.formatToParts(new Date(timestamp))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function plantMidnight(date) {
  const target = Date.parse(validateDate(date) + 'T00:00:00Z');
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = plantTimeParts(guess);
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const next = guess + target - localAsUtc;
    if (next === guess) return guess;
    guess = next;
  }
  throw new Error('Could not resolve plant-local midnight.');
}

function expectedHourlySlots(date) {
  const start = plantMidnight(date);
  const nextDate = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const end = plantMidnight(nextDate);
  const slots = [];
  for (let time = start; time < end; time += 3600000) {
    slots.push(date + ' ' + plantTimeParts(time).hour + ':00:00');
  }
  return slots;
}

module.exports = { validateDate, previousDate, plantDate, validateMonth, previousMonth, daysInMonth, expectedHourlySlots };
