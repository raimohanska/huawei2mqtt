'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

async function withRetries(operation, { attempts = 3, signal, onRetry = async () => {}, wait = sleep }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      if (signal?.aborted || error?.retryable === false || attempt === attempts) throw error;
      const delayMs = Math.min(5000 * 2 ** (attempt - 1), 60000);
      await onRetry(error, { attempt, nextAttempt: attempt + 1, delayMs });
      await wait(delayMs, undefined, { signal });
    }
  }
}

module.exports = { withRetries };
