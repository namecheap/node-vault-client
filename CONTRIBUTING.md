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
docker compose up -d --wait   # local dev Vaults: KV v1 on 127.0.0.1:8200, KV v2 on 127.0.0.1:8202

npm run lint           # ESLint (must be clean)
npm run test:unit      # fast unit tests (no Vault required)
npm run coverage       # unit tests with c8 coverage report
npm test               # everything, including the e2e suites (needs the Vault containers)
```

The e2e suites can also be run one at a time, which is what you want while iterating on one of
them. All three need `docker compose up -d --wait` first:

```shell
npm run test:e2e       # KV v1 server: read/write, node-config, token renewal, auth backends
npm run test:e2e:kv2   # KV v2 server: mount detection, data/metadata paths, version operations
npm run test:e2e:jwt   # JWT auth against a throwaway mount it configures and removes itself
```

To reproduce a failure from the Vault 2.x leg of CI, point compose at that image:

```shell
docker compose down -v && VAULT_IMAGE=hashicorp/vault:2.0 docker compose up -d --wait
```

When touching an auth backend, `node examples/jwt-auth/vault-jwt-demo.mjs` is a useful
check: it exercises the JWT backend against a real Vault over positive and negative scenarios and
exits non-zero if any of them behaves unexpectedly.

Run `npm run lint` and the tests before pushing — the same checks run in CI
(`.github/workflows/pipeline.yaml`): audit, lint, coverage, a `test:unit` matrix on Node
18/20/22/24, two e2e jobs that cover both supported Vault lines, and `package`, which verifies the
packed tarball. `e2e` runs the KV v1 and JWT suites across Node 18/20/22/24 against Vault 1.21,
plus one Node 20 job against Vault 2.0; `e2e-kv2` runs the KV v2 suite against Vault 1.21 and 2.0.
Every e2e job starts its own Vault containers with `docker compose up -d --wait`.

A final `ci-ok` job depends on all of the above and fails unless every one of them succeeded. It
exists so branch protection can require one stable status check instead of matrix-derived job
names, which change whenever the Node or Vault matrix changes. A new job has to be added to its
`needs` list to be covered by it.

## Tests

Tests live in `test/**/*.test.mjs` and use [mocha](https://mochajs.org/),
[chai](https://www.chaijs.com/) and [sinon](https://sinonjs.org/). Add or update tests for any
code you change. Mock HTTP interactions with sinon — **never** use real Vault servers or
credentials in unit tests. The integration and `test/e2e` suites talk to the dev Vault started by
`docker compose up -d`.

The published artifact is checked separately, because the suites run against the working tree and
cannot see what `npm pack` includes. `node test/verify-package.mjs` packs the repository, installs
the tarball into a throwaway project and requires it, so an artifact left out of `package.json`'s
`files` fails there rather than reaching npm. CI runs it on every pull request, and again before
publishing.

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

## Dependency updates

Dependabot proposes updates weekly, configured in
[`.github/dependabot.yml`](.github/dependabot.yml): runtime dependencies individually as
`fix(deps)`, dev tooling grouped into one `chore(deps)` PR, and GitHub Actions as `ci(deps)`.

Some majors are deliberately ignored there because they drop Node 18, which is still in `engines`
and in the CI matrix — `c8` 11+, `eslint` 10.x and `config` 4. If you need one of those, it comes
with raising the minimum Node version, not with a lockfile bump.

Security advisories are separate: `npm audit --audit-level=high` runs as a blocking CI job, and the
`overrides` block in `package.json` is how a patched transitive dependency gets pinned when the
direct dependency has not released one yet.

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
