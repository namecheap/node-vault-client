'use strict';

const { VaultError, InvalidArgumentsError } = require('./errors');

// Default cap for the mount cache. Real deployments talk to a handful of static
// mounts, so this is generous headroom; the cap exists so that a long-lived
// service pointed at many/dynamic mounts (e.g. multi-tenant) cannot grow the
// cache — and the per-resolve lookup cost — without bound (issue #108).
const DEFAULT_MAX_CACHE_SIZE = 500;

/**
 * Resolves the KV engine version for a given secret path.
 *
 * Responsibilities:
 *  1. Check engines override map first (longest-prefix match, no I/O).
 *  2. Auto-detect via detectFn(path) -> { data: { path, type, options } }.
 *  3. Cache by canonical mount path (bounded LRU); de-duplicate in-flight detections.
 *  4. On failure, throw VaultError with actionable guidance.
 *
 * @param {Function} detectFn            - async (path: string) => Vault mount-info response
 * @param {Object}   enginesOverride     - { [mountPrefix]: version }; snapshotted at construction
 * @param {Object}   logger              - logger with .debug(), .error() etc.
 * @param {Object}   [opts]              - additional options
 * @param {boolean}  [opts.disabled]     - if true, always return passthrough (version 1)
 * @param {number}   [opts.maxCacheSize] - LRU cap for the mount cache (default 500)
 */
class MountResolver {
    constructor(detectFn, enginesOverride, logger, opts) {
        this.__detectFn = detectFn;
        this.__log = logger;
        this.__disabled = opts && opts.disabled === true;
        // Validate before use: a non-positive cap would make the eviction loop in
        // __cacheStore spin forever (size can never drop below the cap), and a
        // non-integer cap makes the bound meaningless.
        const maxCacheSize = opts && opts.maxCacheSize;
        if (maxCacheSize !== undefined
            && (!Number.isInteger(maxCacheSize) || maxCacheSize <= 0)) {
            throw new InvalidArgumentsError(
                `MountResolver: opts.maxCacheSize must be a positive integer, got ${String(maxCacheSize)}`
            );
        }
        this.__maxCacheSize = maxCacheSize !== undefined ? maxCacheSize : DEFAULT_MAX_CACHE_SIZE;

        // The engines map is immutable after construction: normalize and sort the
        // entries once (longest raw prefix first, matching the previous per-call
        // sort) instead of re-sorting on every resolve().
        this.__engines = Object.entries(enginesOverride || {})
            .sort((a, b) => b[0].length - a[0].length)
            .map(([prefix, version]) => [prefix.replace(/\/+$/, ''), Number(version)]);

        // LRU cache: canonical mount path (no trailing slash) -> { mount, version, type }.
        // Map iteration order is insertion order; hits are re-inserted to refresh
        // recency, and inserts evict the oldest entries beyond __maxCacheSize.
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
     * Longest-prefix match against the engines entries precomputed (normalized
     * and sorted longest-first) in the constructor.
     * Returns { mount, version } or null if no match found.
     */
    __enginesOverrideLookup(path) {
        for (const [prefix, version] of this.__engines) {
            if (path === prefix || path.startsWith(prefix + '/')) {
                return { mount: prefix, version, type: 'kv' };
            }
        }
        return null;
    }

    /**
     * Find the cached entry whose canonical mount is a segment-boundary prefix
     * of the path. Vault forbids nested mounts, so at most one entry can match;
     * the path's segment prefixes are probed deepest-first as exact keys
     * (O(path depth) instead of a scan over the whole cache). A hit is
     * re-inserted to refresh its LRU recency.
     */
    __cacheLookup(path) {
        let candidate = path;
        while (candidate !== '') {
            const entry = this.__cache.get(candidate);
            if (entry !== undefined) {
                this.__cache.delete(candidate);
                this.__cache.set(candidate, entry);
                return entry;
            }
            const slash = candidate.lastIndexOf('/');
            candidate = slash === -1 ? '' : candidate.slice(0, slash);
        }
        return null;
    }

    /**
     * Insert (or refresh) a cache entry, evicting the least-recently-used
     * entries once the cap is exceeded.
     */
    __cacheStore(canonicalMount, entry) {
        this.__cache.delete(canonicalMount);
        this.__cache.set(canonicalMount, entry);
        while (this.__cache.size > this.__maxCacheSize) {
            this.__cache.delete(this.__cache.keys().next().value);
        }
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
        const cached = this.__cacheLookup(path);
        if (cached !== null) {
            return Promise.resolve(cached);
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
                const version = (type === 'kv' && optVersion === '2') ? 2 : 1;

                const entry = { mount: canonicalMount, version, type };
                this.__log.debug('MountResolver: detected %s as type=%s version=%d', canonicalMount, type, version);

                // Store in persistent cache (bounded LRU)
                this.__cacheStore(canonicalMount, entry);
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
