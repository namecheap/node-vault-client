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

    /**
     * A client whose API layer is a stub resolving `response`.
     *
     * These tests drive the pipeline through VaultClient's public methods, but
     * its collaborators (`__auth`, `__api`) are private, so the doubles have to
     * be installed on those properties. Both factories keep that coupling in
     * one place: if the internals are renamed, only these two functions change,
     * instead of the twenty-odd call sites that used to reach in directly.
     */
    function makeClientWithApi(overrides, response) {
        const client = makeClient(overrides);
        const makeRequest = sinon.stub().resolves(response);
        client.__api = { makeRequest };
        return { client, makeRequest };
    }

    describe('#__resolveAndRequest() contract', function () {
        it('resolves { body, version, mount, apiPath } on a KV v2 mount', function () {
            const body = { data: { data: { k: 'v' } } };
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, body);
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null).then((result) => {
                expect(result.body).to.equal(body);
                expect(result.version).to.equal(2);
                expect(result.mount).to.equal('secret');
                expect(result.apiPath).to.equal('secret/data/foo');
                expect(makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('merges extraHeaders over the token header', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null, { 'X-Extra': '1' }).then(() => {
                expect(makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'tid', 'X-Extra': '1' }
                );
            });
        });

        it('lets extraHeaders win over the token header on a key collision', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            return client.__resolveAndRequest('read', 'GET', 'secret/foo', null, { 'X-Vault-Token': 'other' }).then(() => {
                expect(makeRequest).to.have.been.calledWith(
                    'GET', 'secret/data/foo', null, { 'X-Vault-Token': 'other' }
                );
            });
        });

        it('wraps non-null data in { data } for the update op on v2', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            return client.__resolveAndRequest('update', 'PATCH', 'secret/foo', { a: 1 }).then(() => {
                expect(makeRequest).to.have.been.calledWith(
                    'PATCH', 'secret/data/foo', { data: { a: 1 } }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('does not wrap null data for the write op on v2', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            return client.__resolveAndRequest('write', 'POST', 'secret/foo', null).then(() => {
                expect(makeRequest.getCall(0).args[2]).to.equal(null);
            });
        });

        it('does not wrap undefined data for the write op on v2', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            return client.__resolveAndRequest('write', 'POST', 'secret/foo', undefined).then(() => {
                expect(makeRequest.getCall(0).args[2]).to.equal(undefined);
            });
        });

        it('keeps the literal path (incl. trailing slash) and unwrapped data on v1', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { legacy: 1 } } }, {});
            return client.__resolveAndRequest('write', 'POST', 'legacy/foo/', { a: 1 }).then((result) => {
                expect(result.version).to.equal(1);
                expect(result.apiPath).to.equal('legacy/foo/');
                expect(makeRequest).to.have.been.calledWith(
                    'POST', 'legacy/foo/', { a: 1 }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('resolves the mount exactly once per call', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, { data: { data: {} } });
            // Spying on the private resolver is deliberate here: "exactly once" is a
            // claim about the pipeline's internal wiring, which is what this file
            // exists to pin (see the header). The request assertion below is the
            // observable half of the same claim -- one resolution, one request.
            const resolve = sinon.spy(client.__resolver, 'resolve');
            return client.read('secret/foo').then(() => {
                expect(resolve).to.have.been.calledOnceWith('secret/foo');
                expect(makeRequest).to.have.been.calledOnce;
            });
        });
    });

    describe('#update() across mount versions', function () {
        it('returns the raw response body on v2', function () {
            const response = { data: { version: 4 } };
            const { client } = makeClientWithApi({ api: { engines: { secret: 2 } } }, response);
            return client.update('secret/foo', { a: 1 }).then((res) => {
                expect(res).to.equal(response);
            });
        });

        it('keeps the literal path and still wraps the body in { data } on a v1 mount', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { legacy: 1 } } }, {});
            return client.update('legacy/foo', { a: 1 }).then(() => {
                const [method, path, data, headers] = makeRequest.getCall(0).args;
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
            const { client, makeRequest } = makeClientWithApi({}, {});
            return client.update('any/path/', { a: 1 }).then(() => {
                const [method, path, data, headers] = makeRequest.getCall(0).args;
                expect(method).to.equal('PATCH');
                expect(path).to.equal('any/path/');
                expect(data).to.deep.equal({ data: { a: 1 } });
                expect(headers['Content-Type']).to.equal('application/merge-patch+json');
            });
        });

        it('rejects with the underlying error', function () {
            const boom = new Error('boom');
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } });
            makeRequest.rejects(boom);
            return client.update('secret/foo', { a: 1 }).then(
                () => { throw new Error('expected rejection'); },
                (err) => { expect(err).to.equal(boom); }
            );
        });
    });

    describe('#request() raw passthrough', function () {
        it('never consults the mount resolver', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 2 } } }, {});
            const resolve = sinon.spy(client.__resolver, 'resolve');
            return client.request('GET', 'secret/x').then(() => {
                expect(resolve).to.not.have.been.called;
                // Even though "secret" is a v2 mount, the raw path is sent untouched
                expect(makeRequest).to.have.been.calledWith(
                    'GET', 'secret/x', null, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('preserves a leading slash in the literal path', function () {
            const { client, makeRequest } = makeClientWithApi({}, {});
            return client.request('GET', '/sys/mounts', { type: 'kv' }).then(() => {
                expect(makeRequest).to.have.been.calledWith(
                    'GET', '/sys/mounts', { type: 'kv' }, { 'X-Vault-Token': 'tid' }
                );
            });
        });

        it('rejects with the underlying error', function () {
            const boom = new Error('boom');
            const { client, makeRequest } = makeClientWithApi({});
            makeRequest.rejects(boom);
            return client.request('GET', 'sys/health').then(
                () => { throw new Error('expected rejection'); },
                (err) => { expect(err).to.equal(boom); }
            );
        });
    });

    describe('v2-only version assertion', function () {
        it('rejects before making any HTTP request on a v1 mount', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { engines: { secret: 1 } } }, {});
            return client.deleteVersions('secret/foo', [1]).then(
                () => { throw new Error('expected rejection'); },
                (err) => {
                    expect(err).to.be.instanceOf(errors.UnsupportedOperationError);
                    expect(err.message).to.equal(
                        'Operation "deleteVersions" is only supported on KV v2 mounts. ' +
                        'Mount "secret" is not a KV v2 engine.'
                    );
                    expect(makeRequest).to.not.have.been.called;
                }
            );
        });

        it('rejects on a passthrough mount when the resolver is disabled', function () {
            const { client } = makeClientWithApi({}, {});
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
            const response = { request_id: 'r' };
            const { client } = makeClientWithApi({ api: { engines: { secret: 2 } } }, response);
            return client.deleteMetadata('secret/foo').then((res) => {
                expect(res).to.equal(response);
            });
        });
    });

    describe('namespace stays out of per-request headers', function () {
        // The namespace is injected centrally by VaultApiClient#makeRequest, so none of
        // the pipeline entry points may add an X-Vault-Namespace header of their own.
        it('read() on a namespaced client sends only the token header', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { namespace: 'ns1', engines: { secret: 2 } } }, { data: { data: {} } });
            return client.read('secret/foo').then(() => {
                expect(makeRequest.getCall(0).args[3]).to.deep.equal({ 'X-Vault-Token': 'tid' });
            });
        });

        it('update() on a namespaced client sends only token + content-type headers', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { namespace: 'ns1', engines: { secret: 2 } } }, {});
            return client.update('secret/foo', { a: 1 }).then(() => {
                expect(makeRequest.getCall(0).args[3]).to.deep.equal({
                    'X-Vault-Token': 'tid',
                    'Content-Type': 'application/merge-patch+json',
                });
            });
        });

        it('deleteVersions() on a namespaced client sends only the token header', function () {
            const { client, makeRequest } = makeClientWithApi({ api: { namespace: 'ns1', engines: { secret: 2 } } }, {});
            return client.deleteVersions('secret/foo', [1]).then(() => {
                expect(makeRequest.getCall(0).args[3]).to.deep.equal({ 'X-Vault-Token': 'tid' });
            });
        });
    });
});
