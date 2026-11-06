/**
 * CI and release tooling hygiene (#229). The publish job holds the npm trusted-publishing
 * credential (id-token: write): no workflow may fetch and run a package from outside the
 * lockfile, the publish job's installs run no lifecycle scripts, and what verify-package pulls
 * from the registry is installed and loaded without the job's credentials. The workflow checks
 * read the files as text: a regression here is a line someone adds, not behaviour a test run
 * would show.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'chai';
import { sandboxEnv } from './helpers/sandboxEnv.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);

const workflowDir = '.github/workflows';
const workflows = readdirSync(new URL(`../${workflowDir}/`, import.meta.url))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: read(`${workflowDir}/${name}`) }));

/**
 * The shell lines of a workflow: every `run:` value, one-line or block, without comments.
 * Step names and YAML comments may mention a command without running it.
 */
function runLines(text) {
    const lines = text.split('\n');
    const commands = [];
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
        if (!match) {
            continue;
        }
        if (/^[|>]/.test(match[2])) {
            const indent = match[1].length;
            for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i++) {
                commands.push(lines[i]);
            }
            i--;
        } else {
            commands.push(match[2]);
        }
    }
    return commands
        .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
        .filter((line) => line !== '');
}

// Commands that resolve packages from the registry at run time instead of the lockfile.
const FETCHES_FROM_REGISTRY = /\b(npm\s+(install|isntall|in|i|add|update|up|upgrade|exec|x)\b|npx\b|pnpm\b|yarn\s+(add|dlx|up)\b|corepack\b)|@latest\b/;

describe('CI and release tooling (#229)', function () {
    it('finds the workflow files and their run: commands', function () {
        expect(workflows.map((w) => w.name)).to.include.members(['pipeline.yaml', 'publish.yml']);
        workflows.forEach(({ name, text }) => expect(runLines(text), name).to.not.be.empty);
    });

    workflows.forEach(({ name, text }) => {
        it(`${name} runs nothing fetched from outside the lockfile`, function () {
            const offending = runLines(text).filter((line) => FETCHES_FROM_REGISTRY.test(line));
            expect(offending, `${name}: ${offending.join(' | ')}`).to.deep.equal([]);
        });
    });

    it('reads run: commands only, so comments and step names that mention a command are ignored', function () {
        const sample = [
            '      - name: Do not npm install here',
            '        # npm install -g npm@latest',
            '        run: npm ci  # never npm install',
            '      - run: |',
            '          echo one',
            '          npx something',
            '      - name: next',
        ].join('\n');
        expect(runLines(sample)).to.deep.equal(['npm ci', 'echo one', 'npx something']);
        expect(runLines(sample).filter((line) => FETCHES_FROM_REGISTRY.test(line))).to.deep.equal(['npx something']);
    });

    describe('publish.yml', function () {
        const commands = runLines(read(`${workflowDir}/publish.yml`));

        it('runs every npm ci with --ignore-scripts', function () {
            const installs = commands.filter((line) => /\bnpm\s+ci\b/.test(line));
            expect(installs).to.not.be.empty;
            installs.forEach((line) => expect(line).to.match(/\s--ignore-scripts\b/));
        });

        it('checks that the bundled npm supports trusted publishing (>= 11.5.1)', function () {
            expect(read(`${workflowDir}/publish.yml`)).to.contain('Check npm supports trusted publishing');
            expect(commands).to.include('const min = [11, 5, 1];');
        });
    });

    describe('verify-package', function () {
        const source = read('test/verify-package.mjs');

        it('installs the packed tarball with --ignore-scripts and without the job\'s credentials', function () {
            const install = source.split('\n').find((line) => line.includes("run('npm', ['install'"));
            expect(install, 'the tarball install line').to.be.a('string');
            expect(install).to.contain("'--ignore-scripts'");
            expect(install).to.match(/,\s*sandbox\);\s*$/);
        });

        it('loads the installed package without the job\'s credentials', function () {
            expect(source).to.contain("run('node', [file], workdir, sandbox);");
            expect(source).to.contain('const sandbox = sandboxEnv();');
        });

        it('sandboxEnv() drops the OIDC request, runtime and npm/GitHub tokens and keeps the rest', function () {
            const env = sandboxEnv({
                PATH: '/usr/bin',
                HOME: '/home/runner',
                NPM_CONFIG_USERCONFIG: '/tmp/.npmrc',
                ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions',
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
                ACTIONS_RUNTIME_TOKEN: 'runtime',
                ACTIONS_RESULTS_URL: 'https://results',
                ACTIONS_CACHE_URL: 'https://cache',
                NODE_AUTH_TOKEN: 'npm',
                NPM_TOKEN: 'npm',
                npm_config__authToken: 'npm',
                GITHUB_TOKEN: 'gh',
                GH_TOKEN: 'gh',
            });
            expect(env).to.deep.equal({ PATH: '/usr/bin', HOME: '/home/runner', NPM_CONFIG_USERCONFIG: '/tmp/.npmrc' });
        });
    });

    it('locks the config peer as a devDependency inside the supported peer range', function () {
        const pkg = JSON.parse(read('package.json'));
        const [, low, high] = pkg.peerDependencies.config.match(/^>=(\d+) <(\d+)$/);
        const majorOf = (version) => Number(version.replace(/^\^/, '').split('.')[0]);

        // The tests must exercise a version consumers may actually install.
        expect(majorOf(pkg.devDependencies.config), 'config devDependency').to.be.within(Number(low), Number(high) - 1);
        expect(majorOf(require('config/package.json').version), 'installed config').to.be.within(Number(low), Number(high) - 1);
    });
});
