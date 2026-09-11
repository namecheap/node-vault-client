'use strict';

const NODE_18_DEPRECATION_MESSAGE =
    'node-vault-client: this is the last release of this package to support Node.js 18. ' +
    'Node 18 reached end-of-life on 2025-04-30 and no longer receives security patches from ' +
    'the Node.js project. The next major release of node-vault-client will require ' +
    'Node.js >= 20.19.0 — see CHANGELOG.md for details.';
const NODE_18_DEPRECATION_CODE = 'NodeVaultClientNode18Deprecation';

/**
 * Emits a one-time process warning when running on Node.js 18. Called once, at module load,
 * from VaultClient.js — require()'s own module cache is what keeps it to once per process,
 * not any dedup logic here.
 *
 * Takes a `process`-like object (defaulting to the real `process`) purely so tests can assert
 * the behaviour on a stubbed Node version instead of on whatever Node this suite happens to run
 * under.
 */
function warnIfNode18(proc) {
    proc = proc || process;
    const nodeVersion = proc.versions && proc.versions.node;
    if (typeof nodeVersion === 'string' && /^18\./.test(nodeVersion)) {
        proc.emitWarning(NODE_18_DEPRECATION_MESSAGE, { code: NODE_18_DEPRECATION_CODE });
    }
}

module.exports = { warnIfNode18, NODE_18_DEPRECATION_MESSAGE, NODE_18_DEPRECATION_CODE };
