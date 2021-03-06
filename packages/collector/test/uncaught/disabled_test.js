'use strict';

const path = require('path');
const chai = require('chai');
const expect = chai.expect;
const assert = chai.assert;
const Promise = require('bluebird');

const supportedVersion = require('@instana/core').tracing.supportedVersion;
const config = require('../../../core/test/config');
const testUtils = require('../../../core/test/test_util');
const ProcessControls = require('../test_util/ProcessControls');

describe('uncaught exception reporting disabled', function() {
  if (!supportedVersion(process.versions.node)) {
    return;
  }

  const agentControls = require('../apps/agentStubControls');

  this.timeout(config.getTestTimeout());

  agentControls.registerTestHooks();

  const serverControls = new ProcessControls({
    appPath: path.join(__dirname, 'apps', 'server'),
    dontKillInAfterHook: true,
    agentControls
  }).registerTestHooks();

  it('will not finish the current span', () =>
    serverControls
      .sendRequest({
        method: 'GET',
        path: '/boom',
        simple: false,
        resolveWithFullResponse: true
      })
      .then(response => {
        assert.fail(response, 'no response', 'Unexpected response, server should have crashed');
      })
      .catch(err => {
        expect(err.name).to.equal('RequestError');
        expect(err.message).to.equal('Error: socket hang up');

        return Promise.delay(1000).then(() =>
          testUtils.retry(() =>
            agentControls.getSpans().then(spans => {
              expect(spans).to.have.lengthOf(0);
            })
          )
        );
      }));

  it('must not report the uncaught exception as an issue', () =>
    serverControls
      .sendRequest({
        method: 'GET',
        path: '/boom',
        simple: false,
        resolveWithFullResponse: true
      })
      .then(response => {
        assert.fail(response, 'no response', 'Unexpected response, server should have crashed');
      })
      .catch(err => {
        expect(err.name).to.equal('RequestError');
        expect(err.message).to.equal('Error: socket hang up');
        return Promise.delay(1000).then(() =>
          testUtils.retry(() =>
            agentControls.getEvents().then(events => {
              expect(events).to.have.lengthOf(0);
            })
          )
        );
      }));
});
