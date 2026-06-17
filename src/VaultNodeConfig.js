'use strict';

const path = require('path');

const errors = require('./errors');

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
    if (!isObject(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}

// Keys that must never be merged, to avoid prototype pollution.
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively merges own enumerable properties of `source` into `target`,
 * mutating and returning `target`. Nested objects and arrays are merged in
 * place, other values overwrite, and `undefined` source values are skipped.
 * Prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are
 * skipped. Covers the subset of `lodash.merge` behavior this client relies on.
 */
function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (FORBIDDEN_MERGE_KEYS.has(key)) {
            continue;
        }

        const sourceValue = source[key];
        if (sourceValue === undefined) {
            continue;
        }

        const targetValue = target[key];
        if (isObject(sourceValue) && isObject(targetValue)) {
            deepMerge(targetValue, sourceValue);
        } else if (isObject(sourceValue)) {
            target[key] = structuredClone(sourceValue);
        } else {
            target[key] = sourceValue;
        }
    }

    return target;
}

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
            requiredData = Object.fromEntries(
                vaultPaths.map((vaultPath, index) => [vaultPath, leases[index].getData()])
            );

            this.__traverse(substitutionMap, (key, val, obj) => {
                const { vaultPath, value } = this.__parseSubstitutionValue(val);
                const res = requiredData[vaultPath][value];
                if (res === undefined) {
                    throw new errors.VaultError(`Can't find substitution for "${val}"`);
                }

                obj[key] = requiredData[vaultPath][value];
            });

            return deepMerge(this.__nodeConfig, substitutionMap);
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

        if (!isPlainObject(fileContent)) {
            throw new errors.VaultError('Config file ' + fullFilename + ' should return plain object');
        }

        return structuredClone(fileContent);
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
