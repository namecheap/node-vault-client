'use strict';

const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultApiClient = require('../src/VaultApiClient');
const VaultTokenAuth = require('../src/auth/VaultTokenAuth');
const AuthToken = require('../src/auth/AuthToken');
const errors = require('../src/errors');

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));

function apiStub() {
    return sinon.createStubInstance(VaultApiClient);
}

describe('VaultTokenAuth', function () {
    it('throws when no token is provided', function () {
        expect(() => new VaultTokenAuth(apiStub(), logger, {}))
            .to.throw(errors.InvalidArgumentsError, 'Auth token should be provided');
    });

    it('defaults the mount to "token"', function () {
        const auth = new VaultTokenAuth(apiStub(), logger, { token: 't' });
        expect(auth._mount).to.equal('token');
    });

    it('honours a custom mount', function () {
        const auth = new VaultTokenAuth(apiStub(), logger, { token: 't' }, 'custom');
        expect(auth._mount).to.equal('custom');
    });

    it('does not allow reauthentication', function () {
        const auth = new VaultTokenAuth(apiStub(), logger, { token: 't' });
        expect(auth._reauthenticationAllowed()).to.equal(false);
    });

    it('authenticates by looking up the configured token', function () {
        const api = apiStub();
        api.makeRequest.resolves({
            data: { id: 't', accessor: 'a', creation_time: 1000, ttl: 0, renewable: false },
        });
        const auth = new VaultTokenAuth(api, logger, { token: 'my-token' });

        return auth._authenticate().then((token) => {
            expect(api.makeRequest).to.have.been.calledWith('GET', '/auth/token/lookup-self', null, { 'X-Vault-Token': 'my-token' });
            expect(token).to.be.instanceOf(AuthToken);
            expect(token.getId()).to.equal('t');
        });
    });
});
