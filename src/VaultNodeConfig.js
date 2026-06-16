'use strict';

const path = require('path');
const _ = require('lodash');

const errors = require('./errors');

class VaultNodeConfig {

    constructor(vault) {
        this.__vault = vault;

        try {
            require.resolve('config');
        } catch {
            throw new errors.VaultError(`NPM package "config" isn't installed`);
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
            const { vaultPath } = this.__parseSubstitutionValue(val);
            requiredData[vaultPath] = null;
        });

        const vaultPaths = Object.keys(requiredData);

        return Promise.all(vaultPaths.map((vaultPath) => this.__vault.read(vaultPath))).then((leases) => {
            const results = _.zipObject(vaultPaths, leases);
            requiredData = _.mapValues(requiredData, (value, vaultPath) => results[vaultPath].getData());

            this.__traverse(substitutionMap, (key, val, obj) => {
                const { vaultPath, value } = this.__parseSubstitutionValue(val);
                const res = requiredData[vaultPath][value];
                if (res === undefined) {
                    throw new errors.VaultError(`Can't find substitution for "${val}"`);
                }

                obj[key] = requiredData[vaultPath][value];
            });

            return _.merge(this.__nodeConfig, substitutionMap);
        });
    }

    /**
     * Splits a substitution value of the form "<vaultPath>#<value>".
     *
     * @private
     */
    __parseSubstitutionValue(val) {
        const [vaultPath, value] = val.split('#');
        if (!vaultPath || !value) {
            throw new errors.InvalidArgumentsError('Invalid format of substitution value');
        }

        return { vaultPath, value };
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
        } catch {
            throw new errors.VaultError('Config file ' + fullFilename + ' cannot be read');
        }

        if (!_.isPlainObject(fileContent)) {
            throw new errors.VaultError('Config file ' + fullFilename + ' should return plain object');
        }

        return _.cloneDeep(fileContent);
    }

    __traverse(o, func) {
        for (const i of Object.keys(o)) {
            if (o[i] !== null && typeof o[i] === 'object') {
                //going one step down in the object tree!!
                this.__traverse(o[i], func);
            } else if (typeof o[i] === 'string') {
                func(i, o[i], o);
            } else {
                throw new errors.InvalidArgumentsError('Illegal key type for substitution map');
            }
        }
    }
}

module.exports = VaultNodeConfig;
