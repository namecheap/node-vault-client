import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';

use(sinonChai);

const logger = _.fromPairs(
  _.map(['error', 'warn', 'info', 'debug', 'trace'], (prop) => [prop, _.noop]),
);

describe('AppRole auth backend', function () {
  function getApiStub() {
    return sinon.createStubInstance(VaultApiClient);
  }

  describe('Vault Request', function () {
    const mount = 'approle';

    it('Should make a correct vault login request with namespace', async () => {
      const api = getApiStub();

      const auth = new VaultAppRoleAuth(
        api,
        logger,
        {
          role_id: 'role123',
          secret_id: 'secret456',
          namespace: 'ns1',
        },
        mount,
      );

      api.makeRequest
        .withArgs('POST')
        .resolves({ auth: { client_token: 'fake_token' } });
      sinon.stub(auth, '_getTokenEntity');

      await auth._authenticate();

      expect(
        api.makeRequest.calledWith(
          'POST',
          '/auth/approle/login',
          { role_id: 'role123', secret_id: 'secret456' },
          { 'X-Vault-Namespace': 'ns1' },
        ),
      ).to.be.true;
    });

    it('Should not set namespace header if not provided', async () => {
      const api = getApiStub();

      const auth = new VaultAppRoleAuth(
        api,
        logger,
        {
          role_id: 'role123',
          secret_id: 'secret456',
        },
        mount,
      );

      api.makeRequest
        .withArgs('POST')
        .resolves({ auth: { client_token: 'fake_token' } });
      sinon.stub(auth, '_getTokenEntity');

      await auth._authenticate();

      expect(
        api.makeRequest.calledWith(
          'POST',
          '/auth/approle/login',
          { role_id: 'role123', secret_id: 'secret456' },
          {},
        ),
      ).to.be.true;
    });

    it("defaults the mount to 'approle' when none is provided", async () => {
      const api = getApiStub();

      const auth = new VaultAppRoleAuth(api, logger, {
        role_id: 'role123',
        secret_id: 'secret456',
      });

      api.makeRequest
        .withArgs('POST')
        .resolves({ auth: { client_token: 'fake_token' } });
      sinon.stub(auth, '_getTokenEntity');

      await auth._authenticate();

      expect(
        api.makeRequest.calledWith(
          'POST',
          '/auth/approle/login',
          { role_id: 'role123', secret_id: 'secret456' },
          {},
        ),
      ).to.be.true;
    });
  });
});
