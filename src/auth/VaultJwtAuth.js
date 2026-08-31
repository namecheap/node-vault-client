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
     * @param {Function} [config.jwtProvider] - (optionally async) function resolving to the JWT.
     *   Accepted here as a mutually exclusive source (#132); not yet consumed by `_authenticate`.
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

        this.__role = config.role;
        this.__jwt = config.jwt;
        this.__jwtPath = config.jwtPath;
        this.__jwtProvider = config.jwtProvider;
    }

    _authenticate() {
        let jwt;
        let source;
        if (this.__jwt !== undefined) {
            jwt = this.__jwt;
            source = 'literal';
        } else {
            jwt = fs.readFileSync(this.__jwtPath).toString();
            source = 'file';
        }

        this._log.info(
            'making authentication request: Vault role: "%s"; JWT source: %s (%d bytes)',
            this.__role !== undefined ? this.__role : '(default_role)', source, jwt.length
        );

        const body = { jwt };
        if (this.__role !== undefined) {
            body.role = this.__role;
        }

        return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, body)
            .then((res) => {
                this._log.debug('received Vault client token from JWT login');

                return this._getTokenEntity(res.auth.client_token);
            });
    }
}

module.exports = VaultJwtAuth;
