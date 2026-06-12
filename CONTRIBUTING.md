# Contributing to Node.js Vault Client

You're welcome to start a discussion about a feature you'd like, file an issue, or submit a
work-in-progress (WIP) pull request. Feel free to ask us for help — we'll do our best to guide
you and help you get it merged.

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js >= 18 — the client uses the native `fetch` API. CI runs against 18, 20, 22 and 24
  (`.nvmrc` pins 20 for local development).
- npm (the repo ships a committed `package-lock.json`; use `npm ci`).
- Docker — used to run a local dev Vault server for the integration and end-to-end tests
  (see `docker-compose.yml`).

## Development workflow

```shell
npm ci                 # install dependencies from the lockfile
npm install config     # peer dependency used by the node-config integration and coverage
docker compose up -d   # start a local dev Vault on 127.0.0.1:8200

npm run lint           # ESLint (must be clean)
npm run test:unit      # fast unit tests (no Vault required)
npm test               # full suite, including integration/e2e (needs the Vault container)
npm run coverage       # unit tests with c8 coverage report
```

Run `npm run lint` and the tests before pushing — the same checks run in CI
(`.github/workflows/pipeline.yaml`: audit, lint, coverage, and a test matrix on Node 18/20/22/24).

## Tests

Tests live in `test/**/*.test.mjs` and use [mocha](https://mochajs.org/),
[chai](https://www.chaijs.com/) and [sinon](https://sinonjs.org/). Add or update tests for any
code you change. Mock HTTP interactions with sinon — **never** use real Vault servers or
credentials in unit tests. The integration and `test/e2e` suites talk to the dev Vault started by
`docker compose up -d`.

## DCO sign-off

This project requires a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off on every commit. Add the following trailer to each commit message (use `git commit -s`
or add it manually):

```
Signed-off-by: Your Name <your-email@example.com>
```

Pull requests with commits missing the sign-off will fail the DCO check in CI.

## Pull requests

1. Fork the repo and create a topic branch off `master`.
2. Make your change with tests, and keep `npm run lint` and the test suite green.
3. Record user-facing changes under the `# Unreleased` heading in [`CHANGELOG.md`](CHANGELOG.md).
4. Sign off your commits (see above) and open the PR against `master`.
5. A code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)) will review your PR before merge.

## Release (maintainers)

Publishing is automated by `.github/workflows/publish.yml`, which runs
`npm publish --provenance --access public` whenever a GitHub Release is published:

```shell
npm version [major | minor | patch]   # bumps package.json and tags the commit
# review the version-bump commit, then:
git push && git push --tags
```

Then create a [GitHub Release](https://github.com/namecheap/node-vault-client/releases/new) for
the new tag (move the `# Unreleased` notes from `CHANGELOG.md` into a dated section). Publishing
the release triggers the workflow that pushes the package to npm.
