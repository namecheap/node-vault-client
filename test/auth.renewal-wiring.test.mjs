/**
 * Per-backend wiring for the renewal options.
 *
 * The base class holds the behaviour, but every backend has to forward its `config` to
 * `super(...)` for any of it to reach a real user. Nothing else covers those five one-line
 * forwards: the suites in auth.base.test.mjs drive a local subclass that supplies `config`
 * itself, so deleting all five forwards — turning `renewal`, `renewalFraction` and
 * `renewalIncrement` into no-ops for every backend anyone actually constructs — leaves them
 * green. This file is the matrix that fails instead, in the shape namespace.test.mjs uses
 * for the same class of per-backend guarantee.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultTokenAuth from '../src/auth/VaultTokenAuth.js';
import VaultAppRoleAuth from '../src/auth/VaultAppRoleAuth.js';
import VaultIAMAuth from '../src/auth/VaultIAMAuth.js';
import VaultKubernetesAuth from '../src/auth/VaultKubernetesAuth.js';
import VaultJwtAuth from '../src/auth/VaultJwtAuth.js';
import errors from '../src/errors.js';
import { createNoopLogger } from './helpers/logger.mjs';

use(sinonChai);

const logger = createNoopLogger();
const TYPES = ['token', 'appRole', 'iam', 'kubernetes', 'jwt'];

/** A renewable token with real TTL, so a timer is armed unless renewal is off. */
function stubFetch() {
    return sinon.stub(global, 'fetch').callsFake((url) => {
        const pathname = new URL(url).pathname;
        const now = Math.floor(Date.now() / 1000);
        let body = {};
        if (pathname.endsWith('/auth/token/lookup-self')) {
            body = { data: { id: 'tok', accessor: 'acc', creation_time: now, ttl: 3600, renewable: true } };
        } else if (pathname.endsWith('/login')) {
            body = { auth: { client_token: 'tok', accessor: 'acc' } };
        }
        return Promise.resolve(new Response(JSON.stringify(body), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
    });
}

describe('renewal options reach every auth backend (#17)', function () {
    let fetchStub;
    let jwtFile;

    before(function () {
        jwtFile = path.join(os.tmpdir(), `nvc-renewal-wiring-${process.pid}.jwt`);
        fs.writeFileSync(jwtFile, 'header.payload.sig');
    });

    after(function () {
        try { fs.unlinkSync(jwtFile); } catch { /* ignore */ }
    });

    beforeEach(function () {
        fetchStub = stubFetch();
    });

    afterEach(function () {
        fetchStub.restore();
    });

    function makeAuth(type, config) {
        const api = new VaultApiClient({ url: 'https://vault.example' }, logger);
        switch (type) {
            case 'token':
                return new VaultTokenAuth(api, logger, { token: 'tok', ...config });
            case 'appRole':
                return new VaultAppRoleAuth(api, logger, { role_id: 'r', secret_id: 's', ...config });
            case 'iam':
                return new VaultIAMAuth(api, logger, {
                    role: 'r',
                    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
                    ...config,
                });
            case 'kubernetes':
                return new VaultKubernetesAuth(api, logger, { role: 'r', tokenPath: jwtFile, ...config });
            case 'jwt':
                return new VaultJwtAuth(api, logger, { role: 'r', jwt: 'header.payload.sig', ...config });
            default:
                throw new Error(`unknown type ${type}`);
        }
    }

    TYPES.forEach((type) => {
        it(`"${type}" arms a refresh timer by default`, async function () {
            const auth = makeAuth(type, {});
            await auth.getAuthToken();
            expect(auth.__refreshTimeout, `${type} should arm a timer`).to.not.equal(null);
            auth.cancelTokenRefresh();
        });

        it(`"${type}" honours renewal: false`, async function () {
            const auth = makeAuth(type, { renewal: false });
            await auth.getAuthToken();
            expect(auth.__refreshTimeout, `${type} must not arm a timer`).to.equal(null);
        });

        it(`"${type}" validates renewalFraction, so the config reaches the base class`, function () {
            expect(() => makeAuth(type, { renewalFraction: 5 }))
                .to.throw(errors.InvalidArgumentsError, 'renewalFraction');
        });

        it(`"${type}" validates renewalIncrement`, function () {
            expect(() => makeAuth(type, { renewalIncrement: -1 }))
                .to.throw(errors.InvalidArgumentsError, 'renewalIncrement');
        });
    });
});
