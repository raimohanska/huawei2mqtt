'use strict';

function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3) + (offset >= 0 ? '+' : '-') +
    pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
}

function emit(level, message) {
  const output = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  for (const line of String(message).split(/\r?\n/)) output(timestamp() + ' [' + level + '] ' + line);
}

const log = {
  info: message => emit('INFO', message),
  warn: message => emit('WARN', message),
  error: message => emit('ERROR', message)
};

function createSkipReporter(write = log.info, unit = 'day') {
  let count = 0;
  let oldest;
  return {
    add: date => { count++; oldest = date; },
    flush: nextDate => {
      if (!count) return;
      write('Skipping ' + (nextDate ? 'to ' + nextDate : 'through ' + oldest) + ' because ' + count +
        (count === 1 ? ' ' + unit + ' already has a valid CSV.' : ' ' + unit + 's already have valid CSVs.'));
      count = 0;
    }
  };
}

module.exports = { log, timestamp, createSkipReporter };
