/**
 * Per-backend wiring for the renewal options.
 *
 * The base class holds the behaviour, but VaultClient has to apply the options for any of it
 * to reach a real user. The suites in auth.base.test.mjs drive a local subclass that applies
 * them itself, so dropping the wiring in VaultClient — turning `renewal`, `renewalFraction`
 * and `renewalIncrement` into no-ops for every backend anyone actually constructs — leaves
 * them green. This file drives the real path instead, for every auth type, in the shape
 * namespace.test.mjs uses for the same class of per-backend guarantee.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import errors from '../src/errors.js';

use(sinonChai);

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

    const CONFIGS = {
        token: { token: 'tok' },
        appRole: { role_id: 'r', secret_id: 's' },
        iam: { role: 'r', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } },
        jwt: { role: 'r', jwt: 'header.payload.sig' },
    };

    /** Builds through VaultClient, the path a consumer actually uses. */
    function makeAuth(type, renewalOpts) {
        const config = type === 'kubernetes' ? { role: 'r', tokenPath: jwtFile } : CONFIGS[type];
        const client = new VaultClient({
            api: { url: 'https://vault.example' },
            logger: false,
            auth: { type, config, ...renewalOpts },
        });
        return client.__auth;
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
