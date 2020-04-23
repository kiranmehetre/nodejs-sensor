/* eslint-disable no-console */

'use strict';

const agentPort = process.env.INSTANA_AGENT_PORT;

require('../../../../')();

const bodyParser = require('body-parser');
const express = require('express');
const morgan = require('morgan');
const request = require('request-promise-native');
const elasticsearch = require('elasticsearch');

const app = express();
const logPrefix = `Elasticsearch (Legacy Client) (${process.pid}):\t`;

if (process.env.WITH_STDOUT) {
  app.use(morgan(`${logPrefix}:method :url :status`));
}

app.use(bodyParser.json());

const client = new elasticsearch.Client({
  host: process.env.ELASTICSEARCH,
  log: 'warning'
});

app.get('/', (req, res) => {
  res.sendStatus(200);
});

app.get('/get', (req, res) => {
  client.get(
    {
      index: req.query.index || 'myindex',
      type: 'mytype',
      id: req.query.id
    },
    (error, response) => {
      res.json({ error, response });
    }
  );
});

app.get('/search', (req, res) => {
  client
    .search({
      index: req.query.index || 'myindex',
      type: 'mytype',
      q: req.query.q
    })
    .then(
      response => {
        res.json({ response });
      },
      error => {
        res.json({ error });
      }
    );
});

app.get('/mget1', (req, res) => {
  const ids = req.query.id;
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: 'You need to provide an array of at least two document IDs.' });
  }
  client.mget(
    {
      body: {
        docs: [
          { _index: req.query.index || 'myindex', _type: 'mytype', _id: ids[0] },
          { _index: req.query.index || 'myindex', _type: 'mytype', _id: ids[1] }
        ]
      }
    },
    (error, response) => {
      if (error) {
        res.json({ error });
      } else {
        res.json({ response });
      }
    }
  );
});

app.get('/mget2', (req, res) => {
  const ids = req.query.id;
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: 'You need to provide an array of at least two document IDs.' });
  }
  client.mget(
    {
      index: req.query.index || 'myindex',
      type: 'mytype',
      body: {
        ids
      }
    },
    (error, response) => {
      if (error) {
        res.json({ error });
      } else {
        res.json({ response });
      }
    }
  );
});

app.get('/msearch', (req, res) => {
  const queryStrings = req.query.q;
  if (!Array.isArray(queryStrings) || queryStrings.length < 2) {
    return res.status(400).json({ error: 'You need to provide an array of at least two query params' });
  }
  const query = {
    body: [
      { index: req.query.index || 'myindex', type: 'mytype' },
      { query: { query_string: { query: req.query.q[0] } } },
      { index: req.query.index || 'myindex', type: 'mytype' },
      { query: { query_string: { query: req.query.q[1] } } }
    ]
  };
  client.msearch(query).then(
    response => {
      res.json({ response });
    },
    error => {
      res.json({ error });
    }
  );
});

app.post('/index', (req, res) => {
  client
    .index({
      index: req.query.index || 'myindex',
      type: 'mytype',
      body: req.body
    })
    .then(response =>
      client.indices
        .refresh({
          index: '_all',
          ignoreUnavailable: true
        })
        .then(
          () => response,
          error => {
            log('Index refresh failed.', error);
            throw error;
          }
        )
    )
    .then(
      response => {
        res.json({ response });
      },
      error => {
        res.json({ error });
      }
    );
});

app.get('/searchAndGet', (req, res) => {
  request(`http://127.0.0.1:${agentPort}`)
    .then(() =>
      client.search({
        index: req.query.index || 'myindex',
        type: 'mytype',
        q: req.query.q,
        ignoreUnavailable: true
      })
    )
    .then(response => {
      res.json({ response });
    })
    .catch(error => {
      res.json({ error });
    });
});

app.delete('/database', (req, res) => {
  client.indices
    .exists({
      index: req.query.index || 'myindex'
    })
    .then(response => {
      if (response === false) {
        return response;
      }

      return client.indices.delete({
        index: req.query.index || 'myindex'
      });
    })
    .then(response => {
      res.json({ response });
    })
    .catch(error => {
      res.json({ error });
    });
});

app.listen(process.env.APP_PORT, () => {
  log(`Listening on port: ${process.env.APP_PORT}`);
});

function log() {
  const args = Array.prototype.slice.call(arguments);
  args[0] = logPrefix + args[0];
  console.log.apply(console, args);
}