'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'logs');
const ROOT_LOG_FILE = path.join(ROOT_LOG_DIR, 'ecf.log');
const MODULE_LOG_DIR = path.resolve(__dirname, '..', 'logs');

function ensureLogTargets() {
  fs.mkdirSync(ROOT_LOG_DIR, { recursive: true });
  fs.mkdirSync(MODULE_LOG_DIR, { recursive: true });
  if (!fs.existsSync(ROOT_LOG_FILE)) {
    fs.writeFileSync(ROOT_LOG_FILE, '', 'utf8');
  }
}

function sanitize(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9\-_.=]+/gi, '$1[REDACTED]')
      .replace(/("?(?:password|token|cert_password|dgii_password)"?\s*:\s*")([^"]+)"/gi, '$1[REDACTED]"');
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(password|token)$/i.test(key)) next[key] = '[REDACTED]';
      else next[key] = sanitize(entry);
    }
    return next;
  }
  return value;
}

function writeLog(level, scope, message, context = null) {
  ensureLogTargets();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    context: sanitize(context),
  };
  fs.appendFileSync(ROOT_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

function createLogger(scope, { debug = false } = {}) {
  return {
    info(message, context) {
      writeLog('info', scope, message, context);
    },
    warn(message, context) {
      writeLog('warn', scope, message, context);
    },
    error(message, context) {
      writeLog('error', scope, message, context);
    },
    debug(message, context) {
      if (!debug) return;
      writeLog('debug', scope, message, context);
    },
  };
}

module.exports = {
  ROOT_LOG_FILE,
  createLogger,
  ensureLogTargets,
  sanitize,
};
