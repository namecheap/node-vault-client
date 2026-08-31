/**
 * Shared logger doubles for the test suite.
 *
 * Seven test files built the same noop logger inline, and two of them also
 * duplicated the spy variant and the log-flattening helper. Keeping one copy
 * here means the shape stays consistent with what `VaultClient#__setupLogger`
 * requires: a logger is only accepted if it implements every method below.
 */
import _ from 'lodash';
import sinon from 'sinon';

/** The methods a logger must implement to be accepted by VaultClient. */
export const LOG_METHODS = ['error', 'warn', 'info', 'debug', 'trace'];

/** A complete logger whose methods all do nothing. */
export function createNoopLogger() {
    return _.fromPairs(_.map(LOG_METHODS, (method) => [method, _.noop]));
}

/** A complete logger whose methods are sinon spies, for asserting on output. */
export function createSpyLogger() {
    return _.fromPairs(_.map(LOG_METHODS, (method) => [method, sinon.spy()]));
}

/**
 * Flatten every argument passed to a spy logger into one searchable string,
 * covering both printf-style args and object logging (%j / %o).
 */
export function loggedText(log) {
    return _.flatMap(LOG_METHODS, (m) => _.flatMap(log[m].getCalls(), (c) => c.args))
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
}
