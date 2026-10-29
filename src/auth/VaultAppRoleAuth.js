'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');

class VaultAppRoleAuth extends VaultBaseAuth {

    /**
     * @param {VaultApiClient} apiClient - see {@link VaultBaseAuth#constructor}
     * @param {Object} config
     * @param {String} config.role_id - RoleID of the AppRole.
     * @param {String} [config.secret_id] - required when bind_secret_id is enabled SecretID belonging to AppRole.
     * @param {String} mount - Vault's  mount point ("approle" by default)
     */
    constructor(apiClient, logger, config, mount) {
        super(apiClient, logger, mount || 'approle');

        this.__roleId = config.role_id;
        this.__secretId = config.secret_id;
        this.__namespace = config.namespace;
    }

    _authenticate() {
        // Never log the role_id: for a role with bind_secret_id=false it is the whole login
        // credential (GHSA-x5xf-r8x2-647h).
        this._log.info(
            'making authentication request: approle mount=%s',
            this._mount
        );

        const headers = {};
        if (this.__namespace) {
            headers['X-Vault-Namespace'] = this.__namespace;
        }

        return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, {
            role_id: this.__roleId,
            secret_id: this.__secretId,
        }, headers).then(res => {
            this._log.debug(
                'received token (accessor=%s)',
                res.auth.accessor
            );
            return this._getTokenEntity(res.auth.client_token);
        });
    }

}

module.exports = VaultAppRoleAuth;
