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
