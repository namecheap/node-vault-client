'use strict';

const NODE_20_DEPRECATION_CODE = 'NVC_DEP_NODE_20';
const NODE_20_DEPRECATION_MESSAGE =
    'node-vault-client: support for Node.js 20 is deprecated. Node.js 20 reached end-of-life on ' +
    '2026-04-30 and no longer receives security patches from the Node.js project. The next major ' +
    'release of node-vault-client will require Node.js 22 or later.';
// Set on `process` once the warning is emitted. The module cache alone does not keep it to once:
// a test runner that resets modules, or a second copy of the package, loads this file again.
const WARNED = Symbol.for('node-vault-client.NVC_DEP_NODE_20');

/**
 * Emit a DeprecationWarning when running on Node.js 20, which is past its end-of-life (#221).
 * VaultClient.js calls this at module load. It warns once per `process` object, so once per
 * process, and once more in each worker thread that loads the client.
 *
 * Loading the client must not fail because of this: nothing here throws, and under
 * --throw-deprecation, where Node would throw a DeprecationWarning on the next tick with no way
 * for the caller to avoid it short of changing runtime, it is emitted as a plain Warning.
 * --no-deprecation silences it, as for any DeprecationWarning.
 * @param {Object} [proc] - a `process`-like object, so tests can state the Node.js version
 * @returns {boolean} true when the warning was emitted
 * @private
 */
function warnIfNode20(proc) {
    try {
        proc = proc || process;
        const nodeVersion = proc.versions && proc.versions.node;
        if (typeof nodeVersion !== 'string' || !nodeVersion.startsWith('20.') || proc[WARNED]) {
            return false;
        }
        proc[WARNED] = true;
        proc.emitWarning(NODE_20_DEPRECATION_MESSAGE, {
            type: proc.throwDeprecation && !proc.noDeprecation ? 'Warning' : 'DeprecationWarning',
            code: NODE_20_DEPRECATION_CODE,
        });
        return true;
    } catch {
        return false;
    }
}

module.exports = { warnIfNode20, NODE_20_DEPRECATION_CODE, NODE_20_DEPRECATION_MESSAGE };
