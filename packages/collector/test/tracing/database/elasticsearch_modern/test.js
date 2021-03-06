'use strict';

const expect = require('chai').expect;
const semver = require('semver');

const constants = require('@instana/core').tracing.constants;
const config = require('../../../../../core/test/config');
const {
  stringifyItems,
  expectExactlyOneMatching,
  getSpansByName,
  retry
} = require('../../../../../core/test/test_util');
const ProcessControls = require('../../../test_util/ProcessControls');

const ES_API_VERSION = '7.6';

describe('tracing/elasticsearch (modern client)', function() {
  if (!semver.gte(process.versions.node, '8.0.0')) {
    return;
  }

  const agentControls = require('../../../apps/agentStubControls');

  this.timeout(config.getTestTimeout());

  agentControls.registerTestHooks();
  const controls = new ProcessControls({
    dirname: __dirname,
    agentControls,
    env: {
      ES_API_VERSION
    }
  }).registerTestHooks();

  it('must report errors caused by missing indices', () =>
    get({
      id: 'thisDocumentWillNotExist',
      index: 'thisIndexDoesNotExist'
    }).then(res => {
      expect(res.error).to.exist;
      expect(res.error.meta.body.error.root_cause[0].type).to.equal('index_not_found_exception');
      return retry(() =>
        agentControls.getSpans().then(spans => {
          const entrySpan = verifyHttpEntry(spans, '/get');

          expectExactlyOneMatching(spans, span => {
            expect(span.t).to.equal(entrySpan.t);
            expect(span.p).to.equal(entrySpan.s);
            expect(span.n).to.equal('elasticsearch');
            expect(span.f.e).to.equal(String(controls.getPid()));
            expect(span.f.h).to.equal('agent-stub-uuid');
            expect(span.async).to.not.exist;
            expect(span.error).to.not.exist;
            expect(span.ec).to.equal(1);
            expect(span.data.elasticsearch.cluster).to.be.a('string');
            expect(span.data.elasticsearch.action).to.equal('get');
            expect(span.data.elasticsearch.index).to.equal('thisIndexDoesNotExist');
            expect(span.data.elasticsearch.id).to.equal('thisDocumentWillNotExist');
            expect(span.data.elasticsearch.error).to.match(/index_not_found_exception/);
          });

          verifyHttpExit(spans, entrySpan);

          verifyNoHttpExitsToElasticsearch(spans);

          expect(spans).to.have.lengthOf(
            3,
            `Should not generate any superfluous spans Spans: ${stringifyItems(spans)}`
          );
        })
      );
    }));

  it('must report successful indexing requests', () =>
    index({
      body: {
        title: 'A'
      }
    }).then(res => {
      expect(res.error).to.not.exist;
      expect(res.response).to.exist;
      expect(res.response.body._index).to.equal('modern_index');
      expect(res.response.body._shards.successful).to.equal(1);
      return retry(() =>
        agentControls.getSpans().then(spans => {
          const entrySpan = verifyHttpEntry(spans, '/index');
          verifyElasticsearchExit(spans, entrySpan, 'index');
          verifyElasticsearchExit(spans, entrySpan, 'indices.refresh', null, '_all');
          verifyNoHttpExitsToElasticsearch(spans);
        })
      );
    }));

  it('must write to ES and retrieve the same document, tracing everything', () => {
    const titleA = `a${Date.now()}`;
    return index({
      body: {
        title: titleA
      }
    })
      .then(res1 => {
        expect(res1.error).to.not.exist;
        expect(res1.response).to.exist;
        expect(res1.response.statusCode).to.equal(201);
        expect(res1.response.body._index).to.equal('modern_index');
        expect(res1.response.body._shards.successful).to.equal(1);
        return retry(() =>
          get({
            id: res1.response.body._id
          }).then(res2 => {
            expect(res2.error).to.not.exist;
            expect(res2.response).to.exist;
            expect(res2.response.body._source.title).to.equal(titleA);
            return res2.response.body._id;
          })
        );
      })
      .then(documentId =>
        retry(() =>
          agentControls.getSpans().then(spans => {
            const indexEntrySpan = verifyHttpEntry(spans, '/index');
            verifyElasticsearchExit(spans, indexEntrySpan, 'index');
            verifyElasticsearchExit(spans, indexEntrySpan, 'indices.refresh', null, '_all');

            const getEntrySpan = verifyHttpEntry(spans, '/get');
            const getExitSpan = verifyElasticsearchExit(spans, getEntrySpan, 'get');
            expect(getExitSpan.data.elasticsearch.id).to.equal(documentId);
            verifyHttpExit(spans, getEntrySpan);

            verifyNoHttpExitsToElasticsearch(spans);
            expect(spans).to.have.lengthOf(6, `Spans: ${stringifyItems(spans)}`);
          })
        )
      );
  });

  it('must write to ES and search for matching documents, tracing everything', () => {
    const titleA = `a${Date.now()}`;
    const titleB = `b${Date.now()}`;

    return index({
      body: {
        title: titleA
      },
      parentSpanId: '42',
      traceId: '42'
    })
      .then(() =>
        index({
          body: {
            title: titleB
          },
          parentSpanId: '43',
          traceId: '43'
        })
      )
      .then(() =>
        retry(() =>
          search({
            q: `title:${titleA}`
          })
        )
      )
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        expect(res.response.body).to.be.an('object');
        expect(res.response.body.timed_out).to.be.false;
        expect(res.response.body.hits).to.be.an('object');
        if (hasTotalValue()) {
          expect(res.response.body.hits.total.value).to.equal(1);
        } else {
          expect(res.response.body.hits.total).to.equal(1);
        }
        expect(res.response.body.hits.hits).to.be.an('array');
        expect(res.response.body.hits.hits[0]._source.title).to.equal(titleA);

        return retry(() =>
          agentControls.getSpans().then(spans => {
            const index1Entry = verifyHttpEntry(spans, '/index', '42');
            verifyElasticsearchExit(spans, index1Entry, 'index');
            verifyElasticsearchExit(spans, index1Entry, 'indices.refresh', null, '_all');
            const index2Entry = verifyHttpEntry(spans, '/index', '43');
            verifyElasticsearchExit(spans, index2Entry, 'index');
            verifyElasticsearchExit(spans, index2Entry, 'indices.refresh', null, '_all');

            const searchEntrySpan = verifyHttpEntry(spans, '/search');
            const searchExitSpan = verifyElasticsearchExit(spans, searchEntrySpan, 'search');
            expect(searchExitSpan.data.elasticsearch.query).to.contain(`"q":"title:${titleA}"`);
            expect(searchExitSpan.data.elasticsearch.hits).to.equal(1);
            verifyHttpExit(spans, searchEntrySpan);

            verifyNoHttpExitsToElasticsearch(spans);

            expect(spans).to.have.lengthOf(9, `Spans: ${stringifyItems(spans)}`);
          })
        );
      });
  });

  it('must trace mget', () => {
    const titleA = `a${Date.now()}`;
    const titleB = `b${Date.now()}`;
    const titleC = `c${Date.now()}`;
    let idA;
    let idB;
    let idC;
    let response1;
    let response2;

    return index({
      body: {
        title: titleA
      },
      parentSpanId: '42',
      traceId: '42'
    })
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        idA = res.response.body._id;
        return index({
          body: {
            title: titleB
          },
          parentSpanId: '43',
          traceId: '43'
        });
      })
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        idB = res.response.body._id;
        return index({
          body: {
            title: titleC
          },
          parentSpanId: '44',
          traceId: '44'
        });
      })
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        idC = res.response.body._id;
        return retry(() =>
          mget1({
            id: [idA, idB]
          })
        );
      })
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        response1 = res.response.body;
        return retry(() =>
          mget2({
            id: [idB, idC]
          })
        );
      })
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        response2 = res.response.body;
        expect(response1.docs[0]._source.title).to.deep.equal(titleA);
        expect(response1.docs[1]._source.title).to.deep.equal(titleB);
        expect(response2.docs[0]._source.title).to.deep.equal(titleB);
        expect(response2.docs[1]._source.title).to.deep.equal(titleC);
        return retry(() =>
          agentControls.getSpans().then(spans => {
            verifyElasticsearchExit(spans, null, 'index', '42');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '42', '_all');
            verifyElasticsearchExit(spans, null, 'index', '43');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '43', '_all');
            verifyElasticsearchExit(spans, null, 'index', '44');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '44', '_all');

            const mget1HttpEntry = verifyHttpEntry(spans, '/mget1');
            const mget1Exit = verifyElasticsearchExit(spans, mget1HttpEntry, 'mget');
            expect(mget1Exit.data.elasticsearch.id).to.equal(`${idA},${idB}`);

            const mget2HttpEntry = verifyHttpEntry(spans, '/mget2');
            const mget2Exit = verifyElasticsearchExit(spans, mget2HttpEntry, 'mget');
            expect(mget2Exit.data.elasticsearch.id).to.equal(`${idB},${idC}`);

            verifyNoHttpExitsToElasticsearch(spans);
          })
        );
      });
  });

  it('must trace msearch', () => {
    const titleA = `a${Date.now()}`;
    const titleB = `b${Date.now()}`;
    const titleC = `c${Date.now()}`;

    return index({
      body: {
        title: titleA
      },
      parentSpanId: '42',
      traceId: '42'
    })
      .then(() =>
        index({
          body: {
            title: titleB
          },
          parentSpanId: '43',
          traceId: '43'
        })
      )
      .then(() =>
        index({
          body: {
            title: titleC
          },
          parentSpanId: '44',
          traceId: '44'
        })
      )
      .then(() =>
        retry(() =>
          msearch({
            q: [`title:${titleA}`, `title:${titleB}`]
          })
        )
      )
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        expect(res.response.body).to.be.an('object');
        expect(res.response.body.responses).to.exist;
        expect(res.response.body.responses).to.have.lengthOf(2);
        if (hasTotalValue()) {
          expect(res.response.body.responses[0].hits.total.value).to.equal(1);
          expect(res.response.body.responses[1].hits.total.value).to.equal(1);
        } else {
          expect(res.response.body.responses[0].hits.total).to.equal(1);
          expect(res.response.body.responses[1].hits.total).to.equal(1);
        }
        expect(res.response.body.responses[0].hits.hits[0]._source.title).to.be.oneOf([titleA, titleB]);
        expect(res.response.body.responses[1].hits.hits[0]._source.title).to.be.oneOf([titleA, titleB]);
        return retry(() =>
          agentControls.getSpans().then(spans => {
            verifyElasticsearchExit(spans, null, 'index', '42');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '42', '_all');
            verifyElasticsearchExit(spans, null, 'index', '43');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '43', '_all');
            verifyElasticsearchExit(spans, null, 'index', '44');
            verifyElasticsearchExit(spans, null, 'indices.refresh', '44', '_all');

            const msearchEntrySpan = verifyHttpEntry(spans, '/msearch');
            const msearchExitSpan = verifyElasticsearchExit(spans, msearchEntrySpan, 'msearch');
            expect(msearchExitSpan.data.elasticsearch.query).to.contain(`title:${titleA}`);
            expect(msearchExitSpan.data.elasticsearch.query).to.contain(`title:${titleB}`);
            expect(msearchExitSpan.data.elasticsearch.hits).to.equal(2);

            verifyNoHttpExitsToElasticsearch(spans);
          })
        );
      });
  });

  it('must not consider queries as failed when there are no hits', () =>
    index({
      body: {
        title: 'A'
      }
    })
      .then(() =>
        retry(() =>
          search({
            q: 'title:Z'
          })
        )
      )
      .then(res => {
        expect(res.error).to.not.exist;
        expect(res.response).to.exist;
        if (hasTotalValue()) {
          expect(res.response.body.hits.total.value).to.equal(0);
        } else {
          expect(res.response.body.hits.total).to.equal(0);
        }
        expect(res.response.body.hits.hits).to.have.lengthOf(0);
        return retry(() =>
          agentControls.getSpans().then(spans => {
            const entrySpan = verifyHttpEntry(spans, '/index');
            verifyElasticsearchExit(spans, entrySpan, 'index');
            verifyElasticsearchExit(spans, entrySpan, 'indices.refresh', null, '_all');

            const searchExit = verifyElasticsearchExit(spans, null, 'search');
            expect(searchExit.data.elasticsearch.hits).to.equal(0);

            verifyNoHttpExitsToElasticsearch(spans);
          })
        );
      }));

  function get(opts) {
    return sendRequest('GET', '/get', opts);
  }

  function search(opts) {
    return sendRequest('GET', '/search', opts);
  }

  function mget1(opts) {
    return sendRequest('GET', '/mget1', opts);
  }

  function mget2(opts) {
    return sendRequest('GET', '/mget2', opts);
  }

  function msearch(opts) {
    return sendRequest('GET', '/msearch', opts);
  }

  function index(opts) {
    return sendRequest('POST', '/index', opts);
  }

  function sendRequest(method, path, opts) {
    opts.method = method;
    opts.path = path;
    opts.qs = {
      id: opts.id,
      q: opts.q,
      index: opts.index
    };
    if (opts.traceId || opts.parentSpanId) {
      const headers = {};
      if (opts.traceId) {
        headers['X-INSTANA-T'] = opts.traceId;
      }
      if (opts.parentSpanId) {
        headers['X-INSTANA-S'] = opts.parentSpanId;
      }
      opts.headers = headers;
    }
    return controls.sendRequest(opts);
  }

  function verifyHttpEntry(spans, url, traceId) {
    return expectExactlyOneMatching(spans, span => {
      expect(span.n).to.equal('node.http.server');
      if (traceId) {
        expect(span.t).to.equal(traceId);
        expect(span.p).to.equal(traceId);
      } else {
        expect(span.t).to.exist;
        expect(span.p).to.not.exist;
      }
      expect(span.f.e).to.equal(String(controls.getPid()));
      expect(span.f.h).to.equal('agent-stub-uuid');
      expect(span.async).to.not.exist;
      expect(span.error).to.not.exist;
      expect(span.ec).to.equal(0);
      expect(span.data.http.url).to.equal(url);
    });
  }

  function verifyElasticsearchExit(spans, parent, action, traceId, indexName) {
    return expectExactlyOneMatching(spans, span => {
      if (parent) {
        expect(span.t).to.equal(parent.t);
        expect(span.p).to.equal(parent.s);
      } else if (traceId) {
        expect(span.t).to.equal(traceId);
      }
      expect(span.n).to.equal('elasticsearch');
      expect(span.f.e).to.equal(String(controls.getPid()));
      expect(span.f.h).to.equal('agent-stub-uuid');
      expect(span.async).to.not.exist;
      expect(span.error).to.not.exist;
      expect(span.ec).to.equal(0);
      expect(span.data.elasticsearch.cluster).to.be.a('string');
      expect(span.data.elasticsearch.action).to.equal(action);
      expect(span.data.elasticsearch.index).to.equal(indexName || 'modern_index');
      if (needsType() && indexName !== '_all') {
        expect(span.data.elasticsearch.type).to.equal('modern_type');
      }
    });
  }

  function verifyHttpExit(spans, parent) {
    expectExactlyOneMatching(spans, span => {
      expect(span.t).to.equal(parent.t);
      expect(span.p).to.equal(parent.s);
      expect(span.n).to.equal('node.http.client');
      expect(span.k).to.equal(constants.EXIT);
      expect(span.f.e).to.equal(String(controls.getPid()));
      expect(span.f.h).to.equal('agent-stub-uuid');
      expect(span.async).to.not.exist;
      expect(span.error).to.not.exist;
      expect(span.ec).to.equal(0);
      expect(span.data.http.method).to.equal('GET');
      expect(span.data.http.url).to.match(/http:\/\/127\.0\.0\.1:3210/);
      expect(span.data.http.status).to.equal(200);
    });
  }

  function verifyNoHttpExitsToElasticsearch(spans) {
    const allHttpExits = getSpansByName(spans, 'node.http.client');
    allHttpExits.forEach(span => {
      expect(span.data.http.url).to.not.match(/9200/);
    });
  }
});

function hasTotalValue() {
  return ES_API_VERSION.indexOf('2') !== 0 && ES_API_VERSION.indexOf('5') !== 0 && ES_API_VERSION.indexOf('6') !== 0;
}

function needsType() {
  return ES_API_VERSION.indexOf('5') === 0 || ES_API_VERSION.indexOf('6') === 0;
}
