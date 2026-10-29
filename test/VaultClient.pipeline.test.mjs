import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import errors from '../src/errors.js';

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

/**
 * Characterization tests for the request pipeline (issue #110).
 *
 * They pin the observable behavior of __resolveAndRequest / update() /
 * request() / the v2-only helpers across v1/v2 mounts, namespaces and
 * extra headers, so the pipeline can be unified without behavior change.
 */
describe('VaultClient request pipeline (characterization, #110)', function () {
    const token = { getId: () => 'tid' };

    afterEach(function () {
        VaultClient.clear();
    });

    function makeClient(overrides) {
        const client = new VaultClient(bootOpts(overrides));
        client.__auth = { getAuthToken: sinon.stub().resolves(token) };
        return client;
    }

    describe('#__resolveAndRequest() contract', function () {
        it('resolves { body, version, mount, apiPath } on a KV v2 mount', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            const body = { data: { data: { k: 'v' } } };
            client.__api = { makeRequest: sinon.stub().resolves(body) };
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null).then((result) => {
                expect(result.body).to.equal(body);
                expect(result.version).to.equal(2);
                expect(result.mount).to.equal('secret');
                expect(result.apiPath).to.equal('secret/data/foo');
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('merges extraHeaders over the token header', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null, { 'X-Extra': '1' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid', 'X-Extra': '1' }
                );
            });
        });

        it('lets extraHeaders win over the token header on a key collision', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null, { 'X-Vault-Token': 'other' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'other' }
                );
            });
        });

        it('wraps non-null data in { data } for the update op on v2', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('update', 'PATCH', 'secret/foo', { a: 1 }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'PATCH', 'secret/data/foo', { data: { a: 1 } }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('does not wrap null data for the write op on v2', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('write', 'POST', 'secret/foo', null).then(() => {
                expect(client.__api.makeRequest.getCall(0).args[2]).to.equal(null);
            });
        });

        it('does not wrap undefined data for the write op on v2', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('write', 'POST', 'secret/foo', undefined).then(() => {
                expect(client.__api.makeRequest.getCall(0).args[2]).to.equal(undefined);
            });
        });

        it('keeps the literal path (incl. trailing slash) and unwrapped data on v1', function () {
            const client = makeClient({ api: { engines: { legacy: 1 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.__resolveAndRequest('write', 'POST', 'legacy/foo/', { a: 1 }).then((result) => {
                expect(result.version).to.equal(1);
                expect(result.apiPath).to.equal('legacy/foo/');
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'POST', 'legacy/foo/', { a: 1 }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('resolves the mount exactly once per call', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({ data: { data: {} } }) };
            const resolve = sinon.spy(client.__resolver, 'resolve');
            return client.read('secret/foo').then(() => {
                expect(resolve).to.have.been.calledOnceWith('secret/foo');
            });
        });
    });

    describe('#update() across mount versions', function () {
        it('returns the raw response body on v2', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            const response = { data: { version: 4 } };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.update('secret/foo', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
            });
        });

        it('keeps the literal path and still wraps the body in { data } on a v1 mount', function () {
            const client = makeClient({ api: { engines: { legacy: 1 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.update('legacy/foo', { a: 1 }).then(() => {
                const [method, path, data, headers] = client.__api.makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('legacy/foo');
                expect(data).to.deep.equal({ data: { a: 1 } });
                expect(headers).to.deep.equal({
                    'X-Vault-Token': 'tid',
                    'Content-Type': 'application/merge-patch+json',
                });
            });
        });

        it('passes through byte-for-byte (with the { data } envelope) when the resolver is disabled', function () {
            const client = makeClient();
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.update('any/path/', { a: 1 }).then(() => {
                const [method, path, data, headers] = client.__api.makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('any/path/');
                expect(data).to.deep.equal({ data: { a: 1 } });
                expect(headers['Content-Type']).to.equal('application/merge-patch+json');
            });
        });

        it('rejects with the underlying error', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            const boom = new Error('boom');
            client.__api = { makeRequest: sinon.stub().rejects(boom) };
            return client.update('secret/foo', { a: 1 }).then(
                () => { throw new Error('expected rejection'); },
                (err) => { expect(err).to.equal(boom); }
            );
        });
    });

    describe('#request() raw passthrough', function () {
        it('never consults the mount resolver', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            const resolve = sinon.spy(client.__resolver, 'resolve');
            return client.request('GET', 'secret/x').then(() => {
                expect(resolve).to.not.have.been.called;
                // Even though "secret" is a v2 mount, the raw path is sent untouched
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/x', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('preserves a leading slash in the literal path', function () {
            const client = makeClient();
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.request('GET', '/sys/mounts', { type: 'kv' }).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', '/sys/mounts', { type: 'kv' }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('rejects with the underlying error', function () {
            const client = makeClient();
            const boom = new Error('boom');
            client.__api = { makeRequest: sinon.stub().rejects(boom) };
            return client.request('GET', 'sys/health').then(
                () => { throw new Error('expected rejection'); },
                (err) => { expect(err).to.equal(boom); }
            );
        });
    });

    describe('v2-only version assertion', function () {
        it('rejects before making any HTTP request on a v1 mount', function () {
            const client = makeClient({ api: { engines: { secret: 1 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.deleteVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                    expect(err.message).to.equal(
                        'Operation "deleteVersions" is only supported on KV v2 mounts. ' +
                        'Mount "secret" is not a KV v2 engine.'
                    );
                    expect(client.__api.makeRequest).to.not.have.been.called;
                }
            );
        });

        it('rejects on a passthrough mount when the resolver is disabled', function () {
            const client = makeClient();
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.destroyVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                    expect(err.message).to.include('destroyVersions');
                    expect(err.message).to.include('Mount "secret"');
                }
            );
        });

        it('returns the raw response body without an envelope', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            const response = { request_id: 'r' };
            client.__api = { makeRequest: sinon.stub().resolves(response) };
            return client.deleteMetadata('secret/foo').then((res) => {
                expect(res).to.equal(response);
            });
        });
    });

    describe('KV path validation (GHSA-rr65-m54w-rfr9)', function () {
        // Each of these reached a different Vault path than <mount>/<kv segment>/<logical path>
        // once fetch() (WHATWG URL parsing) or Vault (%2f decoding, KV v2 '..' resolution)
        // reinterpreted it.
        const unsafePaths = [
            ['a raw ".." segment', 'secret/apps/me/../victim/key'],
            ['a trailing ".." segment', 'secret/apps/me/..'],
            ['a ".." segment right after the mount', 'secret/../sys/mounts/m'],
            ['a raw "." segment', 'secret/apps/me/./key'],
            ['"%2e%2e"', 'secret/apps/me/%2e%2e/victim/key'],
            ['mixed-case "%2E%2e"', 'secret/apps/me/%2E%2e/victim/key'],
            ['".%2e"', 'secret/apps/me/.%2e/victim/key'],
            ['"%2e."', 'secret/apps/me/%2e./victim/key'],
            ['a lone "%2e"', 'secret/apps/me/%2e/key'],
            ['"..%2f"', 'secret/apps/me/..%2fvictim/key'],
            ['"..%2F" with an encoded tail', 'secret/apps/me/..%2Fvictim%2Fkey'],
            ['".." between "%2f"s', 'secret/apps/me/x%2f..%2f..%2fvictim/key'],
            ['"..%2f" hidden behind an invalid UTF-8 escape', 'secret/apps/me/..%2fvictim%2fkey%2f%ff%2f..'],
            ['"..%5c"', 'secret/apps/me/..%5cvictim/key'],
            ['a backslash separator', 'secret/apps/me/..\\victim/key'],
            ['backslash-only separators', 'secret/apps/me\\..\\..\\..\\sys/mounts/m'],
            ['a tab inside ".."', 'secret/apps/me/.\t./victim/key'],
            ['a line feed inside ".."', 'secret/apps/me/.\n./victim/key'],
            ['a carriage return inside ".."', 'secret/apps/me/.\r./victim/key'],
            ['a tab inside "%2e%2e"', 'secret/apps/me/%2e\t%2e/victim/key'],
            ['a NUL', 'secret/apps/me/x\u0000'],
            ['a DEL', 'secret/apps/me/x\u007f'],
            ['".." with a trailing space', 'secret/apps/me/.. '],
            ['a trailing space', 'secret/apps/me/key '],
            ['".." with a trailing C0 control', 'secret/apps/me/..\u0001'],
            ['a "#" fragment', 'secret/apps/victim#/key'],
            ['a "?" query', 'secret/apps/me/x?version=1'],
            ['a "?" that cuts the suffix', 'secret/apps/victim?/key'],
            ['an empty segment', 'secret/apps//me/key'],
            ['an empty segment before a trailing slash', 'secret/apps/me//'],
            ['an empty segment from an encoded "/"', 'secret/apps/%2F/key'],
            ['"%2f%2f"', 'secret/apps/me%2f%2fkey'],
            ['an encoded leading "/"', '%2fsecret/apps/me/key'],
            ['only slashes', '//'],
            ['an unpaired high surrogate', 'secret/apps/\ud800/key'],
            ['an unpaired low surrogate', 'secret/apps/\udfff/key'],
            ['a percent-encoded mount', 'secre%74/apps/key'],
            ['an encoded "/" right after the mount', 'secret%2fapps/key'],
        ];

        const kvCalls = [
            ['read', (c, p) => c.read(p)],
            ['list', (c, p) => c.list(p)],
            ['write', (c, p) => c.write(p, { a: 1 })],
            ['delete', (c, p) => c.delete(p)],
            ['update', (c, p) => c.update(p, { a: 1 })],
            ['deleteVersions', (c, p) => c.deleteVersions(p, [1])],
            ['undeleteVersions', (c, p) => c.undeleteVersions(p, [1])],
            ['destroyVersions', (c, p) => c.destroyVersions(p, [1])],
            ['readMetadata', (c, p) => c.readMetadata(p)],
            ['deleteMetadata', (c, p) => c.deleteMetadata(p)],
        ];

        function expectRejectedBeforeAnyRequest(client, call, path) {
            return call(client, path).then(
                () => { throw new Error(`expected rejection for ${JSON.stringify(path)}`); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                    expect(err.message).to.match(/^Invalid secret path/);
                    expect(client.__auth.getAuthToken).to.not.have.been.called;
                    expect(client.__api.makeRequest).to.not.have.been.called;
                }
            );
        }

        unsafePaths.forEach(([label, path]) => {
            it(`rejects ${label} on every KV method without sending a request`, function () {
                return kvCalls.reduce((chain, [, call]) => chain.then(() => {
                    const client = makeClient({ api: { engines: { secret: 2 } } });
                    client.__api = { makeRequest: sinon.stub().resolves({ data: { data: {} } }) };
                    return expectRejectedBeforeAnyRequest(client, call, path);
                }), Promise.resolve());
            });
        });

        it('rejects in passthrough mode (no engines, no autoDetect)', function () {
            const client = makeClient();
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return expectRejectedBeforeAnyRequest(client, (c, p) => c.read(p), 'secret/apps/me/../victim/key');
        });

        it('rejects in autoDetect mode before the detection request', function () {
            const client = makeClient({ api: { kv: { autoDetect: true } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            const resolve = sinon.spy(client.__resolver, 'resolve');
            return expectRejectedBeforeAnyRequest(client, (c, p) => c.write(p, { policy: 'x' }), 'secret/../sys/policies/acl/p')
                .then(() => {
                    expect(resolve).to.not.have.been.called;
                });
        });

        it('rejects a non-string path', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.read(undefined).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                    expect(err.message).to.equal('Invalid secret path: expected a non-empty string');
                    expect(client.__api.makeRequest).to.not.have.been.called;
                }
            );
        });

        it('rejects an empty path', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.read('').then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                    expect(err.message).to.equal('Invalid secret path: expected a non-empty string');
                    expect(client.__api.makeRequest).to.not.have.been.called;
                }
            );
        });

        it('names the failed rule in the message', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return Promise.all([
                client.read('secret/a\nb').catch((err) => err.message),
                client.read('secret/a/../b').catch((err) => err.message),
                client.read('secret/a//b').catch((err) => err.message),
            ]).then(([chars, dots, empty]) => {
                expect(chars).to.equal(
                    'Invalid secret path: \'?\', \'#\', \'\\\', control characters, unpaired surrogates and a ' +
                    'trailing space are not allowed'
                );
                expect(dots).to.equal(
                    'Invalid secret path: empty, \'.\' and \'..\' segments are not allowed ' +
                    '(nor a trailing slash in the KV v2 helpers)'
                );
                expect(empty).to.equal(dots);
            });
        });

        it('keeps the path out of the message and the error log', function () {
            // The KV methods log the rejection at error level, which the default logger
            // prints, so a path built from user data must not appear in it.
            const logger = { error: sinon.spy(), warn: sinon.spy(), info: sinon.spy(), debug: sinon.spy(), trace: sinon.spy() };
            const client = makeClient({ api: { engines: { secret: 2 } }, logger });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            const marker = 'alice@example.com';
            const paths = [
                `secret/users/${marker}/../bob/key`,
                `secret/users/${marker}?x`,
                `secret/users//${marker}`,
                `secret/users/${marker}/../${'a'.repeat(10000)}`,
            ];
            return Promise.all(paths.map((path) => client.read(path).catch((err) => err.message))).then((messages) => {
                messages.forEach((message) => expect(message).to.not.include(marker));
                expect(logger.error).to.have.callCount(paths.length);
                logger.error.getCalls().forEach((call) => {
                    expect(call.args.join(' ')).to.not.include(marker);
                });
                expect(client.__api.makeRequest).to.not.have.been.called;
            });
        });

        const safePaths = [
            ['upper case and underscores', 'secret/MyApp/DB_PASSWORD', 'secret/data/MyApp/DB_PASSWORD'],
            ['a dot inside a segment', 'secret/a.b/c', 'secret/data/a.b/c'],
            ['an inner space', 'secret/my key', 'secret/data/my key'],
            ['".." inside a segment', 'secret/a..b', 'secret/data/a..b'],
            ['a leading dot', 'secret/.hidden', 'secret/data/.hidden'],
            ['three dots', 'secret/...', 'secret/data/...'],
            ['"@"', 'secret/users/alice@example.com', 'secret/data/users/alice@example.com'],
            ['non-ASCII', 'secret/ключ/ünï', 'secret/data/ключ/ünï'],
            ['percent-encoded "?" and "#"', 'secret/k%3Fv%23w', 'secret/data/k%3Fv%23w'],
            ['an invalid escape', 'secret/100%', 'secret/data/100%'],
            ['".." inside a segment next to an escape', 'secret/..%20x', 'secret/data/..%20x'],
            ['a trailing slash', 'secret/apps/', 'secret/data/apps/'],
            ['only the mount', 'secret', 'secret/data/'],
        ];

        safePaths.forEach(([label, path, apiPath]) => {
            it(`still sends a path with ${label}`, function () {
                const client = makeClient({ api: { engines: { secret: 2 } } });
                client.__api = { makeRequest: sinon.stub().resolves({ data: { data: { k: 'v' } } }) };
                return client.read(path).then((lease) => {
                    expect(lease.getData()).to.deep.equal({ k: 'v' });
                    expect(client.__api.makeRequest).to.have.been.calledOnceWith(
                        'GET', apiPath, null, { 'X-Vault-Token': 'tid' }
                    );
                });
            });
        });

        it('rejects a trailing slash on the KV v2 helpers', function () {
            // Vault applies readMetadata('a/me/') and deleteMetadata('a/me/') to the key 'a/me'.
            const v2Helpers = ['deleteVersions', 'undeleteVersions', 'destroyVersions', 'readMetadata', 'deleteMetadata'];
            return ['secret/apps/me/', 'secret/apps/me%2f'].reduce((outer, path) => outer.then(() =>
                kvCalls.filter(([method]) => v2Helpers.includes(method)).reduce((chain, [, call]) => chain.then(() => {
                    const client = makeClient({ api: { engines: { secret: 2 } } });
                    client.__api = { makeRequest: sinon.stub().resolves({ data: { data: {} } }) };
                    return expectRejectedBeforeAnyRequest(client, call, path);
                }), Promise.resolve())), Promise.resolve());
        });

        it('still lists a folder with a trailing slash', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({ data: { keys: ['a'] } }) };
            return client.list('secret/apps/').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledOnceWith(
                    'LIST', 'secret/metadata/apps/', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('drops leading slashes before mount resolution', function () {
            // Kept, the KV v2 rewrite took '/secret/a' for the key 'secret/a' inside 'secret/'.
            const passthrough = makeClient();
            passthrough.__api = { makeRequest: sinon.stub().resolves({ data: { k: 'v' } }) };
            const v2 = makeClient({ api: { engines: { secret: 2 } } });
            v2.__api = { makeRequest: sinon.stub().resolves({ data: { data: { k: 'v' } } }) };
            return Promise.all([
                passthrough.read('/secret/a'),
                passthrough.read('//secret/b'),
                v2.read('/secret/a'),
            ]).then(() => {
                expect(passthrough.__api.makeRequest).to.have.been.calledWith('GET', 'secret/a', null, { 'X-Vault-Token': 'tid' });
                expect(passthrough.__api.makeRequest).to.have.been.calledWith('GET', 'secret/b', null, { 'X-Vault-Token': 'tid' });
                expect(v2.__api.makeRequest).to.have.been.calledOnceWith('GET', 'secret/data/a', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('still matches an engines key written with a leading slash', function () {
            // Leading slashes are dropped from the path, so they must go from the keys as well.
            const client = makeClient({ api: { engines: { '/secret': 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({ data: { data: { k: 'v' } } }) };
            return Promise.all([client.read('/secret/a'), client.read('secret/b')]).then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/a', null, { 'X-Vault-Token': 'tid' });
                expect(client.__api.makeRequest).to.have.been.calledWith('GET', 'secret/data/b', null, { 'X-Vault-Token': 'tid' });
            });
        });

        it('rejects a path that does not start with the mount it resolved to', function () {
            // autoDetect decodes the path, so 'team/k%76/a' resolves to the 'team/kv' mount; the
            // KV v2 rewrite used to send 'team/kv/data/team/k%76/a', i.e. the key 'team/kv/a'.
            const client = makeClient({ api: { kv: { autoDetect: true } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            sinon.stub(client.__resolver, 'resolve').resolves({ mount: 'team/kv/', version: 2, type: 'kv' });
            return Promise.all(['team/k%76/a', 'team/kv%2fa'].map((path) => client.read(path).then(
                () => { throw new Error(`expected rejection for ${path}`); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.InvalidArgumentsError);
                    expect(err.message).to.equal(
                        'Invalid secret path: it does not start with the mount "team/kv" it resolved to; ' +
                        'do not percent-encode the mount'
                    );
                }
            ))).then(() => {
                expect(client.__api.makeRequest).to.not.have.been.called;
            });
        });

        it('leaves request() literal', function () {
            const client = makeClient({ api: { engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.request('GET', 'secret/data/foo?version=1').then(() => {
                expect(client.__api.makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo?version=1', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });
    });

    describe('namespace stays out of per-request headers', function () {
        // The namespace is injected centrally by VaultApiClient#makeRequest, so none of
        // the pipeline entry points may add an X-Vault-Namespace header of their own.
        it('read() on a namespaced client sends only the token header', function () {
            const client = makeClient({ api: { namespace: 'ns1', engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({ data: { data: {} } }) };
            return client.read('secret/foo').then(() => {
                expect(client.__api.makeRequest.getCall(0).args[3]).to.deep.equal({ 'X-Vault-Token': 'tid' });
            });
        });

        it('update() on a namespaced client sends only token + content-type headers', function () {
            const client = makeClient({ api: { namespace: 'ns1', engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.update('secret/foo', { a: 1 }).then(() => {
                expect(client.__api.makeRequest.getCall(0).args[3]).to.deep.equal({
                    'X-Vault-Token': 'tid',
                    'Content-Type': 'application/merge-patch+json',
                });
            });
        });

        it('deleteVersions() on a namespaced client sends only the token header', function () {
            const client = makeClient({ api: { namespace: 'ns1', engines: { secret: 2 } } });
            client.__api = { makeRequest: sinon.stub().resolves({}) };
            return client.deleteVersions('secret/foo', [1]).then(() => {
                expect(client.__api.makeRequest.getCall(0).args[3]).to.deep.equal({ 'X-Vault-Token': 'tid' });
            });
        });
    });
});
