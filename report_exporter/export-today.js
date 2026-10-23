'use strict';

const { log } = require('./logger');

require('./export-reports').run(['--today', ...process.argv.slice(2)]).catch(error => {
  log.error(error.message);
  process.exitCode = 1;
});
