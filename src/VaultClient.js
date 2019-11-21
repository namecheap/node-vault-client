'use strict';

const _ = require('lodash');
const Lease = require('./Lease');
const errors = require('./errors');
const VaultApiClient = require('./VaultApiClient');
const VaultAppRoleAuth = require('./auth/VaultAppRoleAuth');
const VaultTokenAuth = require('./auth/VaultTokenAuth');
const VaultIAMAuth = require('./auth/VaultIAMAuth');
const VaultNodeConfig = require('./VaultNodeConfig');
const VaultKubernetesAuth = require('./auth/VaultKubernetesAuth');
const vaultInstances = {};

class VaultClient {

    /**
     * Client constructor function.
     *
     * @param {Object} options
     * @param {Object} options.api
     * @param {String} options.api.url - the url of the vault server
     * @param {String} [options.api.apiVersion='v1']
     * @param {Object} options.auth
     * @param {String} options.auth.type
     * @param {Object} options.auth.config - auth configuration variables
     * @param {Object|false} options.logger - Logger that supports "error", "info", "warn", "trace", "debug" methods. Uses `console` by default. Pass `false` to disable logging.
     */
    constructor(options) {
        this.__log = this.__setupLogger(options.logger);

        this.__api = new VaultApiClient(
            options.api,
            this.__log
        );

        /**
         * @type {VaultBaseAuth}
         * @private
         */
        this.__auth = this.__getAuthProvider(
            options.auth,
            this.__api
        );
    }

    /**
     * Boot an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.boot multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name - Vault instance name
     * @param {Object} [options] - options for {@link Vault#constructor}.
     * @return Vault
     */
    static boot(name, options) {
        if (options === undefined) {
            throw new errors.InvalidArgumentsError('Options should be provided');
        }

        let instance = vaultInstances[name];
        if (instance === undefined) {
            vaultInstances[name] = instance = new VaultClient(options);

            return instance;
        }

        throw new errors.InvalidArgumentsError('Instance with such name already booted');
    }

    /**
     * Get an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.pop multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name - Vault instance name
     * @return Vault
     */
    static get(name) {
        let instance = vaultInstances[name];

        if (instance === undefined) {
            throw new errors.InvalidArgumentsError('Invalid instance name');
        }

        return instance;
    }

    /**
     * Clear named Vault instance
     *
     * If no name passed all named instances will be cleared.
     *
     * @param {String} [name] - Vault instance name, all instances will be cleared if no name were passed
     */
    static clear(name) {
        if (typeof name === 'string') {
            delete vaultInstances[name];
        } else {
            for (let k in vaultInstances) {
                if (vaultInstances.hasOwnProperty(k)) {
                    delete vaultInstances[k];
                }
            }
        }
    }

    /**
     * @protected
     *
     * @param {Object} authConfig
     * @param {string} authConfig.type
     * @param {string} authConfig.mount
     * @param {Object} authConfig.config
     * @param {VaultApiClient} api
     * @return {VaultBaseAuth}
     * @private
     */
    __getAuthProvider(authConfig, api) {
        this.__log.debug('creating vault auth method: "%s"', authConfig.type);

        switch (authConfig.type) {
            case 'iam':
                return new VaultIAMAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'appRole':
                return new VaultAppRoleAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'token':
                return new VaultTokenAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
            case 'kubernetes':
                return new VaultKubernetesAuth(
                    api,
                    this.__log,
                    authConfig.config,
                    authConfig.mount
                );
        }

        throw new errors.InvalidArgumentsError('Unsupported auth method')
    }

    /**
     * Populates Vault's values to NPM "config" module
     */
    fillNodeConfig() {
        const vaultConf = new VaultNodeConfig(this);

        return vaultConf.populate();
    }

    /**
     * Read secret from Vault
     * @param {string} path - path to the secret
     * @returns {Promise<Lease>}
     */
    read(path) {
        this.__log.debug('read secret %s', path);
        return this.__auth.getAuthToken()
            .then(token => this.__api.makeRequest('GET', path, null, {'X-Vault-Token': token.getId()}))
            .then(res => {
                this.__log.debug('receive secret %s', path);
                return Lease.fromResponse(res);
            })
            .catch((reason) => {
                this.__log.error('read secret failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Retrieves secrets list
     *
     * @param {string} path - path to the secret
     * @returns {Promise<Lease>}
     */
    list(path) {
        this.__log.debug('list secrets %s', path);
        return this.__auth.getAuthToken()
            .then(token => this.__api.makeRequest('LIST', path, null, {'X-Vault-Token': token.getId()}))
            .then(res => {
                this.__log.debug('got secrets list %s', path);
                return Lease.fromResponse(res);
            })
            .catch((reason) => {
                this.__log.error('list secrets failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * Writes data to Vault
     *
     * @param path - path used to write data
     * @param {object} data - data to write
     * @returns {Promise<T | never>}
     */
    write(path, data) {
        this.__log.debug('write secret %s', path);
        return this.__auth.getAuthToken()
            .then((token) => this.__api.makeRequest('POST', path, data, {'X-Vault-Token': token.getId()}))
            .then((response) => {
                this.__log.debug('secret %s was written', path);
                return response;
            })
            .catch((reason) => {
                this.__log.error('write secret failed: %s', reason.message);
                throw reason;
            });
    }

    /**
     * @private
     */
    __setupLogger(logger) {
        if (logger === false) {
            return {
                error: _.noop,
                warn: _.noop,
                info: _.noop,
                debug: _.noop,
                trace: _.noop,
            }
        } else if (_.intersection(_.functionsIn(logger), ['error', 'warn', 'info', 'debug', 'trace']).length >= 5) {
            return logger
        } else {
            return {
                error: console.error,
                warn: console.warn,
                info: console.info,
                trace: console.trace,
                // avoid output sensitive information
                debug: _.noop
            };
        }
    }
}

module.exports = VaultClient;
