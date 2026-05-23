'use strict';

class EcfError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EcfError';
    this.code = options.code || 'ECF_ERROR';
    this.statusCode = Number(options.statusCode || 500);
    this.details = options.details || null;
    this.cause = options.cause || null;
  }
}

function isEcfError(error) {
  return error instanceof EcfError;
}

function asEcfError(error, fallbackMessage = 'Error interno e-CF.') {
  if (isEcfError(error)) return error;
  return new EcfError(error?.message || fallbackMessage, {
    statusCode: Number(error?.statusCode || 500) || 500,
    cause: error || null,
  });
}

function assertCondition(condition, message, options = {}) {
  if (!condition) {
    throw new EcfError(message, {
      statusCode: options.statusCode || 422,
      code: options.code || 'ECF_VALIDATION_ERROR',
      details: options.details || null,
    });
  }
}

module.exports = {
  EcfError,
  asEcfError,
  assertCondition,
  isEcfError,
};
