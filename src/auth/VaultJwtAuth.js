'use strict';

const fs = require('fs');
const VaultBaseAuth = require('./VaultBaseAuth');
const errors = require('../errors');
const safeMessage = require('../safeMessage');

const JWT_SOURCE_KEYS = ['jwt', 'jwtPath', 'jwtProvider'];

/**
 * Normalizes an optional access token: surrounding whitespace (a trailing newline from a file or
 * an env var) is dropped, and anything that is not a non-empty string afterwards is `undefined`.
 *
 * @param {*} value
 * @returns {String|undefined}
 */
function normalizeAccessToken(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

class VaultJwtAuth extends VaultBaseAuth {
    // Private fields rather than `__` properties: util.inspect / console.log / JSON.stringify of
    // the client never show them, so neither credential leaks through a logged object.
    #jwt;
    #distributedClaimAccessToken;

    /**
     * @param {VaultApiClient} apiClient - see {@link VaultBaseAuth#constructor}
     * @param {Object} logger
     * @param {Object} config
     * @param {String} [config.role] - Role configured in Vault's JWT auth backend. Optional;
     *   when omitted, Vault falls back to the mount's configured `default_role`.
     * @param {String} [config.jwt] - A literal JWT to present at login. Exactly one of
     *   `jwt` / `jwtPath` / `jwtProvider` must be provided.
     * @param {String} [config.jwtPath] - Path to a file containing the JWT. Re-read on every
     *   login (like {@link VaultKubernetesAuth}'s `tokenPath`), so a rotated token is picked up.
     * @param {Function} [config.jwtProvider] - (optionally async) function invoked at login time,
     *   returning `string | Promise<string>`. Called fresh on every login (never at construction
     *   or cached across logins) so it can mint a short-lived token -- the shape GitHub Actions'
     *   `core.getIDToken()`, cloud metadata endpoints and SPIFFE workloads need.
     * @param {String} [config.distributedClaimAccessToken] - A literal Microsoft Graph access token
     *   forwarded to Vault as `distributed_claim_access_token`. Only the Azure (Entra ID) provider
     *   uses it: when the role sets `groups_claim` and Vault has to fetch group membership from
     *   Graph (Azure sent distributed claims, or the mount's `provider_config` sets
     *   `fetch_groups`). Fixed at construction, so every re-login replays it; prefer the provider
     *   in a long-running process. `undefined` means "not sent"; any other value must be a
     *   non-empty string. Mutually exclusive with `distributedClaimAccessTokenProvider`.
     * @param {Function} [config.distributedClaimAccessTokenProvider] - (optionally async) function
     *   invoked at login time, returning `string | Promise<string>`. Called fresh on every login
     *   (never at construction or cached across logins) because Graph access tokens are short-lived.
     *   It runs concurrently with the JWT source. Mutually exclusive with
     *   `distributedClaimAccessToken`.
     * @param {String} [config.namespace] - Optional. Vault namespace. Applied as the X-Vault-Namespace
     *   header to every request by {@link VaultApiClient}; see {@link VaultClient#constructor}.
     * @param {String} mount - Vault's mount point ("jwt" by default)
     */
    constructor(apiClient, logger, config, mount) {
        super(apiClient, logger, mount || 'jwt');

        const providedSources = JWT_SOURCE_KEYS.filter((key) => config && config[key] !== undefined);
        if (providedSources.length !== 1) {
            throw new errors.InvalidArgumentsError(
                'Exactly one of "jwt", "jwtPath" or "jwtProvider" should be provided for VaultJwtAuth'
            );
        }
        if (config.jwtProvider !== undefined && typeof config.jwtProvider !== 'function') {
            throw new errors.InvalidArgumentsError('"jwtProvider" should be a function for VaultJwtAuth');
        }
        if (config.distributedClaimAccessToken !== undefined
            && config.distributedClaimAccessTokenProvider !== undefined) {
            throw new errors.InvalidArgumentsError(
                'Only one of "distributedClaimAccessToken" or "distributedClaimAccessTokenProvider"'
                + ' should be provided for VaultJwtAuth'
            );
        }
        // An empty or non-string literal would be sent as-is and fail later, at Vault's
        // group-fetch step, with an error that does not mention this option.
        if (config.distributedClaimAccessToken !== undefined
            && normalizeAccessToken(config.distributedClaimAccessToken) === undefined) {
            throw new errors.InvalidArgumentsError(
                '"distributedClaimAccessToken" should be a non-empty string for VaultJwtAuth'
            );
        }
        if (config.distributedClaimAccessTokenProvider !== undefined
            && typeof config.distributedClaimAccessTokenProvider !== 'function') {
            throw new errors.InvalidArgumentsError(
                '"distributedClaimAccessTokenProvider" should be a function for VaultJwtAuth'
            );
        }

        this.__role = config.role;
        this.#jwt = config.jwt;
        this.__jwtPath = config.jwtPath;
        this.__jwtProvider = config.jwtProvider;
        this.#distributedClaimAccessToken = normalizeAccessToken(config.distributedClaimAccessToken);
        this.__distributedClaimAccessTokenProvider = config.distributedClaimAccessTokenProvider;
    }

    _authenticate() {
        // Both credentials are independent and usually network-bound (IdP, IMDS, MSAL), so they
        // are acquired concurrently: login latency is the slower of the two rather than their
        // sum, and the JWT does not age while the Graph token is fetched.
        //
        // A failed JWT source rejects the login at once, as it did when the two ran in turn, so a
        // Graph provider that hangs cannot hold up that error. A failed access token instead waits
        // for the JWT source, so the JWT source's error is the one raised whenever both fail. The
        // Graph provider is not cancelled: if it fails after the login already rejected, its
        // failure is still logged, and its rejection is handled here.
        const jwtPromise = this.__acquireJwt();
        const claimPromise = this.__acquireDistributedClaimAccessToken()
            .catch((claimErr) => jwtPromise.then(() => { throw claimErr; }));

        return Promise.all([jwtPromise, claimPromise])
            .then(([{ jwt, source }, distributedClaim]) => {
                this._log.info(
                    'making authentication request: Vault role: "%s"; JWT source: %s (%d bytes);'
                    + ' distributed claim access token: %s',
                    this.__role !== undefined ? this.__role : '(default_role)', source, jwt.length,
                    distributedClaim === undefined ? 'none' : distributedClaim.source
                );

                const body = { jwt };
                if (this.__role !== undefined) {
                    body.role = this.__role;
                }
                if (distributedClaim !== undefined) {
                    body.distributed_claim_access_token = distributedClaim.accessToken;
                }

                return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, body);
            })
            .then((res) => {
                this._log.debug('received Vault client token from JWT login');

                return this._getTokenEntity(res.auth.client_token);
            });
    }

    /**
     * @returns {Promise<{jwt: String, source: String}>}
     * @private
     */
    __acquireJwt() {
        if (this.#jwt !== undefined) {
            return Promise.resolve({ jwt: this.#jwt, source: 'literal' });
        }
        if (this.__jwtPath !== undefined) {
            return Promise.resolve()
                .then(() => ({ jwt: fs.readFileSync(this.__jwtPath).toString(), source: 'file' }));
        }

        return this.__callStringProvider(this.__jwtProvider, 'jwtProvider', 'JWT')
            .then((jwt) => ({ jwt, source: 'provider' }));
    }

    /**
     * Resolves to `undefined` when neither option is configured, so that the login body stays
     * byte-identical to what it was before this option existed.
     *
     * @returns {Promise<undefined|{accessToken: String, source: String}>}
     * @private
     */
    __acquireDistributedClaimAccessToken() {
        if (this.#distributedClaimAccessToken !== undefined) {
            return Promise.resolve({ accessToken: this.#distributedClaimAccessToken, source: 'literal' });
        }
        if (this.__distributedClaimAccessTokenProvider === undefined) {
            return Promise.resolve(undefined);
        }

        return this.__callStringProvider(
            this.__distributedClaimAccessTokenProvider, 'distributedClaimAccessTokenProvider', 'access token'
        ).then((accessToken) => {
            const normalized = normalizeAccessToken(accessToken);
            if (normalized === undefined) {
                throw new errors.InvalidArgumentsError(
                    '"distributedClaimAccessTokenProvider" must resolve to a non-empty access token string'
                );
            }
            return { accessToken: normalized, source: 'provider' };
        });
    }

    /**
     * Calls a user-supplied credential provider. Wrapping in Promise.resolve().then() normalizes
     * both a sync provider (plain return) and a synchronous throw into the same rejection path as
     * an async one. A provider failure is rethrown unchanged, after logging which provider it was:
     * both are often backed by the same metadata endpoint, so the bare error does not say.
     *
     * @param {Function} provider
     * @param {String} name - config key, used in messages
     * @param {String} what - what the provider resolves to, used in messages
     * @returns {Promise<String>}
     * @private
     */
    __callStringProvider(provider, name, what) {
        return Promise.resolve().then(() => provider()).then(
            (value) => {
                if (typeof value !== 'string' || value.length === 0) {
                    throw new errors.InvalidArgumentsError(`"${name}" must resolve to a non-empty ${what} string`);
                }
                return value;
            },
            (err) => {
                this._log.error('JWT login aborted: "%s" failed: %s', name, safeMessage(err));
                throw err;
            }
        );
    }
}

module.exports = VaultJwtAuth;
