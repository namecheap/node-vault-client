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

    it('should correctly boot/get/clear VaultClient instance', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);

        expect(client).to.be.instanceOf(VaultClient);

        expect(VaultClient.get('primaryClient')).to.equal(client);

        expect(VaultClient.boot('primaryClient', bootOpts)).to.equal(client);


        const secondClient = VaultClient.boot('secondaryClient', bootOpts);
        VaultClient.clear('primaryClient');

        const recreatedClient = VaultClient.boot('primaryClient', bootOpts);
        expect(recreatedClient).to.be.instanceOf(VaultClient);
        expect(recreatedClient).to.not.equal(client);

        expect(VaultClient.get('secondaryClient')).to.equal(secondClient);

        VaultClient.clear('secondaryClient');
        expect(() => VaultClient.get('secondaryClient')).to.throw();
    });

});
