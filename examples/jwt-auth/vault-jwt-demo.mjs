#!/usr/bin/env node
/**
 * Runnable demo + smoke test for the JWT auth backend against a REAL Vault.
 *
 * It configures a throwaway `jwt` auth mount, runs positive and negative
 * scenarios through the client, prints what each one did, cleans up, and exits
 * non-zero if any scenario behaved differently than documented.
 *
 *   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<root> node vault-jwt-demo.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VaultClient = require('../../src/VaultClient.js');
const errors = require('../../src/errors.js');

const ADDR = (process.env.VAULT_ADDR || 'http://127.0.0.1:8200').replace(/\/?$/, '/');
const ROOT = process.env.VAULT_TOKEN || '8274d2a1-c80c-ff56-c6ed-1b99f7bcea78';
const AUD = 'demo-audience';
const SECRET_PATH = 'secret/jwt-demo';

// --- a throwaway signing key: this stands in for your identity provider ------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

function signJwt(claims, key = privateKey) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

function claims(over = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { aud: AUD, sub: 'demo-user', iat: now, exp: now + 300, ...over };
}

async function vault(method, apiPath, body) {
    const res = await fetch(ADDR + 'v1/' + apiPath, {
        method,
        headers: { 'X-Vault-Token': ROOT, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function setup() {
    await vault('PUT', 'sys/policy/jwt-demo', { rules: `path "${SECRET_PATH}" {capabilities = ["read"]}` });
    for (const mount of ['jwt', 'gha']) {
        await vault('POST', `sys/auth/${mount}`, { type: 'jwt' });
        await vault('POST', `auth/${mount}/config`, {
            jwt_validation_pubkeys: [publicKey.export({ type: 'spki', format: 'pem' })],
        });
        await vault('POST', `auth/${mount}/role/demo`, {
            role_type: 'jwt', bound_audiences: [AUD], user_claim: 'sub', token_policies: 'jwt-demo',
        });
        // A default_role lets a client omit `role` entirely.
        await vault('POST', `auth/${mount}/config`, {
            jwt_validation_pubkeys: [publicKey.export({ type: 'spki', format: 'pem' })],
            default_role: 'demo',
        });
    }
    // A role whose policy grants nothing, to show auth success vs authz failure.
    await vault('POST', 'auth/jwt/role/no-access', {
        role_type: 'jwt', bound_audiences: [AUD], user_claim: 'sub', token_policies: 'default',
    });
    await vault('POST', SECRET_PATH, { message: 'hello from vault' });
}

async function teardown() {
    for (const mount of ['jwt', 'gha']) await vault('DELETE', `sys/auth/${mount}`);
    await vault('DELETE', 'sys/policy/jwt-demo');
    await vault('DELETE', SECRET_PATH);
}

let clients = 0;
function boot(config, mount) {
    const auth = { type: 'jwt', config };
    if (mount) auth.mount = mount;
    return VaultClient.boot(`demo-${clients++}`, { api: { url: ADDR }, logger: false, auth });
}

/** Read the demo secret; returns its value or throws. */
const read = async (client) => (await client.read(SECRET_PATH)).getValue('message');

// ---------------------------------------------------------------- scenarios
const scenarios = [
    // ---- positive ---------------------------------------------------------
    {
        kind: '+', name: 'literal JWT string',
        expect: 'reads the secret',
        run: async () => read(boot({ role: 'demo', jwt: signJwt(claims()) })),
        ok: (r) => r === 'hello from vault',
    },
    {
        kind: '+', name: 'JWT from a file (jwtPath)',
        expect: 'reads the secret',
        run: async () => {
            const file = path.join(os.tmpdir(), `demo-${process.pid}.jwt`);
            fs.writeFileSync(file, signJwt(claims()));
            try { return await read(boot({ role: 'demo', jwtPath: file })); }
            finally { fs.unlinkSync(file); }
        },
        ok: (r) => r === 'hello from vault',
    },
    {
        kind: '+', name: 'JWT minted per login (jwtProvider)',
        expect: 'reads the secret; provider called once',
        run: async () => {
            let calls = 0;
            const client = boot({ role: 'demo', jwtProvider: async () => { calls++; return signJwt(claims()); } });
            const value = await read(client);
            return `${value} / provider calls: ${calls}`;
        },
        ok: (r) => r === 'hello from vault / provider calls: 1',
    },
    {
        kind: '+', name: 'role omitted -> mount default_role',
        expect: 'reads the secret',
        run: async () => read(boot({ jwt: signJwt(claims()) })),
        ok: (r) => r === 'hello from vault',
    },
    {
        kind: '+', name: 'custom mount ("gha")',
        expect: 'reads the secret',
        run: async () => read(boot({ role: 'demo', jwt: signJwt(claims()) }, 'gha')),
        ok: (r) => r === 'hello from vault',
    },
    {
        kind: '+', name: 'one login serves many reads',
        expect: 'provider called once for 3 reads',
        run: async () => {
            let calls = 0;
            const client = boot({ role: 'demo', jwtProvider: async () => { calls++; return signJwt(claims()); } });
            await Promise.all([read(client), read(client), read(client)]);
            return `provider calls: ${calls}`;
        },
        ok: (r) => r === 'provider calls: 1',
    },

    // ---- negative ---------------------------------------------------------
    {
        kind: '-', name: 'wrong audience',
        expect: 'VaultHttpError 400',
        run: () => read(boot({ role: 'demo', jwt: signJwt(claims({ aud: 'not-the-audience' })) })),
        ok: (r) => r instanceof errors.VaultHttpError && r.statusCode === 400,
    },
    {
        kind: '-', name: 'expired JWT',
        expect: 'VaultHttpError 400',
        run: () => {
            const now = Math.floor(Date.now() / 1000);
            return read(boot({ role: 'demo', jwt: signJwt(claims({ iat: now - 600, exp: now - 300 })) }));
        },
        ok: (r) => r instanceof errors.VaultHttpError && r.statusCode === 400,
    },
    {
        kind: '-', name: 'signature from an untrusted key',
        expect: 'VaultHttpError 400',
        run: () => read(boot({ role: 'demo', jwt: signJwt(claims(), otherKey) })),
        ok: (r) => r instanceof errors.VaultHttpError && r.statusCode === 400,
    },
    {
        kind: '-', name: 'role that does not exist',
        expect: 'VaultHttpError 400',
        run: () => read(boot({ role: 'nope', jwt: signJwt(claims()) })),
        ok: (r) => r instanceof errors.VaultHttpError && r.statusCode === 400,
    },
    {
        kind: '-', name: 'valid login, policy denies the path',
        expect: 'VaultHttpError 403 (authn ok, authz denied)',
        run: () => read(boot({ role: 'no-access', jwt: signJwt(claims()) })),
        ok: (r) => r instanceof errors.VaultHttpError && r.statusCode === 403,
    },
    {
        kind: '-', name: 'no JWT source configured',
        expect: 'InvalidArgumentsError at construction',
        run: async () => boot({ role: 'demo' }),
        ok: (r) => r instanceof errors.InvalidArgumentsError,
    },
    {
        kind: '-', name: 'two JWT sources configured',
        expect: 'InvalidArgumentsError at construction',
        run: async () => boot({ role: 'demo', jwt: signJwt(claims()), jwtPath: '/tmp/x' }),
        ok: (r) => r instanceof errors.InvalidArgumentsError,
    },
    {
        kind: '-', name: 'jwtProvider that is not a function',
        expect: 'InvalidArgumentsError at construction',
        run: async () => boot({ role: 'demo', jwtProvider: 'nope' }),
        ok: (r) => r instanceof errors.InvalidArgumentsError,
    },
    {
        kind: '-', name: 'jwtProvider resolving a non-string',
        expect: 'InvalidArgumentsError, no login attempted',
        run: () => read(boot({ role: 'demo', jwtProvider: async () => 42 })),
        ok: (r) => r instanceof errors.InvalidArgumentsError,
    },
    {
        kind: '-', name: 'jwtProvider that rejects',
        expect: "the provider's own error propagates",
        run: () => read(boot({ role: 'demo', jwtProvider: async () => { throw new Error('IdP unavailable'); } })),
        ok: (r) => r instanceof Error && r.message === 'IdP unavailable',
    },
];

// ---------------------------------------------------------------- runner
const pad = (s, n) => String(s).padEnd(n);

async function main() {
    console.log(`\nVault: ${ADDR}\n`);
    await setup();

    let failures = 0;
    for (const s of scenarios) {
        let outcome;
        try { outcome = await s.run(); } catch (err) { outcome = err; }
        const passed = s.ok(outcome);
        if (!passed) failures++;
        const actual = outcome instanceof Error ? `${outcome.constructor.name}${outcome.statusCode ? ' ' + outcome.statusCode : ''}` : String(outcome);
        console.log(`  ${passed ? '✓' : '✗'} ${s.kind} ${pad(s.name, 38)} expected: ${pad(s.expect, 44)} got: ${actual}`);
    }

    VaultClient.clear();
    await teardown();

    const positives = scenarios.filter((s) => s.kind === '+').length;
    console.log(`\n${scenarios.length} scenarios (${positives} positive, ${scenarios.length - positives} negative), ${failures} unexpected\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
    console.error('demo failed to run:', err);
    try { VaultClient.clear(); await teardown(); } catch { /* best effort */ }
    process.exit(2);
});
