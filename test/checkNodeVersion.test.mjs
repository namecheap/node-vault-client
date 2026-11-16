/**
 * A DeprecationWarning when the client is loaded on Node.js 20 (#221): Node.js 20 reached
 * end-of-life on 2026-04-30, and the next major release requires Node.js 22 or later. The
 * warning is emitted once per process, when the client is loaded, and changes nothing else.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import checkNodeVersion from '../src/checkNodeVersion.js';

use(sinonChai);

const { warnIfNode20, NODE_20_DEPRECATION_CODE, NODE_20_DEPRECATION_MESSAGE } = checkNodeVersion;

const fakeProcess = (node) => ({ versions: { node }, emitWarning: sinon.stub() });

describe('Node.js 20 deprecation warning', function () {
    it('has a code in the NVC_DEP_ family and a message that names the end-of-life and the new floor', function () {
        expect(NODE_20_DEPRECATION_CODE).to.equal('NVC_DEP_NODE_20');
        expect(NODE_20_DEPRECATION_MESSAGE).to.include('Node.js 20 reached end-of-life on 2026-04-30');
        expect(NODE_20_DEPRECATION_MESSAGE).to.include('will require Node.js 22 or later');
    });

    for (const version of ['20.19.0', '20.20.2']) {
        it(`warns on Node.js ${version}, as a DeprecationWarning with the code`, function () {
            const proc = fakeProcess(version);

            expect(warnIfNode20(proc)).to.equal(true);

            expect(proc.emitWarning).to.have.been.calledOnceWithExactly(NODE_20_DEPRECATION_MESSAGE, {
                type: 'DeprecationWarning',
                code: NODE_20_DEPRECATION_CODE,
            });
        });
    }

    for (const version of ['22.0.0', '22.12.0', '24.1.0', '26.13.0', '200.0.0', '2.20.0', '120.20.0']) {
        it(`does not warn on Node.js ${version}`, function () {
            const proc = fakeProcess(version);

            expect(warnIfNode20(proc)).to.equal(false);

            expect(proc.emitWarning).not.to.have.been.called;
        });
    }

    for (const [label, proc] of [
        ['no versions', { emitWarning: sinon.stub() }],
        ['a version that is not a string', { versions: { node: 20 }, emitWarning: sinon.stub() }],
    ]) {
        it(`does not warn or throw for a process with ${label}`, function () {
            expect(warnIfNode20(proc)).to.equal(false);
            expect(proc.emitWarning).not.to.have.been.called;
        });
    }

    it('does not throw when emitWarning does', function () {
        const proc = fakeProcess('20.19.0');
        proc.emitWarning.throws(new Error('boom'));

        expect(warnIfNode20(proc)).to.equal(false);
    });

    it('checks the running process by default', function () {
        const emitWarning = sinon.stub(process, 'emitWarning');
        try {
            const onNode20 = process.versions.node.startsWith('20.');
            expect(warnIfNode20()).to.equal(onNode20);
            expect(emitWarning.callCount).to.equal(onNode20 ? 1 : 0);
        } finally {
            emitWarning.restore();
        }
    });

    describe('when the client is loaded (in a child process, which states its own Node.js version)', function () {
        // Each case starts a node process that loads the client; a busy CI runner needs more
        // than mocha's default 2 s for that.
        this.timeout(20000);

        const clientPath = JSON.stringify(fileURLToPath(new URL('../src/VaultClient.js', import.meta.url)));

        // The child reports the warnings it received on stdout. `node` is the version it claims
        // to run, or null to keep the real one.
        const script = (node) => `
            ${node ? `Object.defineProperty(process, 'versions', { value: { ...process.versions, node: ${JSON.stringify(node)} } });` : ''}
            const warnings = [];
            process.on('warning', (w) => warnings.push({ name: w.name, code: w.code, message: w.message }));
            const VaultClient = require(${clientPath});
            const options = {
                api: { url: 'https://example.com/' }, logger: false,
                auth: { type: 'token', config: { token: 'tok-123' } },
            };
            new VaultClient(options);
            new VaultClient(options);
            require(${clientPath});
            setImmediate(() => process.stdout.write(JSON.stringify(warnings)));
        `;

        function run(node, args = []) {
            return new Promise((resolve, reject) => {
                execFile(process.execPath, [...args, '-e', script(node)], (err, stdout, stderr) => {
                    if (err) {
                        reject(Object.assign(err, { stderr }));
                        return;
                    }
                    resolve({ warnings: JSON.parse(stdout), stderr });
                });
            });
        }

        it('warns once on Node.js 20, however many clients are created', async function () {
            const { warnings, stderr } = await run('20.19.0');

            expect(warnings).to.deep.equal([{
                name: 'DeprecationWarning',
                code: NODE_20_DEPRECATION_CODE,
                message: NODE_20_DEPRECATION_MESSAGE,
            }]);
            expect(stderr).to.include(`[${NODE_20_DEPRECATION_CODE}] DeprecationWarning: node-vault-client:`);
        });

        it('does not warn on a later Node.js', async function () {
            const { warnings, stderr } = await run('22.12.0');

            expect(warnings).to.deep.equal([]);
            expect(stderr).not.to.include(NODE_20_DEPRECATION_CODE);
        });

        it('warns on the Node.js this suite runs on only when that is Node.js 20', async function () {
            const { warnings } = await run(null);

            expect(warnings.map((w) => w.code)).to.deep.equal(
                process.versions.node.startsWith('20.') ? [NODE_20_DEPRECATION_CODE] : []);
        });

        it('follows --no-deprecation like any other deprecation', async function () {
            const { warnings, stderr } = await run('20.19.0', ['--no-deprecation']);

            expect(warnings).to.deep.equal([]);
            expect(stderr).not.to.include(NODE_20_DEPRECATION_CODE);
        });
    });
});
