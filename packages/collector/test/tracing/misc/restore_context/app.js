'use strict';

const instana = require('../../../../')();

const logPrefix = `Restore Context (${process.pid}):\t`;

const fs = require('fs');
const http = require('http');
const path = require('path');
const pino = require('pino')();
const sharp = require('sharp');

const port = process.env.APP_PORT || 3222;
const app = new http.Server();

app.on('request', (req, res) => {
  if (process.env.WITH_STDOUT) {
    log(`${req.method} ${req.url}, is tracing: ${instana.core.tracing.getCls().isTracing()}`);
  }
  if (req.url === '/') {
    if (req.method === 'GET') {
      // This is just a simple way of testing that calling restoreAsyncContext without an actual context does not break
      // anything.
      // instana.restoreAsyncContext(null);
      return res.end();
    } else {
      res.statusCode = 405;
      return res.end();
    }
  } else if (req.url === '/trigger') {
    if (req.method === 'POST') {
      return handleTriggerRequest(res);
    } else {
      res.statusCode = 405;
      return res.end();
    }
  } else {
    res.statusCode = 404;
    return res.end();
  }
});

function handleTriggerRequest(res) {
  fs.readFile(path.join(__dirname, 'instana.png'), (readErr, imgBuffer) => {
    if (readErr) {
      log(readErr);
      res.statusCode = 500;
      return res.end();
    }

    // 1. Fetch the currently active asynchronous context directly _before_ the asynchronous operation that breaks
    // async_hooks/async_wrap continuity.
    const activeContext = instana.asyncContext();

    const sharpObj = sharp(imgBuffer);
    sharpObj.metadata(metadataErr => {
      // 2. Restore the asynchronous context directly _after_ the asynchronous operation that breaks
      // async_hooks/async_wrap continuity.
      instana.restoreAsyncContext(activeContext);

      if (metadataErr) {
        log(metadataErr);
        res.statusCode = 500;
        return res.end();
      }
      sharpObj.toBuffer(toBufferErr => {
        if (toBufferErr) {
          log(toBufferErr);
          res.statusCode = 500;
          return res.end();
        }

        pino.warn('Should be traced.');
        res.end();
      });
    });
  });
}

app.listen(port, () => {
  log(`Listening on port: ${port}`);
});

function log() {
  /* eslint-disable no-console */
  const args = Array.prototype.slice.call(arguments);
  args[0] = logPrefix + args[0];
  console.log.apply(console, args);
}
