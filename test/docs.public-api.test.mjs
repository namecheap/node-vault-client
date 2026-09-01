import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import VaultClient from '../src/VaultClient.js';
import Lease from '../src/Lease.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// getHeaders is called only from inside VaultClient and takes an AuthToken, which the
// entry point does not export, so a consumer cannot call it.
const NOT_PUBLIC_SURFACE = ['getHeaders'];

function publicMethods(klass) {
    return Object.getOwnPropertyNames(klass.prototype)
        .filter((name) => name !== 'constructor' && !name.startsWith('__'));
}

function leaseSection() {
    const heading = '### Lease';
    const rest = README.slice(README.indexOf(heading) + heading.length);
    const next = rest.search(/^#{1,3} /m);

    return next === -1 ? rest : rest.slice(0, next);
}

describe('public API documentation', function () {
    it('gives every VaultClient instance method a README heading', function () {
        for (const name of publicMethods(VaultClient)) {
            if (NOT_PUBLIC_SURFACE.includes(name)) {
                continue;
            }

            expect(README, `vaultClient.${name}() has no "#### vaultClient.${name}(" heading`)
                .to.contain(`#### vaultClient.${name}(`);
        }
    });

    it('gives every VaultClient static method a README heading', function () {
        const statics = Object.getOwnPropertyNames(VaultClient)
            .filter((name) => typeof VaultClient[name] === 'function');

        for (const name of statics) {
            expect(README, `VaultClient.${name}() has no "#### VaultClient.${name}(" heading`)
                .to.contain(`#### VaultClient.${name}(`);
        }
    });

    it('lists every Lease accessor in the Lease section', function () {
        const section = leaseSection();

        for (const name of publicMethods(Lease)) {
            expect(section, `Lease.${name}() is missing from the "### Lease" section`)
                .to.contain(name);
        }
    });
});
