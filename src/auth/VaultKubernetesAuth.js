const fs = require('fs');
const VaultBaseAuth = require('./VaultBaseAuth');
const errors = require('../errors');

class VaultKubernetesAuth extends VaultBaseAuth {
    /**
     * @param {VaultApiClient} apiClient - see {@link VaultBaseAuth#constructor}
     * @param {Object} logger
     * @param {Object} config
     * @param {String} config.role - Role configured in Vault Kubernetes Auth backend under which we want to issue Vault token.
     * @param {String} [config.tokenPath] - Path to the Kube JWT token. If omitted - default will be used.
     * @param {String} [config.namespace] - Optional. Vault namespace. Applied as the X-Vault-Namespace
     *   header to every request by {@link VaultApiClient}; see {@link VaultClient#constructor}.
     * @param {String} mount - Vault's  mount point ("kubernetes" by default)
     */
    constructor(apiClient, logger, config, mount) {
        super(apiClient, logger, mount || 'kubernetes', config);

        if (!config || !config.role) {
            throw new errors.InvalidArgumentsError('"role" should be provided for VaultKubernetesAuth');
        }

        this.__role = config.role;
        this.__tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
        if (config.tokenPath !== undefined) {
            this.__tokenPath = config.tokenPath;
        }
    }

    _authenticate() {
        this._log.info(
            'making authentication request: Vault role: "%s"; K8s token path: "%s"',
            this.__role, this.__tokenPath
        );

        const k8sJwtToken = fs.readFileSync(this.__tokenPath).toString();
        this._log.debug(
            'read K8s service-account JWT from "%s" (%d bytes)',
            this.__tokenPath, k8sJwtToken.length
        );

        return this.__apiClient.makeRequest('POST', `/auth/${this._mount}/login`, {
            role: this.__role,
            jwt: k8sJwtToken,
        }).then((res) => {
            this._log.debug('received Vault client token from Kubernetes login');

            return this._getTokenEntity(res.auth.client_token);
        });
    }
}

module.exports = VaultKubernetesAuth;
