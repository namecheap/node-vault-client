import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import errors from '../src/errors.js';

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

  describe('config validation', function () {
    it('throws InvalidArgumentsError when role_id is missing', () => {
      expect(() => new VaultAppRoleAuth(getApiStub(), logger, { secret_id: 'secret456' }))
        .to.throw(errors.InvalidArgumentsError, '"role_id" should be provided for VaultAppRoleAuth');
    });

    it('throws InvalidArgumentsError when the config is missing entirely', () => {
      expect(() => new VaultAppRoleAuth(getApiStub(), logger, undefined))
        .to.throw(errors.InvalidArgumentsError, '"role_id" should be provided for VaultAppRoleAuth');
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

  describe('does not leak the role_id or secret_id to the logger (GHSA-x5xf-r8x2-647h)', function () {
    // For a role with bind_secret_id=false the role_id alone is the whole login credential.
    const ROLE_ID = '637c065f-c644-5e12-d3d1-e9fa4363af61';
    const SECRET_ID = 'b9ff2ebf-2b8b-4f8a-9d1e-secretidnotlogged';

    async function authenticate(config, mount) {
      const api = getApiStub();
      const log = spyLogger();
      const auth = new VaultAppRoleAuth(api, log, config, mount);

      api.makeRequest
        .withArgs('POST')
        .resolves({ auth: { client_token: 'fake_token', accessor: 'acc' } });
      sinon.stub(auth, '_getTokenEntity');

      await auth._authenticate();
      return { api, log };
    }

    it('never passes the role_id to any log level (role_id-only login)', async () => {
      const { api, log } = await authenticate({ role_id: ROLE_ID }, 'approle');

      expect(loggedText(log), 'role_id must never reach the logger').to.not.contain(ROLE_ID);
      // The credential still goes in the login request body, unchanged.
      expect(api.makeRequest).to.have.been.calledWithExactly(
        'POST',
        '/auth/approle/login',
        { role_id: ROLE_ID, secret_id: undefined },
      );
    });

    it('never passes the role_id or secret_id to any log level, and logs the mount instead', async () => {
      const { log } = await authenticate({ role_id: ROLE_ID, secret_id: SECRET_ID }, 'approle-prod');

      expect(loggedText(log), 'role_id must never reach the logger').to.not.contain(ROLE_ID);
      expect(loggedText(log), 'secret_id must never reach the logger').to.not.contain(SECRET_ID);
      // The info line stays useful for correlating logins without exposing the credential.
      expect(log.info).to.have.been.calledWith(sinon.match.string, 'approle-prod');
    });
  });
});
