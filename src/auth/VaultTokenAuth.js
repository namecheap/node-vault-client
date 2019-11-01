const VaultBaseAuth = require('./VaultBaseAuth');
const InvalidArgumentsError = require('../errors/invalid.arguments.error');

class VaultTokenAuth extends VaultBaseAuth {
    /**
     * @param {Object} connConfig - see {@link VaultBaseAuth#constructor}
     * @param {Object} config
     * @param {String} config.token
     * @param {String} mount - Vault's  mount point ("token" by default)
     */
    constructor(connConfig, logger, config, mount) {
        super(connConfig, logger, mount || 'token');

        if (!config.token) {
            throw new InvalidArgumentsError('Auth token should be provided for VaultTokenAuth');
        }

        this.__token = config.token;
    }

    _authenticate() {
        return this._getTokenEntity(this.__token);
    }

    _reauthenticationAllowed() {
        return false;
    }
}

module.exports = VaultTokenAuth;
