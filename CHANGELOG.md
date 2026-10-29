# 1.0.4 Release notes (unreleased)

Security release on the Node.js 14+ **1.0.x** line (`legacy` dist-tag). It backports the fixes for
the four advisories that list 1.0.3 as affected, and issue #204. The 3.x line has the same fixes.

- **Security (#204): `debug` no longer receives Vault tokens or response bodies.** Every request
  logged its full response body at `debug` (`auth.client_token` on login and renewal, `data.id` on
  `lookup-self`, secret values on reads); AppRole, IAM and Kubernetes logged the client token, the
  refresh timer logged the token id, and Kubernetes logged the raw service-account JWT. Request
  logs now name only the method and URL, auth logs name the token accessor, and Kubernetes logs the
  JWT's path and size. The default logger discards `debug`, so only applications passing their own
  logger were affected.
- **Security (GHSA-x5xf-r8x2-647h): AppRole login no longer logs the `role_id`** at `info` level
  (`console.info` by default). For a role with `bind_secret_id=false` it is the whole login
  credential. The line now names the auth mount.
- **Security (GHSA-2vr8-g4vw-7xpm): failure logs no longer include Vault response bodies.** The
  `read`/`list`/`write` failure logs, the mount-detection error message and the token-renewal
  failure logs carried request-promise's `"<status> - <body>"` message, and a partially failed
  transit batch decrypt answers 400 with the other items' plaintexts. They now carry only the status
  and Vault's `errors` strings, or `<status> - (response body omitted)`. A failed background
  renewal also logged the error object itself, whose request `options` hold the `X-Vault-Token`
  header, to `console.error` by default; it no longer does. Errors thrown by the client keep
  `options` and `response`, but as non-enumerable properties, so logging or serialising a caught
  error no longer prints the token or the request body. The thrown `StatusCodeError` message is
  unchanged.
- **Security (GHSA-rr65-m54w-rfr9): `read`, `list` and `write` reject paths that would reach a
  different key**, with `InvalidArgumentsError` and before any request: `?`, `#`, `\`, control
  characters, unpaired surrogates, a trailing space, empty, `.` or `..` segments, percent-encoded
  `.`, `/`, `\` or `%`, and a percent-encoded mount. 1.0.3 sent `..` paths as written and followed
  Vault's redirect to the cleaned path with its token, and collapsed `a//b` into `a/b`. See "Path
  validation" in the README. **Behaviour changes:** such paths now throw, a non-string path throws
  instead of being stringified, and a leading slash is dropped before the mount is resolved, so
  with `autoDetect` `/secret/foo` now addresses `secret/foo` instead of `secret/secret/foo`.
- **Security (GHSA-wf8v-q2h3-hgjm): KV mount detection caches only well-formed answers for the
  requested mount.** A detection response needs a string `data.path` and `data.type`; one whose
  mount does not contain the requested path fails that caller with `InvalidArgumentsError` and is not
  cached. Auth mounts are cached as `auth/<mount>`, and a mount in a child namespace is keyed
  relative to the client's namespace.
- Slash trimming no longer uses regular expressions with quadratic backtracking (CodeQL
  `js/polynomial-redos`).

```
npm install node-vault-client@1.0.4   # or @legacy
```

# 1.0.3. Release notes (2026-06-30)

Maintenance release on the Node.js 16-compatible **1.0.x** line. Published to npm under the `legacy` dist-tag — the `latest` tag stays on the 2.x line.

- Backported **opt-in, non-breaking support for the KV v2 secrets engine** (#102). Enable per mount via `api.engines: { secret: 2 }` or `api.kv.autoDetect: true`. The client rewrites paths (`secret/foo` → `secret/data/foo`, `list` → `secret/metadata/foo`), wraps writes in `{ data: ... }`, and unwraps the nested KV v2 response automatically.
- Added `Lease.getMetadata()`, returning KV v2 version metadata (`version`, `created_time`, …); returns `undefined` for KV v1 / non-KV reads.
- **No behaviour change by default**: with no `kv`/`engines` configuration, `read`/`list`/`write` are byte-for-byte identical to 1.0.2 — literal paths, no `{ data }` wrapping, and no `sys/internal/ui/mounts` detection round-trip.
- KV v2 reads of a soft-deleted secret no longer throw a `TypeError` (null-data guard in `Lease`); mount-version detection coerces `options.version` with `Number()`.
- Still supports **Node.js 14+** on the `request` HTTP stack; the 2.x line requires Node.js 18 (native fetch). Verified green on the Node 14/16/18/20 CI matrix.
- CI: pinned the `config` peer-dependency install to `<4` (the package's declared range) so the Node 14 matrix leg passes (`config@4` requires Node ≥ 20).

```
npm install node-vault-client@1.0.3   # or @legacy
```

# 1.0.0. Release notes (2023-08-02)

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
