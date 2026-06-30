'use strict';

const { VaultError } = require('./errors');

/**
 * Resolves the KV engine version for a given secret path.
 *
 * Responsibilities:
 *  1. Check engines override map first (longest-prefix match, no I/O).
 *  2. Auto-detect via detectFn(path) -> { data: { path, type, options } }.
 *  3. Cache by canonical mount path; de-duplicate in-flight detections.
 *  4. On failure, throw VaultError with actionable guidance.
 *
 * @param {Function} detectFn          - async (path: string) => Vault mount-info response
 * @param {Object}   enginesOverride   - { [mountPrefix]: version }
 * @param {Object}   logger            - logger with .debug(), .error() etc.
 * @param {Object}   [opts]            - additional options
 * @param {boolean}  [opts.disabled]   - if true, always return passthrough (version 1)
 */
class MountResolver {
    constructor(detectFn, enginesOverride, logger, opts) {
        this.__detectFn = detectFn;
        this.__engines = enginesOverride || {};
        this.__log = logger;
        this.__disabled = opts && opts.disabled === true;

        // Cache: canonical mount path (no trailing slash) -> { mount, version, type }
        this.__cache = new Map();
        // In-flight promises: canonical mount path -> Promise<{mount,version,type}>
        this.__inflight = new Map();
    }

    /**
     * Resolve the engine version for the given path.
     *
     * @param {string} path - full logical path (e.g. "secret/foo/bar")
     * @returns {Promise<{mount: string, version: number, type: string}>}
     */
    resolve(path) {
        // 1. Check engines override (longest-prefix match). This applies even when
        //    auto-detection is disabled, so listed mounts resolve with no I/O.
        const override = this.__enginesOverrideLookup(path);
        if (override !== null) {
            this.__log.debug('MountResolver: engines override for %s -> v%d', path, override.version);
            return Promise.resolve(override);
        }

        // 2. When detection is disabled (autoDetect off), an unlisted mount is a
        //    passthrough (v1) — never issue a sys/internal/ui/mounts round-trip.
        //    engines is the documented fallback for Vaults that deny detection.
        if (this.__disabled) {
            return Promise.resolve({ mount: this.__extractMount(path), version: 1, type: 'kv' });
        }

        // 3. Auto-detect: use canonical mount path as cache key once we know it.
        //    For the in-flight grouping key we use the first path segment so that
        //    concurrent reads of sub-paths of the SAME mount (e.g. secret/a and
        //    secret/b) share one detection.  After the shared promise resolves we
        //    verify that the canonical mount returned actually prefixes this path;
        //    if it does not (two distinct multi-segment mounts share a first segment,
        //    e.g. team/kvA/* and team/kvB/*), we start a fresh detection using the
        //    full path as key so each mount gets its own call.
        const interimKey = path.split('/')[0];
        return this.__detectWithCache(interimKey, path);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Longest-prefix match against the engines override map.
     * Returns { mount, version } or null if no match found.
     */
    __enginesOverrideLookup(path) {
        const entries = Object.entries(this.__engines);
        if (entries.length === 0) return null;

        // Sort by descending key length (longest first) for prefix match
        entries.sort((a, b) => b[0].length - a[0].length);

        for (const [prefix, version] of entries) {
            const normalised = prefix.replace(/\/+$/, '');
            if (path === normalised || path.startsWith(normalised + '/')) {
                return { mount: normalised, version: Number(version), type: 'kv' };
            }
        }
        return null;
    }

    /**
     * Resolve via cache or detectFn.  Groups concurrent calls by interimKey so
     * only one detectFn call is in-flight per first-segment at a time.
     *
     * Followers that join a shared in-flight promise verify that the resolved
     * canonical mount actually prefixes their path.  If it does not (two distinct
     * multi-segment mounts share a first segment, e.g. "team/kvA" and "team/kvB"),
     * the follower falls through to start its own fresh detection keyed on its
     * full path, so each mount gets its own accurate detection result.
     */
    __detectWithCache(interimKey, path) {
        // Check persistent cache first (keyed on canonical mount path)
        for (const [mountKey, entry] of this.__cache) {
            if (path === mountKey || path.startsWith(mountKey + '/')) {
                return Promise.resolve(entry);
            }
        }

        // Check in-flight for this interim key (first segment or full path)
        if (this.__inflight.has(interimKey)) {
            // Join the existing in-flight promise but verify the result matches our path.
            // If the detection was for a different sub-mount, start a fresh detection.
            return this.__inflight.get(interimKey).then((entry) => {
                if (path === entry.mount || path.startsWith(entry.mount + '/')) {
                    return entry;
                }
                // The shared detection resolved to a different mount — start our own.
                // Use the full path as key so it won't collide with the first-segment key.
                return this.__detectWithCache(path, path);
            });
        }

        // Start a new detection
        const promise = this.__detectFn(path)
            .then((response) => {
                const info = response && response.data;
                if (!info) {
                    throw new Error('Unexpected empty detection response');
                }

                const canonicalMount = (info.path || interimKey).replace(/\/+$/, '');
                const type = info.type || 'unknown';
                const optVersion = info.options && info.options.version;
                // Only kv v2 gets special treatment; everything else is passthrough
                const version = (type === 'kv' && Number(optVersion) === 2) ? 2 : 1;

                const entry = { mount: canonicalMount, version, type };
                this.__log.debug('MountResolver: detected %s as type=%s version=%d', canonicalMount, type, version);

                // Store in persistent cache
                this.__cache.set(canonicalMount, entry);
                // Clear in-flight
                this.__inflight.delete(interimKey);
                return entry;
            })
            .catch((err) => {
                // Clear in-flight so callers can retry
                this.__inflight.delete(interimKey);
                throw new VaultError(
                    `Failed to detect KV engine version for mount "${interimKey}" (path: ${path}): ${err.message}. ` +
                    'Set api.engines or disable autoDetect to bypass detection.'
                );
            });

        this.__inflight.set(interimKey, promise);
        return promise;
    }

    /**
     * Simple first-segment extraction used only for the disabled path.
     */
    __extractMount(path) {
        return path.split('/')[0];
    }
}

module.exports = MountResolver;
