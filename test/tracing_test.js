'use strict';

var expect = require('chai').expect;
var Promise = require('bluebird');

var supportsAsyncWrap = require('../src/tracing/index').supportsAsyncWrap;
var expressProxyControls = require('./apps/expressProxyControls');
var agentStubControls = require('./apps/agentStubControls');
var expressControls = require('./apps/expressControls');
var config = require('./config');
var utils = require('./utils');

describe('tracing', function() {
  if (!supportsAsyncWrap(process.versions.node)) {
    return;
  }

  this.timeout(config.getTestTimeout());

  agentStubControls.registerTestHooks();
  expressControls.registerTestHooks();

  beforeEach(function() {
    return agentStubControls.waitUntilAppIsCompletelyInitialized(expressControls.getPid());
  });

  it('must send a span to the agent', function() {
    return expressControls.sendRequest({
      method: 'POST',
      path: '/checkout',
      responseStatus: 201
    })
    .then(function() {
      return utils.retry(function() {
        return agentStubControls.getSpans()
        .then(function(spans) {
          expect(spans.length).to.be.above(0, 'Expecting at least one span');
        });
      });
    });
  });

  describe('httpServer', function() {
    it('must send a HTTP span to the agent', function() {
      return expressControls.sendRequest({
        method: 'POST',
        path: '/checkout',
        responseStatus: 201
      })
      .then(function() {
        return utils.retry(function() {
          return agentStubControls.getSpans()
          .then(function(spans) {
            utils.expectOneMatching(spans, function(span) {
              expect(span.n).to.equal('node.http.server');
              expect(span.async).to.equal(false);
              expect(span.error).to.equal(false);
              expect(span.data.http.method).to.equal('POST');
              expect(span.data.http.url).to.equal('/checkout');
              expect(span.data.http.status).to.equal(201);
              expect(span.data.http.host).to.equal('127.0.0.1:3211');
            });
          });
        });
      });
    });

    it('must translate 5XX status codes to error flags', function() {
      return expressControls.sendRequest({
        method: 'POST',
        path: '/checkout',
        responseStatus: 503
      })
      .then(function() {
        return utils.retry(function() {
          return agentStubControls.getSpans()
          .then(function(spans) {
            utils.expectOneMatching(spans, function(span) {
              expect(span.n).to.equal('node.http.server');
              expect(span.async).to.equal(false);
              expect(span.error).to.equal(true);
              expect(span.data.http.method).to.equal('POST');
              expect(span.data.http.url).to.equal('/checkout');
              expect(span.data.http.status).to.equal(503);
            });
          });
        });
      });
    });

    it('must not interrupt cookie settings of application', function() {
      var expectedCookie = 'sessionId=42';
      return expressControls.sendRequest({
        method: 'POST',
        path: '/checkout',
        responseStatus: 200,
        cookie: expectedCookie,
        resolveWithFullResponse: true
      })
      .then(function(response) {
        var cookieHeader = response.headers['set-cookie'];
        expect(cookieHeader[0]).to.equal('sessionId=42');
        expect(cookieHeader[1].indexOf('ibs_')).to.equal(0);
      });
    });
  });

  describe('with proxy', function() {
    expressProxyControls.registerTestHooks();

    beforeEach(function() {
      return agentStubControls.waitUntilAppIsCompletelyInitialized(expressProxyControls.getPid());
    });

    describe('httpClient', function() {
      it('must stitch together HTTP server -> client -> server calls', function() {
        return expressProxyControls.sendRequest({
          method: 'POST',
          path: '/checkout',
          responseStatus: 201
        })
        .then(function() {
          return utils.retry(function() {
            return agentStubControls.getSpans()
            .then(function(spans) {
              expect(spans.length).to.equal(3, 'Expecting at most three spans');

              // proxy entry span
              var proxyEntrySpan = utils.expectOneMatching(spans, function(span) {
                expect(span.n).to.equal('node.http.server');
                expect(span.f.e).to.equal(String(expressProxyControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('/checkout');
                expect(span.data.http.status).to.equal(201);
              });

              // proxy exit span
              var proxyExitSpan = utils.expectOneMatching(spans, function(span) {
                expect(span.t).to.equal(proxyEntrySpan.t);
                expect(span.p).to.equal(proxyEntrySpan.s);
                expect(span.n).to.equal('node.http.client');
                expect(span.f.e).to.equal(String(expressProxyControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('http://127.0.0.1:3211/proxy-call/checkout');
                expect(span.data.http.status).to.equal(201);
              });

              utils.expectOneMatching(spans, function(span) {
                expect(span.t).to.equal(proxyEntrySpan.t);
                expect(span.p).to.equal(proxyExitSpan.s);
                expect(span.n).to.equal('node.http.server');
                expect(span.f.e).to.equal(String(expressControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('/proxy-call/checkout');
                expect(span.data.http.status).to.equal(201);
              });
            });
          });
        });
      });

      it('must not generate traces when the suppression header is set', function() {
        return expressProxyControls.sendRequest({
          method: 'POST',
          path: '/checkout',
          responseStatus: 503,
          suppressTracing: true
        })
        .then(Promise.delay(200))
        .then(function() {
          return utils.retry(function() {
            return agentStubControls.getSpans()
            .then(function(spans) {
              expect(spans).to.have.lengthOf(0, 'Spans: ' + JSON.stringify(spans, 0, 2));
            });
          });
        });
      });

      it('must trace requests to non-existing targets', function() {
        return expressProxyControls.sendRequest({
          method: 'POST',
          path: '/callNonExistingTarget',
          responseStatus: 503,
          target: 'http://127.0.0.2:49162/foobar'
        })
        .then(function() {
          return utils.retry(function() {
            return agentStubControls.getSpans()
            .then(function(spans) {
              utils.expectOneMatching(spans, function(span) {
                expect(span.n).to.equal('node.http.client');
                expect(span.f.e).to.equal(String(expressProxyControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.data.http.error).to.be.a('string');
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('http://127.0.0.2:49162/foobar');
              });
            });
          });
        });
      });

      it('must not explode when asked to request unknown hosts', function() {
        return expressProxyControls.sendRequest({
          method: 'POST',
          path: '/callInvalidUrl',
          responseStatus: 503,
          target: '://127.0.0.2:49162/foobar'
        })
        .then(function() {
          return utils.retry(function() {
            return agentStubControls.getSpans()
            .then(function(spans) {
              expect(spans).to.have.lengthOf(1);

              utils.expectOneMatching(spans, function(span) {
                expect(span.n).to.equal('node.http.server');
              });
            });
          });
        });
      });
    });

    it('must support tracing of concurrent calls', function() {
      var callsNumbers = [];
      for (var i = 0; i < 20; i++) {
        callsNumbers.push(i);
      }

      var calls = Promise.all(callsNumbers.map(function(call) {
        return expressProxyControls.sendRequest({
          method: 'POST',
          path: '/call-' + call,
          responseStatus: call % 20 + 200,
          delay: 10
        });
      }));

      return calls
      .then(function() {
        return utils.retry(function() {
          return agentStubControls.getSpans()
          .then(function(spans) {
            callsNumbers.forEach(function(call) {
              var proxyEntrySpan = utils.expectOneMatching(spans, function(span) {
                expect(span.n).to.equal('node.http.server');
                expect(span.f.e).to.equal(String(expressProxyControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('/call-' + call);
                expect(span.data.http.status).to.equal(call % 20 + 200);
              });

              // proxy exit span
              var proxyExitSpan = utils.expectOneMatching(spans, function(span) {
                expect(span.t).to.equal(proxyEntrySpan.t);
                expect(span.p).to.equal(proxyEntrySpan.s);
                expect(span.n).to.equal('node.http.client');
                expect(span.f.e).to.equal(String(expressProxyControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('http://127.0.0.1:3211/proxy-call/call-' + call);
                expect(span.data.http.status).to.equal(call % 20 + 200);
              });

              utils.expectOneMatching(spans, function(span) {
                expect(span.t).to.equal(proxyEntrySpan.t);
                expect(span.p).to.equal(proxyExitSpan.s);
                expect(span.n).to.equal('node.http.server');
                expect(span.f.e).to.equal(String(expressControls.getPid()));
                expect(span.async).to.equal(false);
                expect(span.error).to.equal(false);
                expect(span.data.http.method).to.equal('POST');
                expect(span.data.http.url).to.equal('/proxy-call/call-' + call);
                expect(span.data.http.status).to.equal(call % 20 + 200);
              });
            });
          });
        });
      });
    });
  });
});