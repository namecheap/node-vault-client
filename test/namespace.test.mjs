/**
 * Namespace conformance (regression #106).
 *
 * X-Vault-Namespace must be applied to *every* request — login, token
 * lookup-self, and renewal — for all four auth backends, not just the two
 * (AppRole/IAM) that used to build the header themselves. These tests drive a
 * real VaultApiClient with a stubbed global fetch and assert the header on the
 * wire for each request, so a backend that skips namespacing (as token and
 * kubernetes did on lookup-self / login) fails here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import _ from 'lodash';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';

use(sinonChai);

const logger = _.fromPairs(_.map(['error', 'warn', 'info', 'debug', 'trace'], (p) => [p, _.noop]));

// Canned Vault responses keyed by request path.
function bodyFor(pathname) {
    if (pathname.endsWith('/auth/token/lookup-self')) {
        return { data: { id: 'tok', accessor: 'acc', creation_time: 1600000000, ttl: 0, renewable: false } };
    }
    if (pathname.endsWith('/login')) {
        return { auth: { client_token: 'tok', accessor: 'acc' } };
    }
    return {};
}

function stubFetch() {
    return sinon.stub(global, 'fetch').callsFake((url) => {
        const pathname = new URL(url).pathname;
        return Promise.resolve(new Response(JSON.stringify(bodyFor(pathname)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
    });
}

const TYPES = ['token', 'appRole', 'iam', 'kubernetes'];

describe('X-Vault-Namespace is applied to every request (regression #106)', function () {
    let fetchStub;
    let jwtPath;

    before(function () {
        jwtPath = path.join(os.tmpdir(), 'node-vault-client-k8s-jwt.test');
        fs.writeFileSync(jwtPath, 'fake.kubernetes.jwt');
    });

    after(function () {
        try { fs.unlinkSync(jwtPath); } catch { /* ignore */ }
    });

    beforeEach(function () {
        fetchStub = stubFetch();
    });

    afterEach(function () {
        fetchStub.restore();
    });

    function makeAuth(type, api) {
        switch (type) {
            case 'token':
                return new VaultTokenAuth(api, logger, { token: 'tok' });
            case 'appRole':
                return new VaultAppRoleAuth(api, logger, { role_id: 'r', secret_id: 's' });
            case 'iam':
                return new VaultIAMAuth(api, logger, {
                    role: 'r',
                    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
                });
            case 'kubernetes':
                return new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: jwtPath });
            default:
                throw new Error(`unknown type ${type}`);
        }
    }

    function requests() {
        return fetchStub.getCalls().map((c) => ({
            path: new URL(c.args[0]).pathname,
            namespace: c.args[1].headers['X-Vault-Namespace'],
        }));
    }

    TYPES.forEach((type) => {
        it(`sends the namespace header on every request for the "${type}" backend`, async function () {
            const api = new VaultApiClient({ url: 'https://vault.example' }, logger, 'team-a');

            await makeAuth(type, api).getAuthToken();

            const reqs = requests();
            expect(reqs.length, `${type} should make at least one request`).to.be.greaterThan(0);
            // The token lookup-self path is exactly what used to bypass the namespace.
            expect(
                reqs.some((r) => r.path.endsWith('/auth/token/lookup-self')),
                `${type} should look the token up via /auth/token/lookup-self`,
            ).to.equal(true);
            reqs.forEach((r) => {
                expect(r.namespace, `namespace missing on ${r.path} for ${type}`).to.equal('team-a');
            });
        });

        it(`sends no namespace header for the "${type}" backend when none is configured`, async function () {
            const api = new VaultApiClient({ url: 'https://vault.example' }, logger);

            await makeAuth(type, api).getAuthToken();

            requests().forEach((r) => {
                expect(r.namespace, `unexpected namespace on ${r.path} for ${type}`).to.equal(undefined);
            });
        });
    });

    it('lets an explicit per-request X-Vault-Namespace header override the configured default', async function () {
        const api = new VaultApiClient({ url: 'https://vault.example' }, logger, 'team-a');
        await api.makeRequest('GET', '/sys/health', null, { 'X-Vault-Namespace': 'team-b' });
        expect(requests()[0].namespace).to.equal('team-b');
    });
});
