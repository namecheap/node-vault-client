# Unreleased

- Added `renewal: false` to every auth backend's `config`, which disables the background
  token-renewal timer (#17). The client then uses the token until it expires and re-authenticates
  on the next call instead of renewing it in the background. Useful for short-lived processes —
  the renewal timer keeps the Node.js event loop alive, so without it a finished script does not
  exit unless you call `close()` — and wherever re-login is preferable to extending a lease.
  Default behaviour is unchanged. Note this is only a no-op for backends that can obtain a fresh
  credential on their own (`kubernetes`, `iam`, `jwt` via `jwtPath`/`jwtProvider`): `token` auth
  cannot re-authenticate at all and will raise `AuthTokenExpiredError` once the token expires, and
  `appRole`/literal-`jwt` replay the same credential. Expiring a token also revokes the leases it
  created, which matters if you read dynamic secrets.

- Added `renewalFraction` and `renewalIncrement` to the same `config`, for tuning renewal rather
  than turning it off (#17). `renewalFraction` (default `0.5`, range `(0, 1)`) sets how much of
  the token's remaining lifetime to wait before renewing; a lower value renews earlier and leaves
  room for more retries, which shrink geometrically as the lifetime does. `renewalIncrement` (unset by default)
  is sent as `increment` to `auth/token/renew-self` to request a specific extra TTL, which Vault
  caps at the token's max TTL. Both are validated at construction and raise
  `InvalidArgumentsError` on bad input. Defaults reproduce the previous behaviour exactly: the
  halfway point, and a renew request with a `null` body.

- Added a JWT auth backend (`auth.type: 'jwt'`, default mount `"jwt"`) for workload identity
  federation — GitHub Actions, other CI systems, GCP/Azure/SPIFFE workloads — against Vault's
  [JWT auth method](https://developer.hashicorp.com/vault/docs/auth/jwt). Models
  `VaultKubernetesAuth`. `config.role` is optional, matching Vault's `default_role` fallback.
  Exactly one of three mutually-exclusive sources supplies the JWT: a literal `config.jwt`
  string (CI jobs / processes shorter-lived than the token — a re-login resends that same
  string, so it fails once the IdP-issued token itself expires); `config.jwtPath`, a file
  re-read on every login (rotated projected tokens); or `config.jwtProvider`, an (optionally
  async) function invoked fresh at login time — never at construction, never cached — for
  tokens minted per login such as GitHub Actions' `core.getIDToken()` or a cloud metadata
  endpoint. A `jwtProvider` resolving a non-string/empty string, or a non-function
  `jwtProvider`, fails fast with `InvalidArgumentsError` without sending a login request. Only
  the non-interactive `jwt` flow is implemented; the browser-redirect `oidc` flow is out of
  scope for this service client. See the README's "JWT auth" section.

# 2.1.2 Release notes (2026-08-03)

- Internal refactor: `VaultBaseAuth` no longer overloads a single `__authToken` field with two
  types. The in-flight login now lives in `__pendingLogin` (`Promise<AuthToken>|null`) and the
  resolved token in `__authToken` (`AuthToken|null`), so `getAuthToken()` reads the auth state
  directly instead of discriminating with `instanceof` at each use site. No behavior change —
  the single-flight login (concurrent callers share one login) and the renewal-timer wiring are
  unchanged, and both are now pinned by tests. Closes #120.

# 2.1.1 Release notes (2026-07-31)

- Dependencies bumped, with **zero known vulnerabilities and Node 18 still working**. The selection
  rule is deliberately "newest version that still *runs* on Node 18", not "newest version whose
  `engines` field mentions Node 18" — for most packages the `engines` bump to Node 20 is policy
  rather than a technical requirement, and capping on the declaration alone would force downgrades
  below patched releases. `npm audit` reports 0 vulnerabilities, as it did on 2.1.0; note that
  capping purely on `engines` declarations was tried first and produced 26 advisories (1 critical,
  7 high, 18 moderate), because every patched release of `@aws-sdk/credential-providers`,
  `serialize-javascript` and `brace-expansion` requires Node 20+. That approach is preserved in the
  branch history for auditability.
  - Bumped to latest: `@aws-sdk/credential-providers` → `^3.1100.0`, `aws4` `^1.8.0` → `^1.13.2`,
    `chai` → `^6.2.2`, `globals` → `^17.8.0`, `lodash` → `^4.18.1`, `sinon` → `^22.1.0`,
    `sinon-chai` → `^4.0.1`, `eslint`/`@eslint/js` → `^9.39.5`. Security overrides stay on their
    patched releases: `serialize-javascript` `^7.0.7`, `brace-expansion` `^5.0.9`.
  - Held below latest, because these genuinely break on Node 18 rather than merely declaring
    against it: `c8` stays `^10.1.3` (11+ requires Node `20 || >=22`; 12 pulls an ESM-only `yargs`
    and dies with `ERR_REQUIRE_ESM` on Node 18 — as a side effect `npm run coverage` now works on
    Node 18, which it did not on 2.1.0), `eslint` stays on 9.x (10.x declares
    `^20.19.0 || ^22.13.0 || >=24`), and the `config` peer range stays `<4` (config 4 requires
    Node `>=20`).
  - `npm ci` on Node 18 prints 19 `EBADENGINE` warnings — 16 AWS SDK/smithy packages plus
    `brace-expansion@5.0.9`, `lru-cache@11.5.2` and `serialize-javascript@7.0.7`. Each was
    executed on Node 18 to confirm the warnings are cosmetic: the AWS SDK resolves a provider
    chain and signs a request, and `brace-expansion`, `lru-cache`, `glob` and `minimatch` all
    behave correctly.
  - Verified on Node 18.20.8 / 20.20.2 / 22.23.2 / 24.18.1, each against a **fresh Vault 1.13.3
    instance in Docker**: `npm ci`, 306 unit tests, `lint`, the c8 threshold gate, and both e2e
    suites (`test:e2e` 6 passing/1 pending, `test:e2e:kv2` 10 passing) pass on all four.

- Two known limitations on Node 18, both pre-existing on 2.1.0 and neither hit by any npm script
  or CI job. Documented here so they are not rediscovered as mysteries:
  - `mocha --parallel` does not work on Node 18. `serialize-javascript@7.x` calls
    `crypto.getRandomValues` on the global at module load, and Node 18 has no unflagged global
    `crypto`, so mocha's parallel worker (`lib/nodejs/worker.js`) throws `ReferenceError: crypto is
    not defined` — surfaced unhelpfully as `✖ ERROR: null`. None of the `test*` scripts use
    `--parallel`; serial runs never load that module. Downgrading the override to `^6.0.2` restores
    parallel mode on Node 18 but reinstates a high advisory (GHSA-5c6j-r48x-rmvq RCE via
    `RegExp.flags`, GHSA-qj8w-gfj5-8c6v CPU-exhaustion DoS), so the patched version is kept.
  - Brace glob patterns (`*.{js,mjs}`) throw `TypeError: expand is not a function` under the
    `brace-expansion` override. v5 changed the export from a default function to a named
    `{ expand }`, and the blanket override applies it to `minimatch@3.1.5` (via `eslint`, wants
    `^1.1.7`) and `minimatch@9.0.9` (via `mocha`, wants `^2.0.2`), which still call it as a
    function. Brace-free patterns are unaffected, and neither `eslint.config.js` nor any test glob
    uses braces. Scoping the override per-major is not a way out: the backported `1.1.16`/`2.1.2`
    releases clear GHSA-3jxr-9vmj-r5cp but are still flagged high by GHSA-mh99-v99m-4gvg
    (unbounded-expansion OOM), which is only fixed in 5.0.8+.

# 2.1.0 Release notes (2026-07-28)

- Security: pin patched transitive tooling via `overrides` — `brace-expansion` to `^5.0.8`
  (clears GHSA-3jxr-9vmj-r5cp, Dependabot #60, and GHSA-mh99-v99m-4gvg) and `js-yaml` to `^4.3.0`
  (clears the concurrent quadratic-CPU merge-key advisory). Dev/transitive only (eslint, mocha,
  glob, c8) — no runtime dependency or behavior change; `npm audit --audit-level=high` is clean.
- Perf: `MountResolver` no longer re-sorts the `api.engines` override map on every `resolve()` —
  entries are normalized and sorted once at construction (the map is now snapshotted: mutating the
  object after `VaultClient` construction no longer affects resolution). The mount cache is now a
  bounded LRU (default 500 entries, `opts.maxCacheSize`) probed by segment-boundary prefix in
  O(path depth) instead of a linear scan over every cached mount, so long-lived services against
  many/dynamic mounts get bounded memory and lookup cost. Measured at 200k worst-case resolves:
  engines lookup 1191ms → 34ms (50 entries), cache lookup 1019ms → 149ms (500 mounts). Also adds
  test coverage for the previously untested empty-detection-response error. Closes #108.
- Internal refactor: unify the copy-pasted request pipeline in `VaultClient`. `update()`, the raw
  `request()`, and the KV v2-only helpers now delegate to the single `__resolveAndRequest` entry
  point (one `resolver.resolve()` call site instead of three). No behavior change — the pipeline
  is locked by new characterization tests across v1/v2 mounts, namespaces, and extra headers.
  Closes #110.
- Non-2xx Vault responses are now rejected with a typed `VaultHttpError` (part of the `VaultError`
  hierarchy, exported from the errors module), so callers can `instanceof`-check HTTP failures.
  Backward compatible: the message (`"<status> - <body text>"`) and the `statusCode`/`error`
  properties are unchanged, and the thrown value is still an `instanceof Error`.
- Auth backends now fail fast with `InvalidArgumentsError` when a required config field is missing:
  `role_id` for AppRole, `role` for IAM and Kubernetes (previously only Token auth validated its
  input, and a missing/empty config surfaced later as an unhelpful login failure or `TypeError`).
  Valid configurations behave exactly as before.

# 2.0.4 Release notes (2026-07-02)

- CI: make the quality gates actually enforce. `c8` now runs with `check-coverage` and per-metric
  thresholds (statements/branches/functions/lines) pinned just below the current measured coverage,
  so a coverage regression fails the `coverage` job instead of silently passing. Linting now covers
  `test/` in addition to `src/` (`eslint src/ test/`), catching stray unused imports/vars in the
  ~19 test files that were previously unchecked. The `npm audit --audit-level=high` choice is now
  documented in the workflow. No runtime behavior change.
- `VaultError` now accepts the standard `{ cause }` option (`new VaultError(msg, { cause })`) and
  exposes it as `error.cause`, so wrapped/underlying errors can be chained. Backward compatible —
  omitting the option leaves `cause` undefined.

# 2.0.3 Release notes (2026-07-02)

- Fix (behavior change): apply `X-Vault-Namespace` to **every** request. The header was previously
  built independently by the AppRole and IAM backends and by `VaultClient` for KV operations, but was
  **missing from token lookup/renewal (`/auth/token/lookup-self`, `/auth/token/renew-self`) for all
  backends, and from Kubernetes login entirely**. Against a namespaced Vault this silently sent those
  requests to the **root** namespace, so Token and Kubernetes auth were effectively broken with
  namespaces. The namespace is now injected in a single place — `VaultApiClient` — so login, lookup,
  renewal, and secret operations all inherit it for every auth backend. `Token` and `Kubernetes`
  gain namespace support as a result. `api.namespace` is now the canonical config location;
  `auth.config.namespace` continues to work. If you relied on the previous (buggy) behavior where
  lookup/renewal hit the root namespace, this changes which namespace those calls target. Closes #106.

# 2.0.2 Release notes (2026-07-02)

- Security: stop logging the raw Vault `client_token` at debug level. The AppRole (`VaultAppRoleAuth`)
  and AWS IAM (`VaultIAMAuth`) backends logged `auth.client_token` verbatim on every successful
  login, and `VaultBaseAuth` logged the raw token id when arming the renewal timer. With a custom
  debug logger wired up — exactly what the README recommends — this wrote a replayable Vault token
  into durable logs on every authentication. These sites now log the non-sensitive token
  `accessor` instead. This completes the same class of fix shipped for the Kubernetes backend and
  response bodies in 2.0.1. Closes #104.

# 2.0.1 Release notes (2026-06-16)

- Security: stop logging secrets at debug level. The Kubernetes auth backend no longer logs the
  service-account JWT or the issued Vault client token, and `VaultApiClient` no longer logs full
  response bodies (which carry auth tokens and secret reads). Debug logs now record only
  non-sensitive metadata — token paths, request method/URI, and HTTP status codes.
- Dependencies: drop four runtime dependencies. `bluebird` and `assign-deep` are replaced with
  native promises and `lodash`; `pretty-ms` and `url-join` are inlined as small helpers (their
  latest majors are ESM-only and cannot be used from this CommonJS package). The `lodash` floor is
  raised to `^4.17.21`. Runtime dependencies are now `@aws-sdk/credential-providers`, `aws4`,
  `lodash`, and `long-timeout`.
- Reject malformed substitution values whose path or key is empty (e.g. `#value` or `path#`) with
  `InvalidArgumentsError`, instead of failing later with a less clear error.

# 2.0.0 Release notes (2026-06-12)

- Fix a process that never exits after reading with a renewable token. The background
  token-refresh timer (`long-timeout`) kept the Node.js event loop alive with no way to stop
  it. Add `VaultClient#close()` (and `VaultBaseAuth#cancelTokenRefresh()`) to cancel the timer
  so short-lived scripts can exit; `VaultClient.clear()` now also closes the instances it
  removes. Default behavior is unchanged — long-running servers keep renewing as before. Closes #31.
- IAM auth: add an optional `region` config option. When set, the STS
  `GetCallerIdentity` request is signed against the regional endpoint
  (`sts.<region>.amazonaws.com`) and the SigV4 credential scope is bound to that
  region, with the signed Host header and `iam_request_url` kept consistent.
  Fixes `SignatureDoesNotMatch — Credential should be scoped to a valid region`
  on non-`us-east-1` STS endpoints. Omitting `region` preserves the previous
  global-endpoint behavior. Closes #25.
- Add `api.requestOptions`, shallow-merged into every underlying `fetch()` request. Enables
  routing traffic through a proxy/SOCKS agent and trusting a self-signed / internal-CA Vault by
  passing an undici `dispatcher`. Closes #37 and #29.
- Replace the deprecated `request`/`request-promise` HTTP libraries with Node's native `fetch`.
  Removes the `request` runtime dependency and clears the associated Dependabot/deprecation
  alerts; this is the foundation for the new `api.requestOptions` (undici dispatcher) support.
  Closes #59.
- [BREAKING] Minimum supported Node.js is now 18.0.0 (was 14.0.0); the client relies on native `fetch`. Note: on some Node.js 18.x environments, `fetch` may be treated as experimental and require `--experimental-fetch`; use a newer Node.js version for fully nonexperimental `fetch` behavior.
- Auth token: derive expiry from Vault's authoritative `expire_time` (RFC3339), falling back to
  `ttl` only when absent. Closes #51.
- Raise `AuthTokenExpiredError` for expired non-refreshable tokens instead of silently using a
  stale token. Closes #50.
- Replace deprecated `new Buffer()` with `Buffer.from()` in IAM auth STS body encoding. Closes #52.

# 1.0.0 Release notes (2023-08-02)

- `aws-sdk` is no longer a peer dependency
- [BREAKING] From now on the minimum supported version of Node.js is 14.0.0.
- [BREAKING] Changes in IAM configuration. If you explicitly passed aws-sdk@2 credentials to `VaultClient.boot` like below:
```js
    const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
            credentials: AWS.CredentialProviderChain.defaultProviders  // <-- this line
        }
    },
});
```
This will no longer work. You need to either:
- Do not pass the credentials at all and rely on the credentials auto-discovery
```js    
const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
        }
    },
});
```
[OR]
- Pass the credentials explicitly in the following format
```js
const vaultClient = VaultClient.boot('main', {
    api: {url: 'https://vault.example.com:8200/'},
    auth: {
        type: 'iam',
        mount: 'example',
        config: {
            iam_server_id_header_value: 'example',
            role: 'example',
            credentials: {
                accessKeyId: 'AWS_ACCESS_KEY',
                secretAccessKey: 'AWS_SECRET_KEY',
            }
        }
    },
});
```
