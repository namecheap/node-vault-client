/**
 * Tests for the shared test doubles in test/helpers/.
 *
 * These helpers ship to nobody, but seven suites now depend on them and two of
 * their failure modes would be silent rather than red:
 *
 *  - `createNoopLogger()` must satisfy the interface `VaultClient#__setupLogger`
 *    checks. If it lost a method, VaultClient would quietly swap in its console
 *    fallback and every suite injecting this logger would start exercising a
 *    different object than it thinks — while still passing.
 *  - `loggedText()` is what auth.iam and auth.appRole use to assert that a raw
 *    client_token *never* reaches the logger. A version that returned nothing
 *    would make those security assertions pass vacuously, which is the exact
 *    failure a "must not contain" assertion cannot detect on its own.
 *
 * Both are pinned below, against the real VaultClient rather than a restatement
 * of its rules.
 */
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import VaultClient from '../src/VaultClient.js';
import { LOG_METHODS, createNoopLogger, createSpyLogger, loggedText } from './helpers/logger.mjs';

use(sinonChai);

function bootOpts() {
    return {
        api: { url: 'https://example.com/' },
        logger: false,
        auth: { type: 'token', config: { token: 'tok-123' } },
    };
}

describe('test helpers: logger doubles', function () {
    afterEach(function () {
        VaultClient.clear();
    });

    describe('LOG_METHODS', function () {
        it('is exactly the interface VaultClient#__setupLogger requires', function () {
            // Mirrors the list in src/VaultClient.js. Kept as an explicit literal:
            // if VaultClient's requirement changes, this fails rather than silently
            // agreeing with whatever the helper happens to export.
            expect(LOG_METHODS).to.deep.equal(['error', 'warn', 'info', 'debug', 'trace']);
        });
    });

    describe('createNoopLogger()', function () {
        it('implements every log method as a function returning undefined', function () {
            const logger = createNoopLogger();
            expect(Object.keys(logger).sort()).to.deep.equal([...LOG_METHODS].sort());
            for (const method of LOG_METHODS) {
                expect(logger[method], `${method} must be callable`).to.be.a('function');
                expect(logger[method]('anything', { a: 1 }), `${method} must be a no-op`).to.be.undefined;
            }
        });

        it('is accepted verbatim by VaultClient, not replaced by the console fallback', function () {
            // The load-bearing one: __setupLogger returns the logger it was given
            // only when it implements the full interface, and a console fallback
            // otherwise. Identity here proves the suites that inject this logger
            // are really exercising it.
            const client = new VaultClient(bootOpts());
            const logger = createNoopLogger();
            expect(client.__setupLogger(logger)).to.equal(logger);
        });

        it('returns an independent object per call', function () {
            // Suites share the module, not the instance: one suite stubbing a
            // method must not leak into another.
            const a = createNoopLogger();
            const b = createNoopLogger();
            expect(a).to.not.equal(b);
            a.info = () => 'replaced';
            expect(b.info()).to.be.undefined;
        });
    });

    describe('createSpyLogger()', function () {
        it('exposes a recording spy for every log method', function () {
            const log = createSpyLogger();
            expect(Object.keys(log).sort()).to.deep.equal([...LOG_METHODS].sort());
            for (const method of LOG_METHODS) {
                // Asserted behaviourally rather than by type: what the suites need
                // is that each method records, which is what is checked here.
                log[method](`called-${method}`);
                expect(log[method], `${method} must record its calls`)
                    .to.have.been.calledOnceWithExactly(`called-${method}`);
            }
        });

        it('records the arguments it was called with', function () {
            const log = createSpyLogger();
            log.warn('careful %s', 'now');
            expect(log.warn).to.have.been.calledOnceWithExactly('careful %s', 'now');
            expect(log.error).to.not.have.been.called;
        });

        it('is also accepted by VaultClient as a complete logger', function () {
            const client = new VaultClient(bootOpts());
            const log = createSpyLogger();
            expect(client.__setupLogger(log)).to.equal(log);
        });
    });

    describe('loggedText()', function () {
        it('captures printf-style string arguments', function () {
            const log = createSpyLogger();
            log.info('token issued for %s', 'role-a');
            expect(loggedText(log)).to.contain('token issued for');
            expect(loggedText(log)).to.contain('role-a');
        });

        it('serialises object arguments, so %j / %o payloads are searchable', function () {
            // This is what makes the "secret must not be logged" assertions
            // meaningful: a token leaked inside an object payload has to be
            // findable, not swallowed by String(object) -> "[object Object]".
            const log = createSpyLogger();
            log.debug('auth response %j', { auth: { client_token: 's3cr3t-token' } });
            expect(loggedText(log)).to.contain('s3cr3t-token');
        });

        it('spans every log level, not just the first', function () {
            const log = createSpyLogger();
            for (const method of LOG_METHODS) {
                log[method](`marker-${method}`);
            }
            const text = loggedText(log);
            for (const method of LOG_METHODS) {
                expect(text, `${method} output must be included`).to.contain(`marker-${method}`);
            }
        });

        it('flattens multiple calls and multiple arguments into one string', function () {
            const log = createSpyLogger();
            log.info('first', 1);
            log.info('second', { deep: { value: 'nested-value' } });
            const text = loggedText(log);
            expect(text).to.contain('first');
            expect(text).to.contain('second');
            expect(text).to.contain('nested-value');
        });

        it('returns an empty string when nothing was logged', function () {
            // Pins the boundary the vacuity guard rests on: empty means "nothing
            // was logged", never "the helper failed to read the spies".
            expect(loggedText(createSpyLogger())).to.equal('');
        });
    });
});
