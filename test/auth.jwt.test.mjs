/**
 * TDD specification for the JWT auth backend (#130, tasks #131 and #132).
 *
 * Written BEFORE the implementation: this file is the executable contract for
 * src/auth/VaultJwtAuth.js. Until that module exists, the whole file fails
 * with ERR_MODULE_NOT_FOUND -- that is the red phase, not a broken test.
 * Implement per issue #131 (literal jwt + jwtPath) and #132 (jwtProvider)
 * until every test here is green without editing this file.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultApiClient from '../src/VaultApiClient.js';
import VaultClient from '../src/VaultClient.js';
import VaultJwtAuth from '../src/auth/VaultJwtAuth.js';
import errors from '../src/errors.js';
import { createNoopLogger, createSpyLogger, loggedText } from './helpers/logger.mjs';

use(sinonChai);

const logger = createNoopLogger();

// Distinctive values so the log-hygiene assertions cannot pass by accident.
const THE_JWT = 'eyJhbGciOiJSUzI1NiJ9.TDD-SECRET-JWT-VALUE.sig';
const THE_CLIENT_TOKEN = 'hvs.THE-VAULT-CLIENT-TOKEN-NOBODY-MAY-LOG';
const THE_ACCESS_TOKEN = 'ya29.THE-MS-GRAPH-DISTRIBUTED-CLAIM-ACCESS-TOKEN';

/**
 * Canned Vault responses. `tokenTtl`/`tokenCreation` control whether the token
 * the backend obtains is already expired (forcing a re-login on the next
 * getAuthToken), mirroring the fixture style of test/namespace.test.mjs.
 */
function stubFetch({ tokenTtl = 0, tokenCreation = 1600000000 } = {}) {
    return sinon.stub(global, 'fetch').callsFake((url) => {
        const pathname = new URL(url).pathname;
        let body = {};
        if (pathname.endsWith('/auth/token/lookup-self')) {
            body = { data: {
                id: THE_CLIENT_TOKEN, accessor: 'acc',
                creation_time: tokenCreation, ttl: tokenTtl, renewable: false,
            } };
        } else if (pathname.endsWith('/login')) {
            body = { auth: { client_token: THE_CLIENT_TOKEN, accessor: 'acc' } };
        }
        return Promise.resolve(new Response(JSON.stringify(body), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
    });
}

function loginCalls(fetchStub) {
    return fetchStub.getCalls()
        .filter((c) => new URL(c.args[0]).pathname.match(/\/auth\/.+\/login$/))
        .map((c) => ({
            path: new URL(c.args[0]).pathname,
            body: JSON.parse(c.args[1].body),
        }));
}

describe('VaultJwtAuth (TDD spec for #130)', function () {
    let fetchStub;

    beforeEach(function () {
        fetchStub = stubFetch();
    });

    afterEach(function () {
        fetchStub.restore();
        VaultClient.clear();
    });

    function api() {
        return new VaultApiClient({ url: 'https://vault.example' }, logger);
    }

    describe('constructor validation [#131/#132]', function () {
        it('requires exactly one JWT source: none given throws', function () {
            expect(() => new VaultJwtAuth(api(), logger, { role: 'r' }))
                .to.throw(errors.InvalidArgumentsError);
        });

        it('requires exactly one JWT source: two given throws', function () {
            expect(() => new VaultJwtAuth(api(), logger, { jwt: THE_JWT, jwtPath: '/tmp/x' }))
                .to.throw(errors.InvalidArgumentsError);
            expect(() => new VaultJwtAuth(api(), logger, { jwt: THE_JWT, jwtProvider: () => THE_JWT }))
                .to.throw(errors.InvalidArgumentsError);
        });

        it('rejects a non-function jwtProvider', function () {
            expect(() => new VaultJwtAuth(api(), logger, { jwtProvider: 'not-a-fn' }))
                .to.throw(errors.InvalidArgumentsError);
        });

        it('accepts a config with no role (Vault default_role path)', function () {
            expect(() => new VaultJwtAuth(api(), logger, { jwt: THE_JWT })).to.not.throw();
        });
    });

    describe('literal jwt source [#131]', function () {
        it('POSTs { role, jwt } to /auth/jwt/login and yields the client token', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'my-app', jwt: THE_JWT });
            const token = await auth.getAuthToken();
            expect(token.getId()).to.equal(THE_CLIENT_TOKEN);
            const logins = loginCalls(fetchStub);
            expect(logins).to.have.length(1);
            expect(logins[0].path).to.equal('/v1/auth/jwt/login');
            expect(logins[0].body).to.deep.equal({ role: 'my-app', jwt: THE_JWT });
        });

        it('omits the role key entirely when role is not configured', async function () {
            const auth = new VaultJwtAuth(api(), logger, { jwt: THE_JWT });
            await auth.getAuthToken();
            expect(loginCalls(fetchStub)[0].body).to.deep.equal({ jwt: THE_JWT });
        });

        it('logs in against a custom mount', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwt: THE_JWT }, 'gha');
            await auth.getAuthToken();
            expect(loginCalls(fetchStub)[0].path).to.equal('/v1/auth/gha/login');
        });

        it('single-flight: concurrent getAuthToken() callers share one login', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwt: THE_JWT });
            const [a, b] = await Promise.all([auth.getAuthToken(), auth.getAuthToken()]);
            expect(a).to.equal(b);
            expect(loginCalls(fetchStub)).to.have.length(1);
        });

        it('re-authenticates when the obtained token has expired', async function () {
            fetchStub.restore();
            fetchStub = stubFetch({ tokenTtl: 1, tokenCreation: 1600000000 }); // expired in 2020
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwt: THE_JWT });
            await auth.getAuthToken();
            await auth.getAuthToken();
            expect(loginCalls(fetchStub)).to.have.length(2);
        });
    });

    describe('jwtPath source [#131]', function () {
        let jwtFile;

        beforeEach(function () {
            jwtFile = path.join(os.tmpdir(), `nvc-jwt-tdd-${process.pid}.jwt`);
            fs.writeFileSync(jwtFile, THE_JWT);
        });

        afterEach(function () {
            try { fs.unlinkSync(jwtFile); } catch { /* ignore */ }
        });

        it('reads the JWT from the file at login time', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtPath: jwtFile });
            await auth.getAuthToken();
            expect(loginCalls(fetchStub)[0].body.jwt).to.equal(THE_JWT);
        });

        it('re-reads the file on every login, so a rotated token is picked up', async function () {
            fetchStub.restore();
            fetchStub = stubFetch({ tokenTtl: 1, tokenCreation: 1600000000 });
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtPath: jwtFile });
            await auth.getAuthToken();
            fs.writeFileSync(jwtFile, 'eyJ.ROTATED-JWT.sig');
            await auth.getAuthToken();
            const logins = loginCalls(fetchStub);
            expect(logins).to.have.length(2);
            expect(logins[0].body.jwt).to.equal(THE_JWT);
            expect(logins[1].body.jwt).to.equal('eyJ.ROTATED-JWT.sig');
        });
    });

    describe('jwtProvider source [#132]', function () {
        it('is not called at construction, once per login afterwards', async function () {
            const provider = sinon.stub().resolves(THE_JWT);
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtProvider: provider });
            expect(provider).to.not.have.been.called;
            await auth.getAuthToken();
            expect(provider).to.have.been.calledOnce;
            expect(loginCalls(fetchStub)[0].body.jwt).to.equal(THE_JWT);
        });

        it('is called again for a re-login, and the fresh token is sent', async function () {
            fetchStub.restore();
            fetchStub = stubFetch({ tokenTtl: 1, tokenCreation: 1600000000 });
            const provider = sinon.stub();
            provider.onFirstCall().resolves('jwt-first');
            provider.onSecondCall().resolves('jwt-second');
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtProvider: provider });
            await auth.getAuthToken();
            await auth.getAuthToken();
            expect(provider).to.have.been.calledTwice;
            expect(loginCalls(fetchStub).map((l) => l.body.jwt)).to.deep.equal(['jwt-first', 'jwt-second']);
        });

        it('accepts a synchronous provider', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtProvider: () => THE_JWT });
            await auth.getAuthToken();
            expect(loginCalls(fetchStub)[0].body.jwt).to.equal(THE_JWT);
        });

        it('a rejecting provider fails the login without wedging single-flight', async function () {
            const boom = new Error('IdP unavailable');
            const provider = sinon.stub();
            provider.onFirstCall().rejects(boom);
            provider.onSecondCall().resolves(THE_JWT);
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtProvider: provider });
            let thrown;
            try { await auth.getAuthToken(); } catch (err) { thrown = err; }
            expect(thrown).to.equal(boom);
            // The failed attempt must not leave a pending login behind:
            const token = await auth.getAuthToken();
            expect(token.getId()).to.equal(THE_CLIENT_TOKEN);
        });

        it('rejects with InvalidArgumentsError when the provider resolves a non-string', async function () {
            const auth = new VaultJwtAuth(api(), logger, { role: 'r', jwtProvider: () => 42 });
            let thrown;
            try { await auth.getAuthToken(); } catch (err) { thrown = err; }
            expect(thrown).to.be.instanceOf(errors.InvalidArgumentsError);
            expect(loginCalls(fetchStub)).to.have.length(0); // no garbage login sent
        });
    });

    describe('distributed claim access token [#175]', function () {
        describe('constructor validation', function () {
            it('rejects both the literal and the provider together', function () {
                expect(() => new VaultJwtAuth(api(), logger, {
                    jwt: THE_JWT,
                    distributedClaimAccessToken: THE_ACCESS_TOKEN,
                    distributedClaimAccessTokenProvider: () => THE_ACCESS_TOKEN,
                })).to.throw(
                    errors.InvalidArgumentsError,
                    'Only one of "distributedClaimAccessToken" or "distributedClaimAccessTokenProvider" should be provided for VaultJwtAuth'
                );
            });

            it('rejects a non-function distributedClaimAccessTokenProvider', function () {
                expect(() => new VaultJwtAuth(api(), logger, {
                    jwt: THE_JWT,
                    distributedClaimAccessTokenProvider: THE_ACCESS_TOKEN,
                })).to.throw(
                    errors.InvalidArgumentsError,
                    '"distributedClaimAccessTokenProvider" should be a function for VaultJwtAuth'
                );
            });

            it('accepts either option on its own, and neither at all', function () {
                expect(() => new VaultJwtAuth(api(), logger, { jwt: THE_JWT })).to.not.throw();
                expect(() => new VaultJwtAuth(api(), logger, {
                    jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                })).to.not.throw();
                expect(() => new VaultJwtAuth(api(), logger, {
                    jwt: THE_JWT, distributedClaimAccessTokenProvider: () => THE_ACCESS_TOKEN,
                })).to.not.throw();
            });

            it('does not call the provider at construction time', function () {
                const provider = sinon.stub().resolves(THE_ACCESS_TOKEN);
                new VaultJwtAuth(api(), logger, { role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: provider });
                expect(provider).to.not.have.been.called;
            });
        });

        describe('login body', function () {
            it('omits the distributed_claim_access_token key entirely when neither option is configured', async function () {
                const auth = new VaultJwtAuth(api(), logger, { role: 'my-app', jwt: THE_JWT });
                await auth.getAuthToken();
                const body = loginCalls(fetchStub)[0].body;
                // The backward-compatibility guarantee: not "sent as undefined", but absent.
                expect(Object.prototype.hasOwnProperty.call(body, 'distributed_claim_access_token'),
                    'pre-#175 login bodies must stay byte-identical').to.be.false;
                expect(body).to.deep.equal({ role: 'my-app', jwt: THE_JWT });
            });

            it('omits the key with no role configured either', async function () {
                const auth = new VaultJwtAuth(api(), logger, { jwt: THE_JWT });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({ jwt: THE_JWT });
            });

            it('sends the literal distributedClaimAccessToken', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'my-app', jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                    role: 'my-app', jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
                });
            });

            it('sends the value resolved by distributedClaimAccessTokenProvider', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'my-app', jwt: THE_JWT, distributedClaimAccessTokenProvider: async () => THE_ACCESS_TOKEN,
                });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                    role: 'my-app', jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
                });
            });

            it('accepts a synchronous provider', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: () => THE_ACCESS_TOKEN,
                });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body.distributed_claim_access_token).to.equal(THE_ACCESS_TOKEN);
            });

            it('omits the role key while still sending the access token', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                    jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
                });
            });
        });

        describe('provider lifecycle', function () {
            it('is not called at construction, once per login afterwards', async function () {
                const provider = sinon.stub().resolves(THE_ACCESS_TOKEN);
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: provider,
                });
                expect(provider).to.not.have.been.called;
                await auth.getAuthToken();
                expect(provider).to.have.been.calledOnce;
                expect(loginCalls(fetchStub)[0].body.distributed_claim_access_token).to.equal(THE_ACCESS_TOKEN);
            });

            it('is called again for a re-login, and the fresh access token is sent (never cached)', async function () {
                fetchStub.restore();
                fetchStub = stubFetch({ tokenTtl: 1, tokenCreation: 1600000000 });
                const provider = sinon.stub();
                provider.onFirstCall().resolves('access-first');
                provider.onSecondCall().resolves('access-second');
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: provider,
                });
                await auth.getAuthToken();
                await auth.getAuthToken();
                expect(provider).to.have.been.calledTwice;
                expect(loginCalls(fetchStub).map((l) => l.body.distributed_claim_access_token))
                    .to.deep.equal(['access-first', 'access-second']);
            });

            it('a rejecting provider fails the login without wedging single-flight', async function () {
                const boom = new Error('Graph token endpoint unavailable');
                const provider = sinon.stub();
                provider.onFirstCall().rejects(boom);
                provider.onSecondCall().resolves(THE_ACCESS_TOKEN);
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: provider,
                });
                let thrown;
                try { await auth.getAuthToken(); } catch (err) { thrown = err; }
                expect(thrown).to.equal(boom);
                expect(loginCalls(fetchStub)).to.have.length(0);
                // The failed attempt must not leave a pending login behind:
                const token = await auth.getAuthToken();
                expect(token.getId()).to.equal(THE_CLIENT_TOKEN);
                expect(loginCalls(fetchStub)[0].body.distributed_claim_access_token).to.equal(THE_ACCESS_TOKEN);
            });

            it('surfaces a synchronously throwing provider as a rejection, not a sync throw', async function () {
                const boom = new Error('no Graph credentials in this process');
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: () => { throw boom; },
                });
                let pending;
                expect(() => { pending = auth.getAuthToken(); }, 'must not throw out of _authenticate').to.not.throw();
                let thrown;
                try { await pending; } catch (err) { thrown = err; }
                expect(thrown).to.equal(boom);
                expect(loginCalls(fetchStub)).to.have.length(0);
            });

            it('rejects with InvalidArgumentsError when the provider resolves a non-string', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: () => 42,
                });
                let thrown;
                try { await auth.getAuthToken(); } catch (err) { thrown = err; }
                expect(thrown).to.be.instanceOf(errors.InvalidArgumentsError);
                expect(thrown.message).to.equal(
                    '"distributedClaimAccessTokenProvider" must resolve to a non-empty access token string'
                );
                expect(loginCalls(fetchStub)).to.have.length(0); // no garbage login sent
            });

            it('rejects with InvalidArgumentsError when the provider resolves an empty string', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessTokenProvider: async () => '',
                });
                let thrown;
                try { await auth.getAuthToken(); } catch (err) { thrown = err; }
                expect(thrown).to.be.instanceOf(errors.InvalidArgumentsError);
                expect(thrown.message).to.equal(
                    '"distributedClaimAccessTokenProvider" must resolve to a non-empty access token string'
                );
                expect(loginCalls(fetchStub)).to.have.length(0);
            });
        });

        describe('combined with each JWT source', function () {
            let jwtFile;

            beforeEach(function () {
                jwtFile = path.join(os.tmpdir(), `nvc-jwt-dcat-${process.pid}.jwt`);
                fs.writeFileSync(jwtFile, THE_JWT);
            });

            afterEach(function () {
                try { fs.unlinkSync(jwtFile); } catch { /* ignore */ }
            });

            it('works alongside jwtPath', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwtPath: jwtFile, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                });
                await auth.getAuthToken();
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                    role: 'r', jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
                });
            });

            it('works alongside jwtProvider, with both providers called per login', async function () {
                const jwtProvider = sinon.stub().resolves(THE_JWT);
                const accessTokenProvider = sinon.stub().resolves(THE_ACCESS_TOKEN);
                const auth = new VaultJwtAuth(api(), logger, {
                    jwtProvider, distributedClaimAccessTokenProvider: accessTokenProvider,
                });
                await auth.getAuthToken();
                expect(jwtProvider).to.have.been.calledOnce;
                expect(accessTokenProvider).to.have.been.calledOnce;
                expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                    jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
                });
            });

            it('does not send the access token when the JWT source itself fails', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwtProvider: () => 42, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                });
                let thrown;
                try { await auth.getAuthToken(); } catch (err) { thrown = err; }
                expect(thrown).to.be.instanceOf(errors.InvalidArgumentsError);
                expect(loginCalls(fetchStub)).to.have.length(0);
            });

            it('logs in against a custom mount with the access token attached', async function () {
                const auth = new VaultJwtAuth(api(), logger, {
                    role: 'r', jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN,
                }, 'entra');
                await auth.getAuthToken();
                const login = loginCalls(fetchStub)[0];
                expect(login.path).to.equal('/v1/auth/entra/login');
                expect(login.body.distributed_claim_access_token).to.equal(THE_ACCESS_TOKEN);
            });
        });
    });

    describe('log hygiene (#104 rule) [#131]', function () {
        it('never passes the JWT or the client token to any log level', async function () {
            const log = createSpyLogger();
            const auth = new VaultJwtAuth(new VaultApiClient({ url: 'https://vault.example' }, log), log, { role: 'r', jwt: THE_JWT });
            await auth.getAuthToken();
            const text = loggedText(log);
            expect(text, 'raw JWT must never reach the logger').to.not.contain(THE_JWT);
            expect(text, 'client token must never reach the logger').to.not.contain(THE_CLIENT_TOKEN);
        });

        it('never passes the distributed claim access token to any log level [#175]', async function () {
            const log = createSpyLogger();
            const auth = new VaultJwtAuth(new VaultApiClient({ url: 'https://vault.example' }, log), log, {
                role: 'r', jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN,
            });
            await auth.getAuthToken();
            expect(loggedText(log), 'access token must never reach the logger').to.not.contain(THE_ACCESS_TOKEN);
        });
    });

    describe('VaultClient dispatch [#131]', function () {
        it("boots a client with auth.type 'jwt'", async function () {
            const client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'jwt', config: { role: 'r', jwt: THE_JWT } },
            });
            const lease = await client.read('secret/anything');
            expect(lease.getData()).to.deep.equal({});
            expect(loginCalls(fetchStub)[0].path).to.equal('/v1/auth/jwt/login');
        });

        it('forwards auth.config.distributedClaimAccessToken to the login body [#175]', async function () {
            const client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'jwt', config: { role: 'r', jwt: THE_JWT, distributedClaimAccessToken: THE_ACCESS_TOKEN } },
            });
            await client.read('secret/anything');
            expect(loginCalls(fetchStub)[0].body).to.deep.equal({
                role: 'r', jwt: THE_JWT, distributed_claim_access_token: THE_ACCESS_TOKEN,
            });
        });

        it('honours the legacy auth.config.namespace location [#133]', async function () {
            const client = new VaultClient({
                api: { url: 'https://vault.example/' },
                logger: false,
                auth: { type: 'jwt', config: { role: 'r', jwt: THE_JWT, namespace: 'team-a' } },
            });
            await client.read('secret/anything');
            const login = fetchStub.getCalls().find((c) => new URL(c.args[0]).pathname.endsWith('/login'));
            expect(login.args[1].headers['X-Vault-Namespace']).to.equal('team-a');
        });
    });
});
