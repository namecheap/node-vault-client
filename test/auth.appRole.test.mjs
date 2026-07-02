import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';

use(sinonChai);

const LOG_METHODS = ['error', 'warn', 'info', 'debug', 'trace'];

const logger = _.fromPairs(_.map(LOG_METHODS, (prop) => [prop, _.noop]));

function spyLogger() {
  return _.fromPairs(_.map(LOG_METHODS, (prop) => [prop, sinon.spy()]));
}

// Flatten every argument passed to a logger call into a single searchable string,
// covering both printf-style args and object logging (%j / %o).
function loggedText(log) {
  return _.flatMap(LOG_METHODS, (m) => _.flatMap(log[m].getCalls(), (c) => c.args))
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

describe('AppRole auth backend', function () {
  function getApiStub() {
    return sinon.createStubInstance(VaultApiClient);
  }

  describe('Vault Request', function () {
    const mount = 'approle';

    it('makes the login request with role_id/secret_id and no per-backend headers', async () => {
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

      // The namespace header is injected centrally by VaultApiClient (see test/namespace.test.mjs),
      // so the backend passes no headers of its own.
      expect(
        api.makeRequest.calledWithExactly(
          'POST',
          '/auth/approle/login',
          { role_id: 'role123', secret_id: 'secret456' },
        ),
      ).to.be.true;
    });

    it('does not attach an X-Vault-Namespace header itself, even when namespace is configured', async () => {
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

      // Namespacing is centralized in VaultApiClient; the backend must not reintroduce a copy.
      const headers = api.makeRequest.getCall(0).args[3];
      expect(headers).to.equal(undefined);
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
        api.makeRequest.calledWithExactly(
          'POST',
          '/auth/approle/login',
          { role_id: 'role123', secret_id: 'secret456' },
        ),
      ).to.be.true;
    });
  });

  describe('does not leak the client_token to the logger (regression #104)', function () {
    const CLIENT_TOKEN = 's.RAWAPPROLETOKENSHOULDNEVERBELOGGED';
    const ACCESSOR = 'approle-accessor-1234';

    it('never passes the raw client_token to any log level, and logs the accessor instead', async () => {
      const api = getApiStub();
      const log = spyLogger();

      const auth = new VaultAppRoleAuth(
        api,
        log,
        { role_id: 'role123', secret_id: 'secret456' },
        'approle',
      );

      api.makeRequest
        .withArgs('POST')
        .resolves({ auth: { client_token: CLIENT_TOKEN, accessor: ACCESSOR } });
      sinon.stub(auth, '_getTokenEntity');

      await auth._authenticate();

      expect(loggedText(log), 'raw client_token must never reach the logger').to.not.contain(
        CLIENT_TOKEN,
      );
      // The non-sensitive accessor is logged instead, so the debug line stays useful.
      expect(loggedText(log)).to.contain(ACCESSOR);
    });
  });
});
