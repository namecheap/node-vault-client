# Migrating from 2.x to 3.0

3.0 keeps the 2.x API: the same methods, options, return shapes, error classes and TypeScript
declarations (`index.d.ts` is unchanged). Most applications upgrade by bumping the version. The
sections below are the cases that do need a change, in the order you are most likely to meet
them; the [checklist](#checklist) at the end turns them into things to search for.

See [CHANGELOG.md](CHANGELOG.md) for the full release notes.

## 1. Node.js >= 20.19.0

`engines.node` is now `>= 20.19.0`; Node 18 is no longer supported, and the
`NodeVaultClientNode18Deprecation` warning 2.3.0 emitted under Node 18 is gone. CI covers Node 20,
22, 24 and 26. Node 20 itself reached end-of-life on 2026-04-30, so plan for Node 22 or later.

## 2. `config` peer dependency: 1.x to 4.x

`peerDependencies.config` is `>=1 <5` (2.x: `>=1 <4`). `fillNodeConfig()` now also works with
config 4.x: config 4 removed `config.util.initParam`, which 2.x called to resolve
`NODE_CONFIG_DIR`, so 2.x failed there with `config.util.initParam is not a function`. 3.0 resolves
`NODE_CONFIG_DIR` the same way itself (`--NODE_CONFIG_DIR=` argument, then the environment
variable, then `./config`). config 5.x (an ESM rewrite) is not supported.

Nothing to change unless you want config 4.x.

## 3. KV paths are validated

`read`, `list`, `write`, `delete`, `update` and the KV v2 helpers (`deleteVersions`,
`undeleteVersions`, `destroyVersions`, `readMetadata`, `deleteMetadata`) now reject a path that
`fetch()` or Vault would resolve to a different key (GHSA-rr65-m54w-rfr9, GHSA-wf8v-q2h3-hgjm). The
call returns a rejected promise with `InvalidArgumentsError` before any request is sent, including
the login and the mount-detection request. `request()` is not validated and behaves as in 2.x. The
full rules are in [Path validation](README.md#path-validation).

| 2.x call | 3.0 | Change it to |
|---|---|---|
| `read('secret/foo?version=2')` | rejected | `request('GET', 'secret/data/foo?version=2')` (KV v2). `request()` resolves to the raw body, so the secret is `body.data.data`, not a `Lease`. |
| A key passed through `encodeURIComponent()` that contains `/`, `.`, `\` or `%` (`%2F`, `%2E`, `%5C`, `%25`) | rejected | `request()` with the full API path. Other escapes (`%20`, `%3F`, `%23`, ...) still work. |
| `` `tenants/${id}/key` `` with an empty `id`, or any `a//b` | rejected | Validate the input before building the path; Vault used to collapse it to `tenants/key`. |
| `.` or `..` segments, `\` separators | rejected | Build the real path. |
| `#` or `?` in a key name | rejected | Percent-encode them (`%23`, `%3F`). |
| A control character, an unpaired surrogate or a trailing space | rejected | Clean the input. |
| `''`, `undefined`, a number or another non-string | rejected | 2.x stringified it. Pass a non-empty string. |
| A trailing slash on a KV v2 helper (`readMetadata('app/cfg/')`) | rejected | Drop the slash. Vault applied it to the key `app/cfg`. `list('secret/apps/')` is still fine. |
| A percent-encoded mount (`secre%74/foo`, `team/k%76/foo`) | rejected | Write the mount name literally. |

Things to pay attention to:

- **A leading slash on KV v2 now reaches the key it names.** `write('/secret/app', ...)` writes
  `secret/app` in every mode. In 2.x with `api.kv.autoDetect` it wrote the key `secret/app` *inside*
  the `secret` mount (`secret/data/secret/app`) on Vault 2.x, and failed with 404 on Vault 1.x or
  with `api.engines`. If your code used leading slashes with `autoDetect` against Vault 2.x, data
  written by 2.x is at `secret/secret/...`: read it with `read('secret/secret/app')` and move it
  before you switch, or 3.0 reads a different (usually missing) key.
- **Validation errors are asynchronous.** They arrive as a rejected promise, not a synchronous
  throw, so existing `.catch()` / `try { await }` handling covers them. Test for them with
  `err instanceof errors.InvalidArgumentsError` (`require('node-vault-client/src/errors')`), not by
  message: the message names the rule and never contains the path.
- **Validation is not authorisation.** It stops a path from reaching a different Vault path than
  the one it names; it does not stop a caller from naming another tenant's key. Keep validating
  user input that goes into a path.

## 4. KV mount auto-detection is stricter

Only applies with `api.kv.autoDetect` (GHSA-wf8v-q2h3-hgjm):

- A detection response (`GET sys/internal/ui/mounts/<path>`) must have a string `data.path` and
  `data.type`; otherwise the call fails with `VaultError` and nothing is cached. 2.x fell back to
  the first path segment and KV v1. **Unit tests that stub this endpoint** with only
  `{ data: { options: { version: '2' } } }` must add `path` (e.g. `'secret/'`) and `type: 'kv'`.
- A response whose mount does not contain the requested path is rejected with
  `InvalidArgumentsError` for that caller and is not cached.
- Auth mounts are cached as `auth/<mount>`, so an auth mount no longer replaces the cache entry of
  a KV mount with the same name. With Vault Enterprise namespaces, a mount in a child namespace is
  keyed relative to `api.namespace`.
- The detection `VaultError` keeps the original HTTP error as `err.cause`, and its message no
  longer includes the response body.

If the token cannot read `sys/internal/ui/mounts`, set `api.engines` as in 2.x.

## 5. Log output

No code change is needed, but log-based alerts, dashboards and parsers may notice
(GHSA-2vr8-g4vw-7xpm):

- Failure logs of every KV method, `request()`, the KV v2 helpers, mount detection and token
  renewal no longer contain the Vault response body: `read secret failed: 403 -
  {"errors":["permission denied"]}`, or `<status> - (response body omitted)` when the body has no
  `errors` array.
- AppRole login logs `making authentication request: approle mount=<mount>` instead of
  `role_id=<role id>`.
- A failed background token refresh writes one `error` line instead of two. For a non-HTTP error
  the error object is the second argument: `logger.error(message, err)`.

The thrown `VaultHttpError` did **not** change: `message` is still `"<status> - <raw body>"` and
`error` the parsed body. If your code logs a caught error as is, it can still write secret material
(for example the other items' plaintexts of a partially failed transit batch decrypt) to your logs.
Log `err.statusCode` and `err.error?.errors` instead.

## Checklist

- [ ] Runtime is Node.js >= 20.19.0 (22+ recommended).
- [ ] `config`, if you use it, is 1.x to 4.x.
- [ ] `grep -rn "?version=" src/`: move versioned KV v2 reads to `request()`.
- [ ] `grep -rn "encodeURIComponent" src/` near Vault calls: keys with an encoded `/`, `.`, `\` or `%`
      go through `request()`.
- [ ] KV paths built from variables (`` `.../${x}/...` ``) cannot get an empty, `.` or `..` segment.
- [ ] No KV path starts with `/`; with `autoDetect` on Vault 2.x, data written that way by 2.x is
      moved from `secret/secret/...`.
- [ ] No trailing slash on `readMetadata`, `deleteMetadata`, `deleteVersions`, `undeleteVersions`,
      `destroyVersions`.
- [ ] Stubs of `sys/internal/ui/mounts` in your tests return `data.path` and `data.type`.
- [ ] Log alerts or parsers do not match on Vault response bodies or on `role_id=`.
- [ ] Caught `VaultHttpError`s are not logged whole.
