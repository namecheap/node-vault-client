'use strict';

const VaultBaseAuth = require('./VaultBaseAuth');
const errors = require('../errors');

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
            throw new errors.InvalidArgumentsError('Auth token should be provided for VaultTokenAuth');
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
