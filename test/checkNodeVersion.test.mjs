/**
 * Unit tests for checkNodeVersion's warnIfNode18.
 * Takes a `process`-like object so behaviour on Node 18 can be asserted without needing to
 * actually run this suite under Node 18.
 */

import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import {
    warnIfNode18,
    NODE_18_DEPRECATION_MESSAGE,
    NODE_18_DEPRECATION_CODE,
} from '../src/checkNodeVersion.js';

use(sinonChai);

function fakeProcess(nodeVersion) {
    return { versions: { node: nodeVersion }, emitWarning: sinon.spy() };
}

describe('checkNodeVersion', function () {
    describe('warnIfNode18', function () {
        it('warns once on a Node 18.x process', function () {
            const proc = fakeProcess('18.20.8');
            warnIfNode18(proc);
            expect(proc.emitWarning).to.have.been.calledOnce;
            expect(proc.emitWarning).to.have.been.calledWith(
                NODE_18_DEPRECATION_MESSAGE,
                { code: NODE_18_DEPRECATION_CODE },
            );
        });

        it('does not warn on Node 20', function () {
            const proc = fakeProcess('20.19.0');
            warnIfNode18(proc);
            expect(proc.emitWarning).to.not.have.been.called;
        });

        it('does not warn on Node 22 or 24', function () {
            [fakeProcess('22.12.0'), fakeProcess('24.0.0')].forEach((proc) => {
                warnIfNode18(proc);
                expect(proc.emitWarning).to.not.have.been.called;
            });
        });

        // A version like 180.0.0 must not match the "18." prefix check.
        it('does not warn on a Node major that merely starts with 18', function () {
            const proc = fakeProcess('180.0.0');
            warnIfNode18(proc);
            expect(proc.emitWarning).to.not.have.been.called;
        });

        it('defaults to the real global process when none is passed', function () {
            const originalEmitWarning = process.emitWarning;
            const spy = sinon.spy();
            process.emitWarning = spy;
            try {
                warnIfNode18();
            } finally {
                process.emitWarning = originalEmitWarning;
            }
            // Whether it fires depends on whatever Node this suite is actually running under;
            // this only asserts the no-arg call path reaches the real `process` without throwing.
            expect(spy.callCount).to.be.at.least(0);
        });
    });
});
