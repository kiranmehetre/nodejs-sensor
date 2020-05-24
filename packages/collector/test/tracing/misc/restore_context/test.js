'use strict';

const expect = require('chai').expect;
const semver = require('semver');

const constants = require('@instana/core').tracing.constants;
const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../../../core/test/config');
const testUtils = require('../../../../../core/test/test_util');
const ProcessControls = require('../../../test_util/ProcessControls');

let agentControls;

describe.only('tracing/restore context', function() {
  // The version of sharp we are using is not compatible with Node.js >= 12.x
  if (!supportedVersion(process.versions.node) || semver.gte(process.versions.node, '12.0.0')) {
    return;
  }

  agentControls = require('../../../apps/agentStubControls');

  this.timeout(config.getTestTimeout());

  agentControls.registerTestHooks();

  describe('restore context', function() {
    const controls = new ProcessControls({
      dirname: __dirname,
      agentControls,
      port: 3222
    }).registerTestHooks();

    it('must capture spans after async context loss when manually restored', () =>
      controls
        .sendRequest({
          method: 'POST',
          path: '/trigger'
        })
        .then(verify));
  });
});

function verify() {
  return testUtils.retry(() =>
    agentControls.getSpans().then(spans => {
      const httpEntry = testUtils.expectAtLeastOneMatching(spans, span => {
        expect(span.n).to.equal('node.http.server');
        expect(span.k).to.equal(constants.ENTRY);
        expect(span.p).to.not.exist;
        expect(span.data.http.method).to.equal('POST');
        expect(span.data.http.url).to.equal('/trigger');
      });

      testUtils.expectAtLeastOneMatching(spans, span => {
        expect(span.n).to.equal('log.pino');
        expect(span.k).to.equal(constants.EXIT);
        expect(span.p).to.equal(httpEntry.s);
        expect(span.data.log.message).to.equal('Should be traced.');
      });
    })
  );
}
