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
        this.__authData = {
            client_token: null,
            lease_duration: 0,
            expires_at: 0,
        };
    }

    getAuthToken() {
        let authToken = this.__authData.client_token;

        if (!authToken || (this.__authData.expires_at !== 0 && this.__authData.expires_at <= Date.now())) {
            return this.__apiClient.makeRequest('POST', '/auth/approle/login', {
                role_id: this.__roleId,
                secret_id: this.__secretId,
            }).then(res => {
                this.__authData.client_token = res.auth.client_token;
                this.__authData.lease_duration = res.auth.lease_duration * 1000;
                this.__authData.expires_at = this.__authData.lease_duration === 0 ? 0 : Date.now() + this.__authData.lease_duration - 60000;

                return this.__authData.client_token;
            });
        }

        return Promise.resolve(authToken);
    }

}

module.exports = VaultAppRoleAuth;
