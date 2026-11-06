import vm from 'node:vm';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import VaultNodeConfig from '../src/VaultNodeConfig.js';
import Lease from '../src/Lease.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import errors from '../src/errors.js';
import { createSpyLogger, loggedText } from './helpers/logger.mjs';
import MountResolver from '../src/MountResolver.js';

use(sinonChai);

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

    describe('the instance registry holds only registered instances (#238)', function () {
        const PROTOTYPE_NAMES = ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

        PROTOTYPE_NAMES.forEach((name) => it(`get("${name}") throws when nothing was booted under that name`, function () {
            expect(() => VaultClient.get(name)).to.throw(errors.InvalidArgumentsError, 'Invalid instance name');
        }));

        PROTOTYPE_NAMES.forEach((name) => it(`boot("${name}") creates, caches and clears an instance like any other name`, function () {
            const logger = createSpyLogger();
            const instance = VaultClient.boot(name, bootOpts({ logger }));

            expect(instance).to.be.instanceOf(VaultClient);
            expect(VaultClient.boot(name, bootOpts({ logger }))).to.equal(instance);
            expect(VaultClient.get(name)).to.equal(instance);
            expect(logger.warn).not.to.have.been.called;

            VaultClient.clear(name);
            expect(() => VaultClient.get(name)).to.throw(errors.InvalidArgumentsError, 'Invalid instance name');
        }));

        [
            ['1', 1, '1'],
            ['"1" before 1', '1', 1],
            ['true', true, 'true'],
            ['null', null, 'null'],
            ['undefined', undefined, 'undefined'],
            ['-0', -0, '0'],
            ['an object with its own toString', { toString: () => 'custom' }, 'custom'],
        ].forEach(([label, name, sameAs]) => it(`keys ${label} as an object property would be`, function () {
            const instance = VaultClient.boot(name, bootOpts());

            expect(VaultClient.boot(name, bootOpts())).to.equal(instance);
            expect(VaultClient.get(name)).to.equal(instance);
            expect(VaultClient.get(sameAs)).to.equal(instance);
            expect(VaultClient.boot(sameAs, bootOpts())).to.equal(instance);
        }));

        it('keeps a symbol name distinct from its description, and keys an object by the symbol it converts to', function () {
            const key = Symbol('main');
            const bySymbol = VaultClient.boot(key, bootOpts());
            const byString = VaultClient.boot('Symbol(main)', bootOpts());

            expect(bySymbol).not.to.equal(byString);
            expect(VaultClient.get(key)).to.equal(bySymbol);
            expect(VaultClient.get(Object(key))).to.equal(bySymbol);
            expect(VaultClient.boot({ [Symbol.toPrimitive]: () => key }, bootOpts())).to.equal(bySymbol);
        });

        it('leaves symbol-named instances out of clear() with no name, as before', function () {
            const key = Symbol('kept');
            const kept = VaultClient.boot(key, bootOpts());
            const closeKept = sinon.spy(kept, 'close');
            VaultClient.boot('gone', bootOpts());

            try {
                VaultClient.clear();

                expect(VaultClient.get(key)).to.equal(kept);
                expect(closeKept).not.to.have.been.called;
                expect(() => VaultClient.get('gone')).to.throw(errors.InvalidArgumentsError);
            } finally {
                kept.close();
            }
        });

        it('clear("toString") on an empty registry does nothing', function () {
            expect(() => VaultClient.clear('toString')).not.to.throw();
            expect(() => VaultClient.clear('__proto__')).not.to.throw();
        });

        it('clear() with no name closes and removes every instance, prototype-member names included', function () {
            const a = VaultClient.boot('constructor', bootOpts());
            const b = VaultClient.boot('b', bootOpts());
            const closeA = sinon.spy(a, 'close');
            const closeB = sinon.spy(b, 'close');

            VaultClient.clear();

            expect(closeA).to.have.been.calledOnce;
            expect(closeB).to.have.been.calledOnce;
            expect(() => VaultClient.get('constructor')).to.throw(errors.InvalidArgumentsError);
            expect(() => VaultClient.get('b')).to.throw(errors.InvalidArgumentsError);
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

        it('returns only the token header', function () {
            const client = new VaultClient(bootOpts());
            expect(client.getHeaders(token)).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });

        it('does not add the namespace header (namespace is injected centrally by VaultApiClient)', function () {
            const client = new VaultClient(bootOpts({ auth: { config: { namespace: 'ns1' } } }));
            // The namespace is applied to every request inside VaultApiClient#makeRequest, so
            // getHeaders itself no longer carries it (see test/namespace.test.mjs for the wire-level proof).
            expect(client.getHeaders(token)).to.deep.equal({ 'X-Vault-Token': 'tid' });
        });

        it('resolves the namespace from auth.config.namespace onto the API client', function () {
            const client = new VaultClient(bootOpts({ auth: { config: { namespace: 'ns1' } } }));
            expect(client.__api.__namespace).to.equal('ns1');
        });

        it('prefers api.namespace over the legacy auth.config.namespace', function () {
            const client = new VaultClient(bootOpts({
                api: { namespace: 'from-api' },
                auth: { config: { namespace: 'from-auth' } },
            }));
            expect(client.__api.__namespace).to.equal('from-api');
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

    describe('.boot() with options for an existing instance (#146)', function () {
        const bootOpts = (overrides) => _.merge({
            api: { url: 'https://example.com/' },
            auth: { type: 'token', config: { token: 'tok-123' } },
        }, overrides);

        afterEach(function () {
            VaultClient.clear();
        });

        it('returns the existing instance and warns when the options differ', function () {
            const log = createSpyLogger();
            const first = VaultClient.boot('dup', bootOpts({ logger: log }));
            const second = VaultClient.boot('dup', bootOpts({ logger: log, api: { url: 'https://other.example/' } }));

            expect(second, 'the memoized instance is still returned').to.equal(first);
            expect(loggedText(log)).to.contain('different options');
            expect(loggedText(log)).to.contain('VaultClient.get');
        });

        it('stays silent when the options are equivalent', function () {
            const log = createSpyLogger();
            VaultClient.boot('same', bootOpts({ logger: log }));
            VaultClient.boot('same', bootOpts({ logger: log }));

            expect(loggedText(log), 'a re-boot with the same config must not warn').to.not.contain('different options');
        });

        it('ignores key order when comparing', function () {
            const log = createSpyLogger();
            VaultClient.boot('order', { logger: log, api: { url: 'https://example.com/' }, auth: { type: 'token', config: { token: 't' } } });
            VaultClient.boot('order', { auth: { config: { token: 't' }, type: 'token' }, api: { url: 'https://example.com/' }, logger: log });

            expect(loggedText(log)).to.not.contain('different options');
        });

        it('warns when only a provider function differs, and not for the same function', function () {
            const log = createSpyLogger();
            const jwtOpts = (provider) => ({
                logger: log,
                api: { url: 'https://example.com/' },
                auth: { type: 'jwt', config: { jwt: 'e.y.z', distributedClaimAccessTokenProvider: provider } },
            });
            const providerA = () => 'a';
            VaultClient.boot('fn', jwtOpts(providerA));
            VaultClient.boot('fn', jwtOpts(providerA));
            expect(loggedText(log), 'the same function must not warn').to.not.contain('different options');

            VaultClient.boot('fn', jwtOpts(() => 'a'));
            expect(loggedText(log), 'a different function must warn').to.contain('different options');
        });

        it('warns for a different jwtProvider too', function () {
            const log = createSpyLogger();
            const jwtOpts = (jwtProvider) => ({
                logger: log, api: { url: 'https://example.com/' }, auth: { type: 'jwt', config: { jwtProvider } },
            });
            VaultClient.boot('jwt-fn', jwtOpts(() => 'a'));
            VaultClient.boot('jwt-fn', jwtOpts(() => 'a'));
            expect(loggedText(log)).to.contain('different options');
        });

        describe('functions and non-plain objects compare by identity (#224)', function () {
            const warned = (log) => log.warn.getCalls().some((c) => String(c.args[0]).includes('different options'));

            it('warns for a different logger built from different functions, and returns the first instance', function () {
                const L1 = createSpyLogger();
                const L2 = createSpyLogger();
                const first = VaultClient.boot('logger', bootOpts({ logger: L1 }));
                const second = VaultClient.boot('logger', bootOpts({ logger: L2 }));

                expect(second).to.equal(first);
                // The existing instance warns through its own logger; L2 is never used.
                expect(warned(L1), 'L2 was ignored, which must be visible').to.equal(true);
                expect(L2.warn).to.not.have.been.called;
            });

            it('warns when only re-created logger methods differ', function () {
                const warn = sinon.spy();
                const freshLogger = () => ({ error() {}, warn, info() {}, debug() {}, trace() {} });
                VaultClient.boot('logger-fn', bootOpts({ logger: freshLogger() }));
                VaultClient.boot('logger-fn', bootOpts({ logger: freshLogger() }));
                expect(warn.getCalls().map((c) => String(c.args[0])).join(' ')).to.contain('different options');
            });

            it('stays silent for the same logger class instance', function () {
                class Logger {
                    constructor() { this.calls = []; }
                    error() {} warn(...args) { this.calls.push(args.join(' ')); } info() {} debug() {} trace() {}
                }
                const logger = new Logger();
                VaultClient.boot('logger-class', bootOpts({ logger }));
                VaultClient.boot('logger-class', bootOpts({ logger }));
                expect(logger.calls.join(' ')).to.not.contain('different options');
            });

            it('warns for a different dispatcher even when its own fields are identical', function () {
                // A dispatcher keeps its configuration in symbol-keyed and prototype state, so
                // structurally any two look alike.
                class Dispatcher {
                    constructor(ca) { this[Symbol.for('options')] = { ca }; this._events = {}; }
                    dispatch() {}
                }
                const log = createSpyLogger();
                const withDispatcher = (dispatcher) => bootOpts({ logger: log, api: { requestOptions: { dispatcher } } });
                const original = new Dispatcher('old-ca');

                VaultClient.boot('dispatcher', withDispatcher(original));
                VaultClient.boot('dispatcher', withDispatcher(original));
                expect(warned(log), 'the same dispatcher must not warn').to.equal(false);

                VaultClient.boot('dispatcher', withDispatcher(new Dispatcher('new-ca')));
                expect(warned(log), 'a different dispatcher must warn').to.equal(true);
            });

            it('warns for a different function anywhere in the options, not only provider keys', function () {
                const log = createSpyLogger();
                const opts = (credentials) => bootOpts({ logger: log, auth: { type: 'token', config: { token: 't', credentials } } });
                const provider = () => ({});

                VaultClient.boot('any-fn', opts(provider));
                VaultClient.boot('any-fn', opts(provider));
                expect(warned(log)).to.equal(false);

                VaultClient.boot('any-fn', opts(() => ({})));
                expect(warned(log)).to.equal(true);
            });

            it('compares a Buffer, Date, URL or RegExp by value, so an equal re-created one stays silent', function () {
                const log = createSpyLogger();
                const opts = (n) => bootOpts({ logger: log, api: { requestOptions: {
                    ca: Buffer.from(`pem-${n}`), at: new Date(1000 * n), proxy: new URL(`http://proxy-${n}/`), match: new RegExp(`^${n}$`),
                } } });

                VaultClient.boot('values', opts(1));
                VaultClient.boot('values', opts(1));
                expect(warned(log), 'equal values must not warn').to.equal(false);

                VaultClient.boot('values', opts(2));
                expect(warned(log), 'different values must warn').to.equal(true);
            });

            it('compares plain data by content: arrays, cross-realm objects and shared or circular references', function () {
                const log = createSpyLogger();
                const opts = () => {
                    const shared = { k: 'v' };
                    const circular = { name: 'c' };
                    circular.self = circular;
                    return bootOpts({ logger: log, api: { requestOptions: {
                        list: ['a', { b: 1 }], a: shared, b: shared, circular,
                        // A plain object from another realm has a different Object.prototype.
                        foreign: vm.runInNewContext('({ x: 1 })'),
                    } } });
                };

                VaultClient.boot('plain-data', opts());
                VaultClient.boot('plain-data', opts());
                expect(warned(log), 'equal plain data must not warn').to.equal(false);

                VaultClient.boot('plain-data', bootOpts({ logger: log, api: { requestOptions: { list: ['a', { b: 2 }] } } }));
                expect(warned(log), 'a different array must warn').to.equal(true);
            });

            it('never lets option code decide or fail the comparison: throwing traps and toJSON compare by identity', function () {
                const log = createSpyLogger();
                class Strict {}
                const throwingProxy = () => new Proxy(new Strict(), {
                    get() { throw new ReferenceError('strict mock'); },
                    getPrototypeOf() { throw new Error('no prototype'); },
                });
                class Redacting { toJSON() { return '[redacted]'; } }
                // Built by hand: bootOpts() deep-merges, and lodash would run the proxy's traps.
                const opts = (proxy, redacting) => ({
                    logger: log,
                    api: { url: 'https://example.com/', requestOptions: { proxy, redacting, big: 10n } },
                    auth: { type: 'token', config: { token: 'tok-123' } },
                });
                const proxy = throwingProxy();
                const redacting = new Redacting();

                VaultClient.boot('user-code', opts(proxy, redacting));
                expect(() => VaultClient.boot('user-code', opts(proxy, redacting))).to.not.throw();
                expect(warned(log), 'the same objects must not warn').to.equal(false);

                // A toJSON() that hides its state no longer makes two different objects look equal.
                expect(() => VaultClient.boot('user-code', opts(proxy, new Redacting()))).to.not.throw();
                expect(warned(log), 'a different object must warn').to.equal(true);
                log.warn.resetHistory();
                VaultClient.clear('user-code');
                VaultClient.boot('user-code', opts(proxy, redacting));
                VaultClient.boot('user-code', opts(throwingProxy(), redacting));
                expect(warned(log), 'a different throwing proxy must warn').to.equal(true);
            });

            it('names the differing options and warns once per instance for each set of them', function () {
                const warn = sinon.spy();
                const freshLogger = () => ({ error() {}, warn, info() {}, debug() {}, trace() {} });
                const first = freshLogger();
                VaultClient.boot('once', bootOpts({ logger: first }));
                for (let i = 0; i < 5; i++) {
                    VaultClient.boot('once', bootOpts({ logger: freshLogger() }));
                }
                expect(warn).to.have.been.calledOnce;
                expect(warn.firstCall.args.at(-1)).to.equal('logger');
                expect(String(warn.firstCall.args[0])).to.contain('Differing options: %s.');

                VaultClient.boot('once', bootOpts({ logger: first, api: { url: 'https://other.example/' } }));
                VaultClient.boot('once', bootOpts({ logger: first, api: { url: 'https://third.example/' } }));
                expect(warn).to.have.been.calledTwice;
                expect(warn.secondCall.args.at(-1)).to.equal('api');

                VaultClient.boot('once', bootOpts({ logger: freshLogger(), api: { url: 'https://other.example/' } }));
                expect(warn).to.have.been.calledThrice;
                expect(warn.thirdCall.args.at(-1)).to.equal('api, logger');
            });

            it('names an option that was added or left out', function () {
                const log = createSpyLogger();
                VaultClient.boot('keys', { logger: log, api: { url: 'https://example.com/' }, auth: { type: 'token', config: { token: 't' } } });
                VaultClient.boot('keys', { api: { url: 'https://example.com/' }, auth: { type: 'token', config: { token: 't' } } });
                expect(log.warn.firstCall.args.at(-1)).to.equal('logger');
            });

            it('stays silent for logger: false and for plain options re-created per call', function () {
                const instance = VaultClient.boot('plain', bootOpts({ logger: false, api: { kv: { autoDetect: true } } }));
                const warn = sinon.spy(instance.__log, 'warn');
                VaultClient.boot('plain', bootOpts({ logger: false, api: { kv: { autoDetect: true } } }));
                expect(warn).to.not.have.been.called;
            });
        });

        it('does not warn for a name that was never booted', function () {
            const log = createSpyLogger();
            VaultClient.boot('fresh', bootOpts({ logger: log }));

            expect(loggedText(log)).to.not.contain('different options');
        });

        it('still throws when options are omitted entirely', function () {
            VaultClient.boot('needs-opts', bootOpts({ logger: false }));
            expect(() => VaultClient.boot('needs-opts')).to.throw(errors.InvalidArgumentsError);
        });
    });

    describe('#__setupLogger()', function () {
        let client;
        beforeEach(function () { client = new VaultClient(bootOpts()); });

        it('returns an all-noop logger when given false', function () {
            const log = client.__setupLogger(false);
            for (const method of ['error', 'warn', 'info', 'debug', 'trace']) {
                expect(log[method]).to.be.a('function');
                expect(log[method]()).to.be.undefined;
            }
        });

        it('returns the supplied logger when it implements the full interface', function () {
            const custom = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));
            expect(client.__setupLogger(custom)).to.equal(custom);
        });

        it('falls back to console for an incomplete logger (with a silent debug)', function () {
            const log = client.__setupLogger({});
            expect(log.error).to.equal(console.error);
            expect(log.warn).to.equal(console.warn);
            expect(log.debug).to.be.a('function');
            expect(log.debug).to.not.equal(console.debug);
            expect(log.debug()).to.be.undefined;
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

    // -------------------------------------------------------------------------
    // KV v2 — autoDetect:false (default) — zero behavior change
    // -------------------------------------------------------------------------
    describe('KV v2 — autoDetect:false (default passthrough)', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() passes path through unchanged and wraps in Lease', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ request_id: 'r', data: { k: 'v' } }) };
            return client.read('secret/x').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/x', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() passes path and data through unchanged', function () {
            const response = { data: { version: 1 } };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.write('secret/x', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
                expect(client.__api.makeRequest).to.have.been.calledWith('POST', 'secret/x', { a: 1 }, { 'X-Vault-Token': 'tid' });
            });
        });

        it('list() passes path through unchanged', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('does NOT call sys/internal/ui/mounts when resolver is disabled', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/x').then(() => {
                // Should have called makeRequest exactly once (the actual read), not the detection endpoint
                expect(client.__api.makeRequest).to.have.been.calledOnce;
                const [, path] = client.__api.makeRequest.getCall(0).args;
                expect(path).to.not.include('sys/internal');
            });
        });

        it('list() preserves trailing slash on the wire (regression: byte-for-byte passthrough)', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret/').then(() => {
                // Trailing slash must be preserved — wire path must match caller's path exactly
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret/', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('read() preserves trailing slash on the wire (regression: byte-for-byte passthrough)', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('path/').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'path/', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 — autoDetect:true — path rewriting + response unwrapping
    // -------------------------------------------------------------------------
    describe('KV v2 — autoDetect:true', function () {
        let client;
        const token = { getId: () => 'tid' };

        function bootV2Client() {
            return new VaultClient(bootOpts({
                api: { kv: { autoDetect: true } },
            }));
        }

        // Stub the resolver so we control version without real HTTP
        function stubResolver(c, version) {
            c.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: String(version) } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
        }

        beforeEach(function () {
            client = bootV2Client();
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('read() rewrites path to data/ segment on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({
                data: { data: { username: 'admin' }, metadata: { version: 1 } },
            }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease).to.be.instanceOf(Lease);
                expect(lease.getData()).to.deep.equal({ username: 'admin' });
                expect(lease.getMetadata()).to.deep.equal({ version: 1 });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('write() wraps data in { data } and rewrites path on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 3 } }) };
            return client.write('secret/foo', { password: 'pw' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/data/foo', { data: { password: 'pw' } }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('list() rewrites path to metadata/ segment on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['foo', 'bar/'] } }) };
            return client.list('secret').then((lease) => {
                expect(client.__api.makeRequest).to.have.been.calledWith('LIST', 'secret/metadata/', null, { 'X-Vault-Token': 'tid' });
                expect(lease.getData()).to.deep.equal({ keys: ['foo', 'bar/'] });
            });
        });

        it('delete() sends DELETE to data/ path on v2', function () {
            stubResolver(client, 2);
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.delete('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('DELETE', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('read() passthrough on v1 mount (no path rewriting)', function () {
            // Stub resolver to return v1 for the 'secret' mount prefix
            client.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: '1' } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getData()).to.deep.equal({ k: 'v' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('Lease.getMetadata() returns undefined for v1 (no metadata in response)', function () {
            client.__resolver = new MountResolver(
                sinon.stub().resolves({
                    data: { path: 'secret/', type: 'kv', options: { version: '1' } },
                }),
                {},
                { debug: _.noop, error: _.noop, info: _.noop, warn: _.noop, trace: _.noop }
            );
            client.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getMetadata()).to.equal(undefined);
            });
        });
    });

    // -------------------------------------------------------------------------
    // KV v2 — engines override
    // -------------------------------------------------------------------------
    describe('KV v2 — engines override (no autoDetect)', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2, legacy: 1 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('uses engines override to rewrite path without detection', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                data: { data: { x: 1 }, metadata: { version: 1 } },
            }) };
            return client.read('secret/foo').then((lease) => {
                expect(lease.getData()).to.deep.equal({ x: 1 });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('legacy mount (v1) passes through unchanged', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { a: 'b' } }) };
            return client.read('legacy/bar').then((lease) => {
                expect(lease.getData()).to.deep.equal({ a: 'b' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'legacy/bar', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // request() — raw passthrough
    // -------------------------------------------------------------------------
    describe('#request()', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts());
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('sends the literal path and returns the parsed body', function () {
            const body = { ciphertext: 'vault:v1:xyz' };
            client.__api = { makeRequest: sinon.stub().resolves(body) };
            return client.request('POST', 'transit/encrypt/mykey', { plaintext: 'dGVzdA==' }).then((res) => {
                expect(res).to.equal(body);
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'transit/encrypt/mykey', { plaintext: 'dGVzdA==' }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('passes null when data is omitted', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.request('GET', 'sys/health').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'sys/health', null, { 'X-Vault-Token': 'tid' });
            });
        });
    });

    // -------------------------------------------------------------------------
    // update() — PATCH with merge-patch+json
    // -------------------------------------------------------------------------
    describe('#update()', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('sends PATCH with application/merge-patch+json and data envelope on v2', function () {
            client.__api = { makeRequest: sinon.stub().resolves({ data: { version: 4 } }) };
            return client.update('secret/foo', { password: 'new' }).then(() => {
                const [method, path, data, headers] = client.__api.makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('secret/data/foo');
                expect(data).to.deep.equal({ data: { password: 'new' } });
                expect(headers['Content-Type']).to.equal('application/merge-patch+json');
            });
        });
    });

    // -------------------------------------------------------------------------
    // v2-only helpers
    // -------------------------------------------------------------------------
    describe('v2-only helpers', function () {
        let client;
        const token = { getId: () => 'tid' };

        beforeEach(function () {
            client = new VaultClient(bootOpts({
                api: { engines: { secret: 2 } },
            }));
            client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        });

        it('deleteVersions() sends POST to delete/ path with versions body', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.deleteVersions('secret/foo', [1, 2]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/delete/foo', { versions: [1, 2] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('undeleteVersions() sends POST to undelete/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.undeleteVersions('secret/foo', [1]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/undelete/foo', { versions: [1] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('destroyVersions() sends POST to destroy/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.destroyVersions('secret/foo', [3]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'secret/destroy/foo', { versions: [3] }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('readMetadata() sends GET to metadata/ path and normalises response', function () {
            client.__api = { makeRequest: sinon.stub().resolves({
                request_id: 'r',
                data: { current_version: 2, versions: { '1': {}, '2': {} } },
            }) };
            return client.readMetadata('secret/foo').then((body) => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/metadata/foo', null, { 'X-Vault-Token': 'tid' }
                );
                expect(body.data).to.deep.equal({ current_version: 2, versions: { '1': {}, '2': {} } });
            });
        });

        it('deleteMetadata() sends DELETE to metadata/ path', function () {
            client.__api = { makeRequest: sinon.stub().resolves(null) };
            return client.deleteMetadata('secret/foo').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'DELETE', 'secret/metadata/foo', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('v2-only helpers throw UnsupportedOperationError on a v1 mount', function () {
            const v1Client = new VaultClient(bootOpts({
                api: { engines: { secret: 1 } },
            }));
            v1Client.__auth = { getAuthToken: sinon.stub().resolves(token) };
            v1Client.__api = { makeRequest: sinon.stub().resolves({}) };

            return v1Client.deleteVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                    expect(err.message).to.include('deleteVersions');
                }
            );
        });
    });
});
