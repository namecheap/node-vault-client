'use strict';

const path = require('path');
const fs = require('fs');
const Bluebird = require('bluebird');
const _ = require('lodash');
const assignDeep = require('assign-deep');

const errors = require('./errors');

class VaultNodeConfig {

    constructor(vault) {
        this.__vault = vault;

        try {
            require.resolve('config');
        } catch(e) {
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
            const splitRes = val.split('#');
            const path = splitRes[0], value = splitRes[1];
            if (path === undefined || value === undefined) {
                throw new errors.InvalidArgumentsError('Invalid format of substitution value');
            }

            requiredData[path] = null;
        });

        let promises = _.mapValues(requiredData, (value, path) => this.__vault.read(path));

        return Bluebird.props(promises).then(results => {
            requiredData = _.mapValues(requiredData, (value, path) => results[path].getData());

            this.__traverse(substitutionMap, (key, val, obj) => {
                const splitRes = val.split('#');
                const path = splitRes[0], value = splitRes[1];
                const res = requiredData[path][value];
                if (res === undefined) {
                    throw new errors.VaultError(`Can't find substitution for "${val}"`);
                }

                obj[key] = requiredData[path][value];
            });

            return assignDeep(this.__nodeConfig, substitutionMap);
        });
    }

    /**
     * @private
     */
    __getSubstitutionMap() {
        let config_dir = this.__nodeConfig.util.initParam('NODE_CONFIG_DIR', path.join( process.cwd(), 'config') );
        if (config_dir.indexOf('.') === 0) {
            config_dir = path.join(process.cwd() , config_dir);
        }

        const fullFilename = path.join(config_dir, 'custom-vault-variables.js');

        let fileContent;
        try {
            fileContent = require(fullFilename);
        } catch (e) {
            throw new errors.VaultError('Config file ' + fullFilename + ' cannot be read');
        }

        if (!_.isPlainObject(fileContent)) {
            throw new errors.VaultError('Config file ' + fullFilename + ' should return plain object');
        }

        return _.cloneDeep(fileContent);
    }

    __traverse(o, func) {
        for (let i in o) {
            if (!o.hasOwnProperty(i)) {
                continue;
            }

            if (o[i] !== null && typeof(o[i]) === "object") {
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
