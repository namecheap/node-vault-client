'use strict';

const NODE_20_DEPRECATION_CODE = 'NVC_DEP_NODE_20';
const NODE_20_DEPRECATION_MESSAGE =
    'node-vault-client: support for Node.js 20 is deprecated. Node.js 20 reached end-of-life on ' +
    '2026-04-30 and no longer receives security patches from the Node.js project. The next major ' +
    'release of node-vault-client will require Node.js 22 or later.';

/**
 * Emit a DeprecationWarning when running on Node.js 20, which is past its end-of-life (#221).
 * VaultClient.js calls this at module load, so the module cache keeps it to once per process.
 * It never throws: a warning must not keep the client from loading.
 * --no-deprecation silences it, as for any DeprecationWarning.
 * @param {Object} [proc] - a `process`-like object, so tests can state the Node.js version
 * @returns {boolean} true when the warning was emitted
 * @private
 */
function warnIfNode20(proc = process) {
    try {
        const nodeVersion = proc.versions && proc.versions.node;
        if (typeof nodeVersion !== 'string' || !nodeVersion.startsWith('20.')) {
            return false;
        }
        proc.emitWarning(NODE_20_DEPRECATION_MESSAGE, {
            type: 'DeprecationWarning',
            code: NODE_20_DEPRECATION_CODE,
        });
        return true;
    } catch {
        return false;
    }
}

module.exports = { warnIfNode20, NODE_20_DEPRECATION_CODE, NODE_20_DEPRECATION_MESSAGE };
