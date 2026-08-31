/**
 * E2E for the JWT auth backend (#130/#134) against the real dev-mode Vault
 * started by docker-compose (127.0.0.1:8200). TDD: red until #131 lands.
 *
 * Setup follows the AppRole precedent in e2e.test.mjs: policy -> enable the
 * method -> configure -> role, all via the root token, and idempotent so the
 * suite can rerun against a running stack. Teardown disables the method again
 * so this suite leaves the shared dev server as it found it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import VaultClient from '../../src/VaultClient.js';
import errors from '../../src/errors.js';
import { publicKeyPem, signJwt } from './sign-jwt.mjs';

const VAULT = 'http://127.0.0.1:8200/';
const ROOT = '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78'; // see docker-compose.yml
const AUD = 'nvc-e2e';

async function rp(opts) {
    const response = await fetch(opts.uri, {
        method: opts.method || 'GET',
        headers: Object.assign(
            { Accept: 'application/json', 'X-Vault-Token': ROOT },
            opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}
        ),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok && !(opts.tolerate || []).some((t) => text.includes(t))) {
        throw new Error(`${response.status} - ${text}`);
    }
    return text ? JSON.parse(text) : undefined;
}

function claims(overrides) {
    const now = Math.floor(Date.now() / 1000);
    return Object.assign({ aud: AUD, sub: 'e2e-user', iat: now, exp: now + 300 }, overrides);
}

describe('E2E: JWT auth backend', function () {
    before(async function () {
        await rp({ method: 'PUT', uri: `${VAULT}v1/sys/policy/jwt-tst`, body: {
            rules: 'path "secret/jwt-tst" {capabilities = ["read"]}',
        } });
        await rp({ method: 'POST', uri: `${VAULT}v1/sys/auth/jwt`, body: { type: 'jwt' },
            tolerate: ['path is already in use'] });
        await rp({ method: 'POST', uri: `${VAULT}v1/auth/jwt/config`, body: {
            jwt_validation_pubkeys: [publicKeyPem],
        } });
        await rp({ method: 'POST', uri: `${VAULT}v1/auth/jwt/role/tst`, body: {
            role_type: 'jwt', bound_audiences: [AUD], user_claim: 'sub', token_policies: 'jwt-tst',
        } });
        await rp({ method: 'POST', uri: `${VAULT}v1/secret/jwt-tst`, body: { hello: 'from-jwt' } });
    });

    after(async function () {
        await rp({ method: 'DELETE', uri: `${VAULT}v1/sys/auth/jwt`, tolerate: ['no matching mount'] });
        await rp({ method: 'DELETE', uri: `${VAULT}v1/sys/policy/jwt-tst`, tolerate: ['404'] });
    });

    afterEach(function () {
        VaultClient.clear();
    });

    function boot(config) {
        return new VaultClient({
            api: { url: VAULT },
            logger: false,
            auth: { type: 'jwt', config },
        });
    }

    it('authenticates with a literal signed JWT and reads a secret', async function () {
        const client = boot({ role: 'tst', jwt: signJwt(claims()) });
        const lease = await client.read('secret/jwt-tst');
        expect(lease.getValue('hello')).to.equal('from-jwt');
    });

    it('authenticates with a JWT read from a file (jwtPath)', async function () {
        const jwtFile = path.join(os.tmpdir(), `nvc-e2e-${process.pid}.jwt`);
        fs.writeFileSync(jwtFile, signJwt(claims()));
        try {
            const client = boot({ role: 'tst', jwtPath: jwtFile });
            const lease = await client.read('secret/jwt-tst');
            expect(lease.getValue('hello')).to.equal('from-jwt');
        } finally {
            fs.unlinkSync(jwtFile);
        }
    });

    it('rejects a JWT with the wrong audience as VaultHttpError 400', async function () {
        const client = boot({ role: 'tst', jwt: signJwt(claims({ aud: 'someone-else' })) });
        let thrown;
        try { await client.read('secret/jwt-tst'); } catch (err) { thrown = err; }
        expect(thrown).to.be.instanceOf(errors.VaultHttpError);
        expect(thrown.statusCode).to.equal(400);
    });

    it('rejects an expired JWT as VaultHttpError 400', async function () {
        const now = Math.floor(Date.now() / 1000);
        const client = boot({ role: 'tst', jwt: signJwt(claims({ iat: now - 600, exp: now - 300 })) });
        let thrown;
        try { await client.read('secret/jwt-tst'); } catch (err) { thrown = err; }
        expect(thrown).to.be.instanceOf(errors.VaultHttpError);
        expect(thrown.statusCode).to.equal(400);
    });
});
