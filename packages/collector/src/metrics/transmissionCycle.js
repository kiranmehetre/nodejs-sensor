'use strict';

var clone = require('@instana/core').util.clone;
var compression = require('@instana/core').util.compression;

var logger;
logger = require('../logger').getLogger('metrics/sender', function(newLogger) {
  logger = newLogger;
});

var resendFullDataEveryXTransmissions = 300; /* about every 5 minutes */
var transmissionsSinceLastFullDataEmit = 0;

var metrics;
var downstreamConnection;
var onSuccess;
var onError;

var previousTransmittedValue;
var transmissionTimeoutHandle;
var transmissionDelay = 1000;
var isActive = false;

exports.init = function init(config) {
  transmissionDelay = config.metrics.transmissionDelay;
};

exports.activate = function activate(_metrics, _downstreamConnection, _onSuccess, _onError) {
  metrics = _metrics;
  downstreamConnection = _downstreamConnection;
  onSuccess = _onSuccess;
  onError = _onError;

  if (!metrics) {
    logger.error('No metrics have been set.');
    return;
  }
  if (!metrics.gatherData) {
    logger.error('Configured metrics have no attribute "gatherData".');
    return;
  }
  if (typeof metrics.gatherData !== 'function') {
    logger.error('metrics.gatherData is not a function.');
    return;
  }
  if (!downstreamConnection) {
    logger.error('No downstreamConnection has been set.');
    return;
  }
  if (!downstreamConnection.sendMetrics) {
    logger.error('Configured downstreamConnection has no attribute "sendMetrics".');
    return;
  }
  if (typeof downstreamConnection.sendMetrics !== 'function') {
    logger.error('downstreamConnection.sendMetrics is not a function.');
    return;
  }

  isActive = true;

  transmissionsSinceLastFullDataEmit = 0;
  sendMetrics();
};

function sendMetrics() {
  if (!isActive) {
    return;
  }

  // clone retrieved objects to allow mutations in metric retrievers
  var newValueToTransmit = clone(metrics.gatherData());

  var payload;
  var isFullTransmission = transmissionsSinceLastFullDataEmit > resendFullDataEveryXTransmissions;
  if (isFullTransmission) {
    payload = newValueToTransmit;
  } else {
    payload = compression(previousTransmittedValue, newValueToTransmit);
  }

  downstreamConnection.sendMetrics(payload, onMetricsHaveBeenSent.bind(null, isFullTransmission, newValueToTransmit));
}

function onMetricsHaveBeenSent(isFullTransmission, transmittedValue, error, responsePayload) {
  if (error) {
    logger.error('Error received while trying to send snapshot data and metrics: %s', error.message);
    if (onError) {
      onError();
    }
    return;
  }
  previousTransmittedValue = transmittedValue;
  if (isFullTransmission) {
    transmissionsSinceLastFullDataEmit = 0;
  } else {
    transmissionsSinceLastFullDataEmit++;
  }
  if (onSuccess) {
    onSuccess(responsePayload);
  }
  transmissionTimeoutHandle = setTimeout(sendMetrics, transmissionDelay);
  transmissionTimeoutHandle.unref();
}

exports.deactivate = function() {
  isActive = false;
  previousTransmittedValue = undefined;
  clearTimeout(transmissionTimeoutHandle);
};
