import deepFreeze from 'deep-freeze';
import { expect } from 'chai';
import VaultClient from '../src/VaultClient.js';

describe('Unit tests', function () {

    const bootOpts = deepFreeze({
        api: { url: 'https://example.com/' },
        logger: false,
        auth: {
            type: 'token',
            config: {
                token: 'XXXXXXXX-eb8e-5f25-fad2-79274fa13a64',
            }
        },
    });

    afterEach(function () {
        VaultClient.clear();
    });

    it('should boot a new VaultClient instance', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        expect(client).to.be.instanceOf(VaultClient);
    });

    it('should return the same instance when booting with the same name', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        const sameClient = VaultClient.boot('primaryClient', bootOpts);
        expect(sameClient).to.equal(client);
    });

    it('should return the booted instance via get', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        expect(VaultClient.get('primaryClient')).to.equal(client);
    });

    it('should clear a client and allow re-creation', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        VaultClient.clear('primaryClient');

        const recreatedClient = VaultClient.boot('primaryClient', bootOpts);
        expect(recreatedClient).to.be.instanceOf(VaultClient);
        expect(recreatedClient).to.not.equal(client);
    });

    it('should not affect other named instances when clearing one client', () => {
        VaultClient.boot('primaryClient', bootOpts);
        const secondaryClient = VaultClient.boot('secondaryClient', bootOpts);

        VaultClient.clear('primaryClient');

        expect(VaultClient.get('secondaryClient')).to.equal(secondaryClient);
        expect(() => VaultClient.get('primaryClient')).to.throw(Error, 'Invalid instance name');

        VaultClient.clear('secondaryClient');
        expect(() => VaultClient.get('secondaryClient')).to.throw(Error, 'Invalid instance name');
    });

});
