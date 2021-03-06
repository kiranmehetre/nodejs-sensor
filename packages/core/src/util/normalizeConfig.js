/* eslint-disable */

'use strict';

var supportedTracingVersion = require('../tracing/supportedVersion');

var logger;
logger = require('../logger').getLogger('configuration', function(newLogger) {
  logger = newLogger;
});

var defaults = {
  serviceName: null,

  metrics: {
    transmissionDelay: 1000,
    timeBetweenHealthcheckCalls: 3000
  },
  tracing: {
    enabled: true,
    automaticTracingEnabled: true,
    forceTransmissionStartingAt: 500,
    maxBufferedSpans: 1000,
    transmissionDelay: 1000,
    http: {
      extraHttpHeadersToCapture: []
    },
    stackTraceLength: 10,
    disabledTracers: []
  },
  secrets: {
    matcherMode: 'contains-ignore-case',
    keywords: ['key', 'pass', 'secret']
  }
};

var validSecretsMatcherModes = ['equals-ignore-case', 'equals', 'contains-ignore-case', 'contains', 'regex', 'none'];

/**
 * Merges the config that was passed to the init function with environment variables and default values.
 */
module.exports = exports = function normalizeConfig(config) {
  if (config == null) {
    config = {};
  }

  normalizeServiceName(config);
  normalizeMetricsConfig(config);
  normalizeTracingConfig(config);
  normalizeSecrets(config);
  return config;
};

function normalizeServiceName(config) {
  if (config.serviceName == null && process.env['INSTANA_SERVICE_NAME']) {
    config.serviceName = process.env['INSTANA_SERVICE_NAME'];
  }
  if (config.serviceName != null && typeof config.serviceName !== 'string') {
    logger.warn(
      'Invalid configuration: config.serviceName is not a string, the value will be ignored: ' + config.serviceName
    );
    config.serviceName = defaults.serviceName;
  }
}

function normalizeMetricsConfig(config) {
  if (config.metrics == null) {
    config.metrics = {};
  }

  config.metrics.transmissionDelay = normalizeSingleValue(
    config.metrics.transmissionDelay,
    defaults.metrics.transmissionDelay,
    'config.metrics.transmissionDelay',
    'INSTANA_METRICS_TRANSMISSION_DELAY'
  );

  // The correct location for this is config.metrics.timeBetweenHealthcheckCalls but previous versions accepted
  // config.timeBetweenHealthcheckCalls. We still accept that to not break applications relying on that.
  config.metrics.timeBetweenHealthcheckCalls =
    config.metrics.timeBetweenHealthcheckCalls ||
    config.timeBetweenHealthcheckCalls ||
    defaults.metrics.timeBetweenHealthcheckCalls;
  delete config.timeBetweenHealthcheckCalls;
}

function normalizeTracingConfig(config) {
  if (config.tracing == null) {
    config.tracing = {};
  }
  normalizeTracingEnabled(config);
  normalizeAutomaticTracingEnabled(config);
  normalizeTracingTransmission(config);
  normalizeTracingHttp(config);
  normalizeTracingStackTraceLength(config);
  normalizeDisabledTracers(config);
}

function normalizeTracingEnabled(config) {
  if (config.tracing.enabled === false) {
    logger.info('Not enabling tracing as it is explicitly disabled via config.');
    return;
  }
  if (config.tracing.enabled === true) {
    return;
  }
  if (process.env['INSTANA_DISABLE_TRACING'] === 'true') {
    logger.info('Not enabling tracing as it is explicitly disabled via environment variable INSTANA_DISABLE_TRACING.');
    config.tracing.enabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  config.tracing.enabled = defaults.tracing.enabled;
}

function normalizeAutomaticTracingEnabled(config) {
  if (!config.tracing.enabled) {
    logger.info('Not enabling automatic tracing as tracing in general is explicitly disabled via config.');
    config.tracing.automaticTracingEnabled = false;
    return;
  }

  if (config.tracing.automaticTracingEnabled === false || config.tracing.disableAutomaticTracing) {
    logger.info('Not enabling automatic tracing as it is explicitly disabled via config.');
    config.tracing.automaticTracingEnabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  if (process.env['INSTANA_DISABLE_AUTO_INSTR'] === 'true') {
    logger.info(
      'Not enabling automatic tracing as it is explicitly disabled via environment variable INSTANA_DISABLE_AUTO_INSTR.'
    );
    config.tracing.automaticTracingEnabled = false;
    delete config.tracing.disableAutomaticTracing;
    return;
  }

  if (!supportedTracingVersion(process.versions.node)) {
    logger.warn(
      'Not enabling automatic tracing, this is an unsupported version of Node.js. ' +
        'See: https://docs.instana.io/ecosystem/node-js/#supported-nodejs-versions'
    );
    config.tracing.automaticTracingEnabled = false;
    return;
  }

  config.tracing.automaticTracingEnabled = defaults.tracing.automaticTracingEnabled;
}

function normalizeTracingTransmission(config) {
  config.tracing.maxBufferedSpans = config.tracing.maxBufferedSpans || defaults.tracing.maxBufferedSpans;

  config.tracing.transmissionDelay = normalizeSingleValue(
    config.tracing.transmissionDelay,
    defaults.tracing.transmissionDelay,
    'config.tracing.transmissionDelay',
    'INSTANA_TRACING_TRANSMISSION_DELAY'
  );

  config.tracing.forceTransmissionStartingAt = normalizeSingleValue(
    config.tracing.forceTransmissionStartingAt,
    defaults.tracing.forceTransmissionStartingAt,
    'config.tracing.forceTransmissionStartingAt',
    'INSTANA_FORCE_TRANSMISSION_STARTING_AT'
  );
}

function normalizeTracingHttp(config) {
  config.tracing.http = config.tracing.http || {};

  if (!config.tracing.http.extraHttpHeadersToCapture) {
    config.tracing.http.extraHttpHeadersToCapture = defaults.tracing.http.extraHttpHeadersToCapture;
    return;
  }
  if (!Array.isArray(config.tracing.http.extraHttpHeadersToCapture)) {
    logger.warn(
      'Invalid configuration: config.tracing.http.extraHttpHeadersToCapture is not an array, ' +
        'the value will be ignored: ' +
        JSON.stringify(config.tracing.http.extraHttpHeadersToCapture)
    );
    config.tracing.http.extraHttpHeadersToCapture = defaults.tracing.http.extraHttpHeadersToCapture;
    return;
  }

  config.tracing.http.extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture.map(function(s) {
    // Node.js HTTP API turns all incoming HTTP headers into lowercase.
    return s.toLowerCase();
  });
}

function normalizeTracingStackTraceLength(config) {
  if (config.tracing.stackTraceLength == null && process.env['INSTANA_STACK_TRACE_LENGTH']) {
    parseStringStackTraceLength(config, process.env['INSTANA_STACK_TRACE_LENGTH']);
  }
  if (config.tracing.stackTraceLength != null) {
    if (typeof config.tracing.stackTraceLength === 'number') {
      config.tracing.stackTraceLength = normalizeNumericalStackTraceLength(config.tracing.stackTraceLength);
    } else if (typeof config.tracing.stackTraceLength === 'string') {
      parseStringStackTraceLength(config, config.tracing.stackTraceLength);
    } else {
      logger.warn(
        'The value of config.tracing.stackTraceLength has the non-supported type %s (the value is "%s"). Assuming ' +
          'the default stack trace length %s.',
        typeof config.tracing.stackTraceLength,
        config.tracing.stackTraceLength,
        defaults.tracing.stackTraceLength
      );
      config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
    }
  } else {
    config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
  }
}

function parseStringStackTraceLength(config, value) {
  config.tracing.stackTraceLength = parseInt(value, 10);
  if (!isNaN(config.tracing.stackTraceLength)) {
    config.tracing.stackTraceLength = normalizeNumericalStackTraceLength(config.tracing.stackTraceLength);
  } else {
    logger.warn(
      'The value of config.tracing.stackTraceLength ("%s") has type string and cannot be parsed to a numerical ' +
        'value. Assuming the default stack trace length %s.',
      value,
      defaults.tracing.stackTraceLength
    );
    config.tracing.stackTraceLength = defaults.tracing.stackTraceLength;
  }
}

function normalizeNumericalStackTraceLength(numericalLength) {
  // just in case folks provide non-integral numbers or negative numbers
  var normalized = Math.abs(Math.round(numericalLength));
  if (normalized !== numericalLength) {
    logger.warn(
      'Normalized the provided value of config.tracing.stackTraceLength (%s) to %s.',
      numericalLength,
      normalized
    );
  }
  return normalized;
}

function normalizeDisabledTracers(config) {
  if (
    config.tracing.disabledTracers == null &&
    process.env['INSTANA_DISABLED_TRACERS'] &&
    process.env['INSTANA_DISABLED_TRACERS'].trim().length >= 0
  ) {
    config.tracing.disabledTracers = process.env['INSTANA_DISABLED_TRACERS']
      .split(',')
      .map(function(key) {
        return key.trim().toLowerCase();
      })
      .filter(function(key) {
        return key.length >= 0;
      });
  }

  if (!config.tracing.disabledTracers) {
    config.tracing.disabledTracers = defaults.tracing.disabledTracers;
  }

  if (!Array.isArray(config.tracing.disabledTracers)) {
    logger.warn(
      'Invalid configuration: config.tracing.disabledTracers is not an array, ' +
        'the value will be ignored: ' +
        JSON.stringify(config.tracing.disabledTracers)
    );
    config.tracing.disabledTracers = defaults.tracing.disabledTracers;
    return;
  }

  config.tracing.disabledTracers = config.tracing.disabledTracers.map(function(s) {
    // We'll check for matches in an case-insensitive fashion
    return s.toLowerCase();
  });
}

function normalizeSecrets(config) {
  if (config.secrets == null) {
    config.secrets = {};
  }

  config.secrets.matcherMode = config.secrets.matcherMode || defaults.secrets.matcherMode;
  config.secrets.keywords = config.secrets.keywords || defaults.secrets.keywords;

  if (typeof config.secrets.matcherMode !== 'string') {
    logger.warn(
      'The value of config.secrets.matcherMode ("%s") is not a string. Assuming the default value %s.',
      config.secrets.matcherMode,
      defaults.secrets.matcherMode
    );
    config.secrets.matcherMode = defaults.secrets.matcherMode;
  } else if (validSecretsMatcherModes.indexOf(config.secrets.matcherMode) < 0) {
    logger.warn(
      'The value of config.secrets.matcherMode (%s) is not a supported matcher mode. Assuming the default value %s.',
      config.secrets.matcherMode,
      defaults.secrets.matcherMode
    );
    config.secrets.matcherMode = defaults.secrets.matcherMode;
  } else if (!Array.isArray(config.secrets.keywords)) {
    logger.warn(
      'The value of config.secrets.keywords (%s) is not an array. Assuming the default value %s.',
      config.secrets.keywords,
      defaults.secrets.keywords
    );
    config.secrets.keywords = defaults.secrets.keywords;
  }
}

function normalizeSingleValue(configValue, defaultValue, configPath, envVarKey) {
  var envVarVal = process.env[envVarKey];
  var originalValue = configValue;
  if (configValue == null && envVarVal == null) {
    return defaultValue;
  } else if (configValue == null && envVarVal != null) {
    originalValue = envVarVal;
    configValue = parseInt(originalValue, 10);
  }

  if (typeof configValue !== 'number' || isNaN(configValue)) {
    logger.warn(
      'The value of %s (or %s) ("%s") is ' +
        'not numerical or cannot be parsed to a numerical value. Assuming the default value %s.',
      configPath,
      envVarKey,
      originalValue,
      defaultValue
    );
    return defaultValue;
  }
  return configValue;
}
