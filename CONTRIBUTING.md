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
docker compose up -d   # start local dev Vaults: KV v1 on 127.0.0.1:8200, KV v2 on 127.0.0.1:8202

npm run lint           # ESLint (must be clean)
npm run test:unit      # fast unit tests (no Vault required)
npm test               # full suite, including integration/e2e (needs the Vault container)
npm run coverage       # unit tests with c8 coverage report
```

Run `npm run lint` and the tests before pushing — the same checks run in CI
(`.github/workflows/pipeline.yaml`: audit, lint, coverage, a `test:unit` matrix on Node
18/20/22/24, an `e2e` matrix on the same four versions, and a single-version `e2e-kv2` job; both
e2e jobs run against the Vault servers started by `docker compose up -d --wait`).

## Tests

Tests live in `test/**/*.test.mjs` and use [mocha](https://mochajs.org/),
[chai](https://www.chaijs.com/) and [sinon](https://sinonjs.org/). Add or update tests for any
code you change. Mock HTTP interactions with sinon — **never** use real Vault servers or
credentials in unit tests. The integration and `test/e2e` suites talk to the dev Vault started by
`docker compose up -d`.

## DCO sign-off

This project uses the [Developer Certificate of Origin](https://developercertificate.org/). Add
the following trailer to each commit message (use `git commit -s` or add it manually):

```
Signed-off-by: Your Name <your-email@example.com>
```

Sign-off is enforced by the DCO GitHub App, configured in [`.github/dco.yml`](.github/dco.yml),
which posts its own status check on the pull request — it is not a job in
`.github/workflows/pipeline.yaml`. That config sets `require.members: false`, which exempts
commits authored by members of the `namecheap` organization, so in practice the check blocks
unsigned commits from outside contributors.

## Pull requests

1. Fork the repo and create a topic branch off `master`.
2. Make your change with tests, and keep `npm run lint` and the test suite green.
3. Record user-facing changes under the `# Unreleased` heading at the top of
   [`CHANGELOG.md`](CHANGELOG.md); the file currently starts at the latest release, so add the
   `# Unreleased` heading above it if it is not there yet.
4. Sign off your commits (see above) and open the PR against `master`.
5. A code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)) will review your PR before merge.

## Release (maintainers)

Publishing is automated by `.github/workflows/publish.yml`, which runs
`npm publish --provenance --access public` whenever a GitHub Release is published:

First move the `# Unreleased` notes in `CHANGELOG.md` into a heading that begins with the new
version number — `# <version> Release notes (YYYY-MM-DD)` — and leave that edit uncommitted:

```shell
npm version [major | minor | patch]   # bumps package.json, stages the CHANGELOG edit (the
                                      # `version` script runs `git add -A .`) and tags the commit
# review the version-bump commit, then:
git push && git push --tags
```

Then create a [GitHub Release](https://github.com/namecheap/node-vault-client/releases/new) for
the new tag. Publishing the release triggers the workflow that pushes the package to npm. That
workflow checks out the tagged commit and greps `CHANGELOG.md` for a heading matching
`^# <version>( |$)`; if the notes were not moved before tagging, or the heading does not start
with the bare version number, the publish fails with "No release-notes heading for version
<version>".
