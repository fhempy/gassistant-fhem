'use strict';

// Calls fn until it succeeds. Errors with err.permanent are thrown, all others (network errors,
// server errors) are retried with an increasing delay: min, 2*min, ... up to max.
async function retry(fn, options) {
  var delay = options.min;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.permanent)
        throw err;
      if (options.onRetry)
        options.onRetry(err, delay);
      await new Promise(function (resolve) {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay * 2, options.max);
    }
  }
}

module.exports = {
  retry
};
