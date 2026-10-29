'use strict';

// Slash trimming without a regex: /\/+$/ is tried at every position of a run of slashes, so it is
// quadratic on a long run that does not end the string ('a' + '/'.repeat(40000) + 'x' takes
// half a second), and its inputs (namespace, engines keys, paths, detection responses) come from
// outside the library (CodeQL js/polynomial-redos).

/**
 * @param {string} value
 * @returns {string} `value` without trailing slashes
 */
function trimTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
        end--;
    }
    return value.slice(0, end);
}

/**
 * @param {string} value
 * @returns {string} `value` without leading or trailing slashes
 */
function trimSlashes(value) {
    let start = 0;
    while (start < value.length && value[start] === '/') {
        start++;
    }
    return trimTrailingSlashes(value.slice(start));
}

module.exports = { trimTrailingSlashes, trimSlashes };
