'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');

class VaultAppRoleAuth extends VaultBaseAuth {

    /**
     *
     * @param {VaultApiClient} apiClient - see {@link VaultBaseAuth#constructor}
     * @param {Object} config
     * @param {String} config.role_id - RoleID of the AppRole.
     * @param {String} [config.secret_id] - required when bind_secret_id is enabled SecretID belonging to AppRole.
     * @param {String} mount - Vault's  mount point ("approle" by default)
     */
    constructor(apiClient, logger, config, mount = 'approle') {
        super(apiClient, logger, mount);

        this.__roleId = config.role_id;
        this.__secretId = config.secret_id;
    }

    _authenticate() {
        return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, {
            role_id: this.__roleId,
            secret_id: this.__secretId,
        }).then(res => {
            return this._getTokenEntity(res.auth.client_token);
        });
    }

}

module.exports = VaultAppRoleAuth;
