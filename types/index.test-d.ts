import VaultClient = require('../index');

const client = new VaultClient({
    api: { url: 'http://127.0.0.1:8200' },
    auth: { type: 'token', config: { token: 't' } },
});

new VaultClient({
    api: {
        url: 'http://127.0.0.1:8200',
        apiVersion: 'v1',
        namespace: 'team-a',
        requestOptions: { dispatcher: {} },
        kv: { autoDetect: true },
        engines: { secret: 2, legacy: 1 },
    },
    auth: {
        type: 'appRole',
        mount: 'approle',
        renewal: true,
        renewalFraction: 0.75,
        renewalIncrement: 3600,
        config: { role_id: 'r', secret_id: 's' },
    },
    logger: false,
});

new VaultClient({
    api: { url: 'u' },
    auth: { type: 'iam', config: { role: 'r', region: 'eu-west-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' } } },
});

new VaultClient({ api: { url: 'u' }, auth: { type: 'kubernetes', config: { role: 'r', tokenPath: '/var/run/x' } } });
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { jwt: 'e.y.z' } } });
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { role: 'r', jwtPath: '/tmp/jwt' } } });
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { jwtProvider: async () => 'e.y.z' } } });
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { jwtProvider: () => 'e.y.z' } } });

new VaultClient({
    api: { url: 'u' },
    auth: { type: 'token', config: { token: 't' } },
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
});

const booted: VaultClient = VaultClient.boot('main', { api: { url: 'u' }, auth: { type: 'token', config: { token: 't' } } });
const got: VaultClient = VaultClient.get('main');
VaultClient.clear('main');
VaultClient.clear();

async function surface(): Promise<void> {
    const lease: VaultClient.Lease = await client.read('secret/app');
    const str: string = lease.getValue('key');
    const num: number = lease.getValue<number>('port');
    const data: Record<string, any> = lease.getData();
    const renewable: boolean = lease.isRenewable();
    const meta: Record<string, any> | undefined = lease.getMetadata();

    await client.list('secret/');
    await client.write('secret/app', { a: 1 });
    await client.delete('secret/app');
    await client.update('secret/app', { a: 2 });
    await client.request('GET', 'sys/health');
    await client.request('POST', 'sys/x', { a: 1 });

    await client.deleteVersions('secret/app', [1, 2]);
    await client.undeleteVersions('secret/app', [1]);
    await client.destroyVersions('secret/app', [1]);
    await client.readMetadata('secret/app');
    await client.deleteMetadata('secret/app');

    await client.fillNodeConfig();
    client.close();

    void [booted, got, str, num, data, renewable, meta];
}

void surface;

async function readmeExample(): Promise<void> {
    const c = new VaultClient({
        api: { url: 'http://127.0.0.1:8200' },
        auth: { type: 'appRole', config: { role_id: 'roleId', secret_id: 'secretId' } },
    });

    const lease = await c.read('secret/app');
    const password = lease.getValue<string>('password');
    void password;
}

void readmeExample;

// @ts-expect-error the sibling classes are not exported at runtime
new VaultClient.Lease();

// @ts-expect-error AuthToken is a type, not a runtime value
new VaultClient.AuthToken();

// @ts-expect-error api.url is required
new VaultClient({ api: {}, auth: { type: 'token', config: { token: 't' } } });

// @ts-expect-error unknown auth backend
new VaultClient({ api: { url: 'u' }, auth: { type: 'ldap', config: {} } });

// @ts-expect-error token auth requires a token
new VaultClient({ api: { url: 'u' }, auth: { type: 'token', config: {} } });

// @ts-expect-error appRole requires role_id
new VaultClient({ api: { url: 'u' }, auth: { type: 'appRole', config: { secret_id: 's' } } });

// @ts-expect-error exactly one JWT source may be supplied
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { jwt: 'a', jwtPath: '/b' } } });

// @ts-expect-error a JWT source is required
new VaultClient({ api: { url: 'u' }, auth: { type: 'jwt', config: { role: 'r' } } });

// @ts-expect-error renewalFraction is a number
new VaultClient({ api: { url: 'u' }, auth: { type: 'token', config: { token: 't' }, renewalFraction: '0.5' } });

// @ts-expect-error logger accepts an object or false, not true
new VaultClient({ api: { url: 'u' }, auth: { type: 'token', config: { token: 't' } }, logger: true });

// @ts-expect-error boot requires options
VaultClient.boot('x');

// @ts-expect-error versions must be numbers
void client.deleteVersions('secret/app', ['1']);
