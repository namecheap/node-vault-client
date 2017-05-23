'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');

class VaultAppRoleAuth extends VaultBaseAuth {

    /**
     *
     * @param {VaultApiClient} apiClient - see {@link VaultBaseAuth#constructor}
     * @param {Object} config
     * @param {String} config.role_id - RoleID of the AppRole.
     * @param {String} [config.secret_id] - required when bind_secret_id is enabled SecretID belonging to AppRole.
     */
    constructor(apiClient, config) {
        super(apiClient);

        this.__roleId = config.role_id;
        this.__secretId = config.secret_id;
    }

    _authenticate() {
        return this.__apiClient.makeRequest('POST', '/auth/approle/login', {
            role_id: this.__roleId,
            secret_id: this.__secretId,
        }).then(res => {
            return this._getTokenEntity(res.auth.client_token);
        });
    }

}

module.exports = VaultAppRoleAuth;
