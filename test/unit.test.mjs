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
        const client = VaultClient.boot('tst', bootOpts);

        expect(client).to.be.instanceOf(VaultClient);

        expect(VaultClient.get('tst')).to.equal(client);

        expect(VaultClient.boot('tst', bootOpts)).to.equal(client);


        const secondClient = VaultClient.boot('tst2', bootOpts);
        VaultClient.clear('tst');

        const recreatedClient = VaultClient.boot('tst', bootOpts);
        expect(recreatedClient).to.be.instanceOf(VaultClient);
        expect(recreatedClient).to.not.equal(client);

        expect(VaultClient.get('tst2')).to.equal(secondClient);
    });

});
