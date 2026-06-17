/**
 * Exhaustive pure-unit tests for kvTransform: rewritePath + normalizeResponse.
 * Every op x {v1, v2}.
 */

import { expect } from 'chai';
import { rewritePath, normalizeResponse } from '../src/kvTransform.js';

describe('kvTransform', function () {

    // -------------------------------------------------------------------------
    // rewritePath(version, op, mount, logicalPath)
    // -------------------------------------------------------------------------
    describe('rewritePath', function () {

        // v1 (or non-kv) — always passthrough: mount + logicalPath
        describe('v1 / non-kv (version !== 2)', function () {
            const cases = [
                ['read',           'secret', 'foo',        'secret/foo'],
                ['read',           'secret', 'foo/bar',    'secret/foo/bar'],
                ['list',           'secret', 'foo',        'secret/foo'],
                ['list',           'secret', '',           'secret'],
                ['write',          'secret', 'foo',        'secret/foo'],
                ['delete',         'secret', 'foo',        'secret/foo'],
                ['update',         'secret', 'foo',        'secret/foo'],
            ];
            cases.forEach(([op, mount, lp, expected]) => {
                it(`${op}('${mount}','${lp}') => '${expected}'`, function () {
                    expect(rewritePath(1, op, mount, lp)).to.equal(expected);
                });
            });

            // v2-only ops on v1 => still return a path (caller throws; rewritePath is pure)
            it('deleteVersions on v1 still produces a path (caller decides to throw)', function () {
                expect(rewritePath(1, 'deleteVersions', 'secret', 'foo')).to.equal('secret/foo');
            });
        });

        // v2 rewriting
        describe('v2 path rewriting', function () {
            it('read: inserts data/ segment', function () {
                expect(rewritePath(2, 'read', 'secret', 'foo')).to.equal('secret/data/foo');
            });

            it('read: nested path', function () {
                expect(rewritePath(2, 'read', 'secret', 'team/svc')).to.equal('secret/data/team/svc');
            });

            it('read: empty logical path', function () {
                expect(rewritePath(2, 'read', 'secret', '')).to.equal('secret/data/');
            });

            it('write: inserts data/ segment', function () {
                expect(rewritePath(2, 'write', 'secret', 'foo')).to.equal('secret/data/foo');
            });

            it('list: inserts metadata/ segment', function () {
                expect(rewritePath(2, 'list', 'secret', 'foo')).to.equal('secret/metadata/foo');
            });

            it('list: empty logical path', function () {
                expect(rewritePath(2, 'list', 'secret', '')).to.equal('secret/metadata/');
            });

            it('delete: inserts data/ segment (soft-delete latest)', function () {
                expect(rewritePath(2, 'delete', 'secret', 'foo')).to.equal('secret/data/foo');
            });

            it('update: inserts data/ segment', function () {
                expect(rewritePath(2, 'update', 'secret', 'foo')).to.equal('secret/data/foo');
            });

            it('deleteVersions: inserts delete/ segment', function () {
                expect(rewritePath(2, 'deleteVersions', 'secret', 'foo')).to.equal('secret/delete/foo');
            });

            it('undeleteVersions: inserts undelete/ segment', function () {
                expect(rewritePath(2, 'undeleteVersions', 'secret', 'foo')).to.equal('secret/undelete/foo');
            });

            it('destroyVersions: inserts destroy/ segment', function () {
                expect(rewritePath(2, 'destroyVersions', 'secret', 'foo')).to.equal('secret/destroy/foo');
            });

            it('readMetadata: inserts metadata/ segment', function () {
                expect(rewritePath(2, 'readMetadata', 'secret', 'foo')).to.equal('secret/metadata/foo');
            });

            it('deleteMetadata: inserts metadata/ segment', function () {
                expect(rewritePath(2, 'deleteMetadata', 'secret', 'foo')).to.equal('secret/metadata/foo');
            });

            it('mount with trailing slash is handled', function () {
                expect(rewritePath(2, 'read', 'secret/', 'foo')).to.equal('secret/data/foo');
            });

            it('mount without trailing slash, nested lp', function () {
                expect(rewritePath(2, 'read', 'kv', 'a/b/c')).to.equal('kv/data/a/b/c');
            });
        });
    });

    // -------------------------------------------------------------------------
    // normalizeResponse(version, op, body)
    // -------------------------------------------------------------------------
    describe('normalizeResponse', function () {

        // v1 — always return body unchanged
        describe('v1 / non-kv (version !== 2)', function () {
            const ops = ['read', 'list', 'write', 'delete', 'update',
                'deleteVersions', 'undeleteVersions', 'destroyVersions',
                'readMetadata', 'deleteMetadata'];

            ops.forEach((op) => {
                it(`${op} on v1 returns body unchanged`, function () {
                    const body = { data: { k: 'v' }, request_id: 'r' };
                    expect(normalizeResponse(1, op, body)).to.equal(body);
                });
            });
        });

        // v2 responses
        describe('v2 response normalization', function () {

            it('read: returns body with data replaced by body.data.data and metadata added', function () {
                const body = {
                    request_id: 'rid',
                    data: {
                        data: { username: 'admin', password: 'secret' },
                        metadata: { version: 3, created_time: '2024-01-01' },
                    },
                };
                const result = normalizeResponse(2, 'read', body);
                // Should look like a standard Vault read response with data = inner data
                expect(result.data).to.deep.equal({ username: 'admin', password: 'secret' });
                expect(result.metadata).to.deep.equal({ version: 3, created_time: '2024-01-01' });
                expect(result.request_id).to.equal('rid');
            });

            it('read: handles missing inner data gracefully', function () {
                const body = { data: {} };
                const result = normalizeResponse(2, 'read', body);
                expect(result.data).to.be.undefined;
                expect(result.metadata).to.be.undefined;
            });

            it('write: returns raw body unchanged', function () {
                const body = { data: { version: 1 }, request_id: 'r' };
                const result = normalizeResponse(2, 'write', body);
                expect(result).to.equal(body);
            });

            it('list: returns body unchanged (keys already at body.data.keys)', function () {
                const body = { data: { keys: ['foo', 'bar/'] } };
                const result = normalizeResponse(2, 'list', body);
                expect(result).to.equal(body);
            });

            it('delete: returns body unchanged', function () {
                const body = null;
                const result = normalizeResponse(2, 'delete', body);
                expect(result).to.equal(null);
            });

            it('update: returns body unchanged', function () {
                const body = { data: { version: 2 } };
                const result = normalizeResponse(2, 'update', body);
                expect(result).to.equal(body);
            });

            it('deleteVersions: returns body unchanged', function () {
                const body = {};
                const result = normalizeResponse(2, 'deleteVersions', body);
                expect(result).to.equal(body);
            });

            it('undeleteVersions: returns body unchanged', function () {
                const body = {};
                const result = normalizeResponse(2, 'undeleteVersions', body);
                expect(result).to.equal(body);
            });

            it('destroyVersions: returns body unchanged', function () {
                const body = {};
                const result = normalizeResponse(2, 'destroyVersions', body);
                expect(result).to.equal(body);
            });

            it('readMetadata: unwraps body.data', function () {
                const body = {
                    request_id: 'r',
                    data: { current_version: 2, versions: { '1': {}, '2': {} } },
                };
                const result = normalizeResponse(2, 'readMetadata', body);
                expect(result.data).to.deep.equal({ current_version: 2, versions: { '1': {}, '2': {} } });
                expect(result.request_id).to.equal('r');
            });

            it('deleteMetadata: returns body unchanged', function () {
                const body = null;
                const result = normalizeResponse(2, 'deleteMetadata', body);
                expect(result).to.equal(null);
            });
        });

        // null/undefined body edge cases
        describe('null/undefined body edge cases', function () {
            it('v1 read with null body returns null', function () {
                expect(normalizeResponse(1, 'read', null)).to.equal(null);
            });
            it('v2 delete with undefined body returns undefined', function () {
                expect(normalizeResponse(2, 'delete', undefined)).to.equal(undefined);
            });
        });
    });
});
