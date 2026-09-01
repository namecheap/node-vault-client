import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const checks = [
    {
        name: 'entry point loads and exposes the documented statics',
        source: `
            const VaultClient = require('node-vault-client');
            assert.strictEqual(typeof VaultClient, 'function');
            for (const name of ['boot', 'get', 'clear']) {
                assert.strictEqual(typeof VaultClient[name], 'function', name + ' is missing');
            }
        `,
    },
    {
        name: 'a client can be constructed',
        source: `
            const VaultClient = require('node-vault-client');
            const client = new VaultClient({
                api: { url: 'http://127.0.0.1:8200' },
                auth: { type: 'token', config: { token: 't' } },
                logger: false,
            });
            assert.strictEqual(typeof client.read, 'function');
            client.close();
        `,
    },
    {
        name: 'the errors subpath resolves with every class',
        source: `
            const errors = require('node-vault-client/src/errors');
            const expected = [
                'VaultError', 'InvalidArgumentsError', 'InvalidAWSCredentialsError',
                'AuthTokenExpiredError', 'UnsupportedOperationError', 'VaultHttpError',
            ];
            assert.deepStrictEqual(Object.keys(errors).sort(), expected.slice().sort());
            assert.ok(new errors.UnsupportedOperationError('x') instanceof errors.VaultError);
        `,
    },
];

const workdir = mkdtempSync(join(tmpdir(), 'nvc-verify-package-'));

try {
    const tarball = run('npm', ['pack', '--silent'], repo).trim().split('\n').pop();
    renameSync(join(repo, tarball), join(workdir, tarball));

    writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: 'nvc-verify-package', private: true }));
    run('npm', ['install', '--no-audit', '--no-fund', `./${tarball}`], workdir);

    let failed = 0;

    for (const check of checks) {
        const file = join(workdir, `${checks.indexOf(check)}.cjs`);
        writeFileSync(file, `const assert = require('node:assert');\n${check.source}`);

        try {
            run('node', [file], workdir);
            process.stdout.write(`  ok    ${check.name}\n`);
        } catch (err) {
            failed += 1;
            process.stdout.write(`  FAIL  ${check.name}\n`);
            const output = (err.stderr || err.message).trim().split('\n');
            const cause = output.filter((line) => /Error|Cannot find module/.test(line)).slice(0, 2);
            process.stdout.write(`${(cause.length ? cause : output.slice(0, 2)).map((l) => `        ${l.trim()}`).join('\n')}\n`);
        }
    }

    process.stdout.write(`\n  ${checks.length - failed}/${checks.length} checks passed against the packed tarball\n`);

    if (failed > 0) {
        process.stdout.write('\n  The published package would be broken. Check the "files" list in package.json.\n');
        process.exitCode = 1;
    }
} finally {
    rmSync(workdir, { recursive: true, force: true });
}

