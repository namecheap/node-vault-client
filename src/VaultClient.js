'use strict';

const _ = require('lodash');
const Lease = require('./Lease');
const errors = require('./errors');
const VaultApiClient = require('./VaultApiClient');
const VaultAppRoleAuth = require('./auth/VaultAppRoleAuth');
const VaultTokenAuth = require('./auth/VaultTokenAuth');
const VaultIAMAuth = require('./auth/VaultIAMAuth');
const VaultNodeConfig = require('./VaultNodeConfig');
const vaultInstances = {};

class Vault {

    /**
     * Client constructor function.
     * @param {Object} options
     * @param {Object} options.api
     * @param {String} options.api.url - the url of the vault server
     * @param {String} [options.api.apiVersion='v1']
     * @param {Object} options.auth
     * @param {String} options.auth.type
     * @param {Object} options.auth.config - auth configuration variables
     * @param {Object|false} options.logger - RFC 5424 compatible logger. Pass `false` to disable logging.
     */
    constructor(options) {
        this.loggerFactory = this.__setupLogger(options.logger);

        this.__log = this.loggerFactory(); // this.__setupLogger(options.logger);

        this.__api = new VaultApiClient(
            options.api,
            {logger: this.loggerFactory('api')}
        );

        /** @type {VaultBaseAuth} */
        this.__auth = this.getAuthProvider(
            options.auth,
            this.__api,
            this.__log
        );
    }

    /**
     * Boot an instance of Vault
     *
     * The instance will be stored in a local hash. Calling Vault.boot multiple
     * times with the same name will return the same instance.
     *
     * @param {String} name
     * @param {Object} [options] - options for {@link Vault#constructor}.
     * @return Vault
     */
    static boot(name, options) {
        if (options === undefined) {
            throw new errors.InvalidArgumentsError('Options should be provided');
        }

        let instance = vaultInstances[name];
        if (instance === undefined) {
            vaultInstances[name] = instance = new Vault(options);

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
     * @param {String} name
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
     * @param {String} [name]
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
     * @param {Object|false} logger
     * @return {VaultBaseAuth}
     */
    getAuthProvider(authConfig, api, logger) {
        logger.debug('creating vault auth method: "%s"', authConfig.type);

        const authLogger = this.loggerFactory('auth');

        switch (authConfig.type) {
            case 'aws_iam':
            case 'iam':
                if (authConfig.type === 'iam') {
                    logger.notice(
                        'DEPRECATION: auth type "%s" is deprecated, use "%s" instead',
                        'iam',
                        'aws_iam'
                    );
                }

                return new VaultIAMAuth(
                    api,
                    authLogger,
                    authConfig.config,
                    authConfig.mount
                );
            case 'approle':
            case 'appRole':
                if (authConfig.type === 'appRole') {
                    logger.notice(
                        'DEPRECATION: auth type "%s" is deprecated, use "%s" instead',
                        'appRole',
                        'approle'
                    );
                }

                return new VaultAppRoleAuth(
                    api,
                    authLogger,
                    authConfig.config,
                    authConfig.mount
                );
            case 'token':
                return new VaultTokenAuth(
                    api,
                    authLogger,
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

    read(path) {
        this.__log.debug('read secret %s', path);
        return this.__auth.getAuthToken().then(token => {
            return this.__api.makeRequest('GET', path, null, {'X-Vault-Token': token.getId()});
        }).then(res => {
            this.__log.debug('receive secret %s', path);
            return Lease.fromResponse(res);
        });
    }

    write(path, data) {
        this.__log.debug('write secret %s', path);
        return this.__auth.getAuthToken().then(token => {
            return this.__api.makeRequest('POST', path, data, {'X-Vault-Token': token.getId()});
        }).then(() => {
            this.__log.debug('secret %s was written', path)
        });
    }

    __setupLogger(logger) {
        const rfc5424 = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

        if (logger === false) {
            const nullLogger = _.fromPairs(_.map(rfc5424, (level) => [level, _.noop]));
            return () => nullLogger;
        }

        if (_.isFunction(logger)) {
            return logger;
        }

        if (_.intersection(_.functionsIn(logger), rfc5424).length >= rfc5424.length) {
            return () => logger
        }

        function legacyMapper(logger) {
            return {
                emergency: logger.error,
                alert: logger.error,
                critical: logger.error,
                error: logger.error,
                warning: logger.warn,
                notice: logger.info,
                info: logger.info,
                debug: logger.debug
            }
        }

        if (_.intersection(_.functionsIn(logger), ['error', 'warn', 'info', 'debug', 'trace']).length >= 5) {
            const legacy = legacyMapper(logger);
            legacy.notice(
                'DEPRECATION: use logger that support methods according with to RFC 5424'
            );
            return () => legacy;
        }

        return () => legacyMapper(logger);
    }
}

module.exports = Vault;
