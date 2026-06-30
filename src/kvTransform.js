'use strict';

/**
 * Pure KV path-rewriting and response-normalizing helpers.
 * No I/O; fully testable in isolation.
 *
 * rewritePath(version, op, mount, logicalPath) -> apiPath
 * normalizeResponse(version, op, body)         -> normalized body
 */

// Map of op -> v2 path segment inserted between mount and logical path.
const V2_SEGMENT = {
    read:            'data',
    write:           'data',
    delete:          'data',
    update:          'data',
    list:            'metadata',
    readMetadata:    'metadata',
    deleteMetadata:  'metadata',
    deleteVersions:  'delete',
    undeleteVersions:'undelete',
    destroyVersions: 'destroy',
};

/**
 * Rewrite a logical path to the correct API path for the given engine version.
 *
 * @param {number} version   - Engine version (2 = KV v2; anything else = passthrough)
 * @param {string} op        - Operation name (read, write, list, delete, update, …)
 * @param {string} mount     - Mount point (e.g. "secret" or "secret/")
 * @param {string} logicalPath - Path relative to the mount (e.g. "team/svc")
 * @returns {string}
 */
function rewritePath(version, op, mount, logicalPath) {
    // Normalise trailing slash on mount
    const m = mount.replace(/\/+$/, '');

    if (version !== 2) {
        // v1 / non-kv: simple concatenation
        return logicalPath ? `${m}/${logicalPath}` : m;
    }

    const segment = V2_SEGMENT[op] || 'data';
    return `${m}/${segment}/${logicalPath}`;
}

/**
 * Normalise a Vault API response body for the given engine version and operation.
 *
 * For v1 / non-kv the body is always returned as-is.
 * For v2:
 *  - read:         body.data is replaced with body.data.data; body.metadata is set to body.data.metadata
 *  - readMetadata: body.data is replaced with the original body.data (unwrapped one level)
 *  - write/delete/update/…: body returned as-is
 *
 * @param {number} version
 * @param {string} op
 * @param {*}      body
 * @returns {*}
 */
function normalizeResponse(version, op, body) {
    if (version !== 2) {
        return body;
    }

    if (op === 'read') {
        if (!body || !body.data) {
            return body;
        }
        // Promote inner data/metadata to top-level response fields
        const result = Object.assign({}, body);
        result.metadata = body.data.metadata;
        result.data = body.data.data;
        return result;
    }

    if (op === 'readMetadata') {
        if (!body || !body.data) {
            return body;
        }
        const result = Object.assign({}, body);
        result.data = body.data;
        return result;
    }

    // All other v2 ops (write, list, delete, update, deleteVersions, …): passthrough
    return body;
}

module.exports = { rewritePath, normalizeResponse };
