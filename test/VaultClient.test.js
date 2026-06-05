'use strict';

const _ = require('lodash');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const VaultClient = require('../src/VaultClient');
const VaultNodeConfig = require('../src/VaultNodeConfig');
const Lease = require('../src/Lease');
const VaultTokenAuth = require('../src/auth/VaultTokenAuth');
const VaultAppRoleAuth = require('../src/auth/VaultAppRoleAuth');
const VaultIAMAuth = require('../src/auth/VaultIAMAuth');
const VaultKubernetesAuth = require('../src/auth/VaultKubernetesAuth');
const errors = require('../src/errors');

function bootOpts(overrides) {
    return _.merge({
        api: { url: 'https://example.com/' },
        logger: false,
        auth: {
            type: 'token',
            config: { token: 'tok-123' },
        },
    }, overrides);
}

describe('VaultClient', function () {
    afterEach(function () {
        VaultClient.clear();
    });

    describe('static boot/get/clear', function () {
        it('throws when options are not provided to boot', function () {
            expect(() => VaultClient.boot('x')).to.throw(errors.InvalidArgumentsError, 'Options should be provided');
        });

        it('creates, caches and returns the same instance', function () {
            const i = VaultClient.boot('main', bootOpts());
            expect(i).to.be.instanceOf(VaultClient);
            expect(VaultClient.boot('main', bootOpts())).to.equal(i);
            expect(VaultClient.get('main')).to.equal(i);
        });

        it('throws when getting an unknown instance', function () {
            expect(() => VaultClient.get('does-not-exist')).to.throw(errors.InvalidArgumentsError, 'Invalid instance name');
        });

        it('clears a single named instance', function () {
            const i = VaultClient.boot('a', bootOpts());
            VaultClient.boot('b', bootOpts());
            VaultClient.clear('a');
            expect(() => VaultClient.get('a')).to.throw(errors.InvalidArgumentsError);
            expect(VaultClient.get('b')).to.be.instanceOf(VaultClient);
            expect(VaultClient.boot('a', bootOpts())).to.not.equal(i);
        });

        it('clears every instance when no name is given', function () {
            VaultClient.boot('a', bootOpts());
            VaultClient.boot('b', bootOpts());
            VaultClient.clear();
            expect(() => VaultClient.get('a')).to.throw();
            expect(() => VaultClient.get('b')).to.throw();
        });
    });

    describe('#close()', function () {
        it('delegates to the auth provider\'s cancelTokenRefresh', function () {
            const client = new VaultClient(bootOpts());
            const cancel = sinon.stub();
            client.__auth = { cancelTokenRefresh: cancel };
            client.close();
            expect(cancel).to.have.been.calledOnce;
        });

        it('is null-safe when the auth provider lacks cancelTokenRefresh', function () {
            const client = new VaultClient(bootOpts());
            client.__auth = {};
            expect(() => client.close()).to.not.throw();
            client.__auth = null;
            expect(() => client.close()).to.not.throw();
        });
    });

    describe('static clear() releases timers', function () {
        it('calls close() on a single named instance before removing it', function () {
            const i = VaultClient.boot('a', bootOpts());
            const spy = sinon.spy(i, 'close');
            VaultClient.clear('a');
            expect(spy).to.have.been.calledOnce;
        });

        it('calls close() on every instance when clearing all', function () {
            const a = VaultClient.boot('a', bootOpts());
            const b = VaultClient.boot('b', bootOpts());
            const sa = sinon.spy(a, 'close');
            const sb = sinon.spy(b, 'close');
            VaultClient.clear();
            expect(sa).to.have.been.calledOnce;
            expect(sb).to.have.been.calledOnce;
        });
    });

    describe('auth provider selection', function () {
        const cases = [
            ['token', { token: 'tok' }, VaultTokenAuth],
            ['appRole', { role_id: 'rid' }, VaultAppRoleAuth],
            ['iam', { role: 'r' }, VaultIAMAuth],
            ['kubernetes', { role: 'r' }, VaultKubernetesAuth],
        ];

        cases.forEach(([type, config, Klass]) => {
            it(`builds a ${Klass.name} for the "${type}" auth type`, function () {
                const client = new VaultClient(bootOpts({ auth: { type, config } }));
                expect(client.__auth).to.be.instanceOf(Klass);
            });
        });

        it('throws for an unsupported auth type', function () {
            expect(() => new VaultClient(bootOpts({ auth: { type: 'nope', config: {} } })))
                .to.throw(errors.InvalidArgumentsError, 'Unsupported auth method');
        });
    });

    describe('#getHeaders()', function () {
        const token = { getId: () => 'tid' };

        it('returns only the token header without a namespace', function () {
            const client = new VaultClient(bootOpts());
            expect(client.getHeaders(token)).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });

        it('adds the namespace header when configured', function () {
            const client = new VaultClient(bootOpts({ auth: { config: { namespace: 'ns1' } } }));
            expect(client.getHeaders(token)).to.deep.equal({
                'X-Vault-Token': 'tid',
                'X-Vault-Namespace': 'ns1',
            });
        });
    });

    describe('secret operations', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() issues a GET and wraps the response in a Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ request_id: 'r', data: { k: 'v' } }) };
            return client.read('secret/x').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/x', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('list() issues a LIST and wraps the response in a Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ keys: ['a'] });
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() issues a POST and returns the raw response', function () {
            const response = { data: { ip: '127.0.0.1' } };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.write('secret/x', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
                expect(client.__api.makeRequest).to.have.been.calledWith('POST', 'secret/x', { a: 1 }, { 'X-Vault-Token': 'tid' });
            });
        });

        ['read', 'list', 'write'].forEach((method) => {
            it(`${method}() rejects with the underlying error`, function () {
                const boom = new Error('boom');
                client.__api = { makeRequest: sinon.stub().rejects(boom) };
                return client[method]('secret/x', {}).then(
                    () => { throw new Error('expected rejection'); },
                    (err) => { expect(err).to.equal(boom); }
                );
            });
        });
    });

    describe('#__setupLogger()', function () {
        let client;
        beforeEach(function () { client = new VaultClient(bootOpts()); });

        it('returns an all-noop logger when given false', function () {
            const log = client.__setupLogger(false);
            expect(log.error).to.equal(_.noop);
            expect(log.debug).to.equal(_.noop);
        });

        it('returns the supplied logger when it implements the full interface', function () {
            const custom = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));
            expect(client.__setupLogger(custom)).to.equal(custom);
        });

        it('falls back to console for an incomplete logger (with a silent debug)', function () {
            const log = client.__setupLogger({});
            expect(log.error).to.equal(console.error);
            expect(log.warn).to.equal(console.warn);
            expect(log.debug).to.equal(_.noop);
        });
    });

    describe('#fillNodeConfig()', function () {
        it('delegates to VaultNodeConfig#populate', function () {
            const sentinel = Promise.resolve('populated');
            const populate = sinon.stub(VaultNodeConfig.prototype, 'populate').returns(sentinel);
            try {
                const client = new VaultClient(bootOpts());
                const result = client.fillNodeConfig();
                expect(populate).to.have.been.calledOnce;
                return result.then((value) => expect(value).to.equal('populated'));
            } finally {
                populate.restore();
            }
        });
    });
});
