# Unreleased

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
