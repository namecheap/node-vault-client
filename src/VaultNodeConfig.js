const path = require('path');
const Bluebird = require('bluebird');
const _ = require('lodash');
const assignDeep = require('assign-deep');

const VaultError = require('./errors/vault.error');
const InvalidArgumentsError = require('./errors/invalid.arguments.error');

class VaultNodeConfig {
    constructor(vault) {
        this.__vault = vault;

        try {
            require.resolve('config');
        } catch (e) {
            throw new VaultError('NPM package "config" isn\'t installed');
        }

        this.__nodeConfig = require('config');
    }

    /**
     * Populates Vault's values to "node-config"
     */
    populate() {
        const substitutionMap = this.__getSubstitutionMap();
        let requiredData = {};

        this.__traverse(substitutionMap, (key, val) => {
            const splitRes = val.split('#');
            const pathToFile = splitRes[0]; const
                value = splitRes[1];
            if (pathToFile === undefined || value === undefined) {
                throw new InvalidArgumentsError('Invalid format of substitution value');
            }

            requiredData[pathToFile] = null;
        });

        const promises = _.mapValues(requiredData, (value, pathConf) => this.__vault.read(pathConf));

        return Bluebird.props(promises).then((results) => {
            requiredData = _.mapValues(requiredData, (value, pathToFile) => results[pathToFile].getData());

            this.__traverse(substitutionMap, (key, val, obj) => {
                const splitRes = val.split('#');
                const pathToFile = splitRes[0]; const
                    value = splitRes[1];
                const res = requiredData[pathToFile][value];
                if (res === undefined) {
                    throw new VaultError(`Can't find substitution for "${val}"`);
                }

                obj[key] = requiredData[pathToFile][value];
            });

            return assignDeep(this.__nodeConfig, substitutionMap);
        });
    }

    /**
     * @private
     */
    __getSubstitutionMap() {
        let configDir = this.__nodeConfig.util.initParam('NODE_CONFIG_DIR', path.join(process.cwd(), 'config'));
        if (configDir.indexOf('.') === 0) {
            configDir = path.join(process.cwd(), configDir);
        }

        const fullFilename = path.join(configDir, 'custom-vault-variables.js');

        let fileContent;
        try {
            fileContent = require(fullFilename);
        } catch (e) {
            throw new VaultError(`Config file ${fullFilename} cannot be read`);
        }

        if (!_.isPlainObject(fileContent)) {
            throw new VaultError(`Config file ${fullFilename} should return plain object`);
        }

        return _.cloneDeep(fileContent);
    }

    __traverse(o, func) {
        for (const i in o) {
            if (!o.hasOwnProperty(i)) {
                continue;
            }

            if (o[i] !== null && typeof (o[i]) === 'object') {
                // going one step down in the object tree!!
                this.__traverse(o[i], func);
            } else if (typeof o[i] === 'string') {
                func(i, o[i], o);
            } else {
                throw new InvalidArgumentsError('Illegal key type for substitution map');
            }
        }
    }
}

module.exports = VaultNodeConfig;
