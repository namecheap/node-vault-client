'use strict';

const fs = require('fs');
const VaultBaseAuth = require('./VaultBaseAuth');
const errors = require('../errors');

const JWT_SOURCE_KEYS = ['jwt', 'jwtPath', 'jwtProvider'];

class VaultJwtAuth extends VaultBaseAuth {
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
     * @param {String} [config.distributedClaimAccessToken] - A literal OAuth access token forwarded
     *   to Vault as `distributed_claim_access_token`. Azure/Entra roles with `fetch_groups` enabled
     *   need it so Vault can resolve the distributed group-membership claim against the Microsoft
     *   Graph API. Optional, and mutually exclusive with `distributedClaimAccessTokenProvider`.
     * @param {Function} [config.distributedClaimAccessTokenProvider] - (optionally async) function
     *   invoked at login time, returning `string | Promise<string>`. Called fresh on every login
     *   (never at construction or cached across logins) because Graph access tokens are short-lived
     *   and are usually acquired next to the JWT itself. Mutually exclusive with
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
        if (config.distributedClaimAccessTokenProvider !== undefined
            && typeof config.distributedClaimAccessTokenProvider !== 'function') {
            throw new errors.InvalidArgumentsError(
                '"distributedClaimAccessTokenProvider" should be a function for VaultJwtAuth'
            );
        }

        this.__role = config.role;
        this.__jwt = config.jwt;
        this.__jwtPath = config.jwtPath;
        this.__jwtProvider = config.jwtProvider;
        this.__distributedClaimAccessToken = config.distributedClaimAccessToken;
        this.__distributedClaimAccessTokenProvider = config.distributedClaimAccessTokenProvider;
    }

    _authenticate() {
        return Promise.resolve()
            .then(() => this.__acquireJwt())
            .then(({ jwt, source }) => Promise.resolve()
                .then(() => this.__acquireDistributedClaimAccessToken())
                .then((distributedClaim) => {
                    this._log.info(
                        'making authentication request: Vault role: "%s"; JWT source: %s (%d bytes)%s',
                        this.__role !== undefined ? this.__role : '(default_role)', source, jwt.length,
                        distributedClaim === undefined
                            ? ''
                            : `; distributed claim access token: ${distributedClaim.source}`
                    );

                    const body = { jwt };
                    if (this.__role !== undefined) {
                        body.role = this.__role;
                    }
                    if (distributedClaim !== undefined) {
                        body.distributed_claim_access_token = distributedClaim.accessToken;
                    }

                    return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, body)
                        .then((res) => {
                            this._log.debug('received Vault client token from JWT login');

                            return this._getTokenEntity(res.auth.client_token);
                        });
                }));
    }

    /**
     * @returns {{jwt: String, source: String}|Promise<{jwt: String, source: String}>}
     * @private
     */
    __acquireJwt() {
        if (this.__jwt !== undefined) {
            return { jwt: this.__jwt, source: 'literal' };
        }
        if (this.__jwtPath !== undefined) {
            return { jwt: fs.readFileSync(this.__jwtPath).toString(), source: 'file' };
        }

        // Wrapping in Promise.resolve().then() normalizes both a sync provider (plain return)
        // and a synchronous throw into the same rejection path as an async one.
        return Promise.resolve().then(() => this.__jwtProvider()).then((jwt) => {
            if (typeof jwt !== 'string' || jwt.length === 0) {
                throw new errors.InvalidArgumentsError(
                    '"jwtProvider" must resolve to a non-empty JWT string'
                );
            }
            return { jwt, source: 'provider' };
        });
    }

    /**
     * Resolves to `undefined` when neither option is configured, so that the login body stays
     * byte-identical to what it was before this option existed.
     *
     * @returns {undefined|{accessToken: String, source: String}|Promise<{accessToken: String, source: String}>}
     * @private
     */
    __acquireDistributedClaimAccessToken() {
        if (this.__distributedClaimAccessToken !== undefined) {
            return { accessToken: this.__distributedClaimAccessToken, source: 'literal' };
        }
        if (this.__distributedClaimAccessTokenProvider === undefined) {
            return undefined;
        }

        // Wrapping in Promise.resolve().then() normalizes both a sync provider (plain return)
        // and a synchronous throw into the same rejection path as an async one.
        return Promise.resolve().then(() => this.__distributedClaimAccessTokenProvider()).then((accessToken) => {
            if (typeof accessToken !== 'string' || accessToken.length === 0) {
                throw new errors.InvalidArgumentsError(
                    '"distributedClaimAccessTokenProvider" must resolve to a non-empty access token string'
                );
            }
            return { accessToken, source: 'provider' };
        });
    }
}

module.exports = VaultJwtAuth;
