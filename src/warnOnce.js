'use strict';

/**
 * Warnings already logged, kept per `logger.warn` function: the default console logger of every
 * client shares `console.warn`, so the process logs a warning once however many clients it
 * creates, while a client with a logger of its own still gets it, and the no-op logger of
 * `logger: false` uses up nobody else's. Each set holds one short string per distinct warning.
 * @type {WeakMap<Function, Set<string>>}
 */
const logged = new WeakMap();

/**
 * Log `message` with `args` through `logger.warn`, unless that same `logger.warn` has already
 * logged `message` for `key`. It is recorded only once it has been logged, so a throwing logger
 * uses nothing up, and this never throws.
 * @param {Object} logger
 * @param {string} key - what the warning is about, such as a host or a mount
 * @param {string} message - the format string
 * @param {...*} args
 * @returns {boolean} true when the warning is logged now or was logged before; false when the
 *      logger threw, so the caller can try again later
 * @private
 */
function warnOnce(logger, key, message, ...args) {
    try {
        const warn = logger.warn;
        const id = `${message}\u0000${key}`;
        let seen = logged.get(warn);
        if (seen && seen.has(id)) {
            return true;
        }
        logger.warn(message, ...args);
        if (!seen) {
            seen = new Set();
            logged.set(warn, seen);
        }
        seen.add(id);
        return true;
    } catch {
        return false;
    }
}

module.exports = warnOnce;
