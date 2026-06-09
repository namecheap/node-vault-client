import deepFreeze from 'deep-freeze';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';

use(sinonChai);

describe('Unit tests', function () {

    const TEST_TOKEN = 'test-not-a-real-token';

    const bootOpts = deepFreeze({
        api: { url: 'https://example.com/' },
        logger: false,
        auth: {
            type: 'token',
            config: {
                token: TEST_TOKEN,
            }
        },
    });

    afterEach(function () {
        VaultClient.clear();
        sinon.restore();
    });

    it('should boot a new VaultClient instance initialized from the given options', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        expect(client).to.be.instanceOf(VaultClient);

        // The configuration is wired into the API client and the auth provider.
        expect(client.__api.__config.url).to.equal(bootOpts.api.url);
        expect(client.__auth).to.be.instanceOf(VaultTokenAuth);
        expect(client.__auth.__token).to.equal(bootOpts.auth.config.token);
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

    it('should throw when getting a client that was never booted', () => {
        expect(() => VaultClient.get('neverBootedClient')).to.throw(Error, 'Invalid instance name');
    });

    it('should release the instance resources and allow re-creation when cleared', () => {
        const client = VaultClient.boot('primaryClient', bootOpts);
        const closeSpy = sinon.spy(client, 'close');

        VaultClient.clear('primaryClient');

        // clear() disposes the instance (close() cancels the auth-refresh timer) before removing it.
        expect(closeSpy).to.have.been.calledOnce;
        expect(() => VaultClient.get('primaryClient')).to.throw(Error, 'Invalid instance name');

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
