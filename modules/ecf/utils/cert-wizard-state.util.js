'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function isWizardState(state) {
  return Boolean(state && typeof state === 'object' && !Array.isArray(state)
    && Number.isInteger(state.currentStep) && state.currentStep >= 1 && state.currentStep <= 15
    && Array.isArray(state.completedSteps)
    && state.completedSteps.every((id) => Number.isInteger(id) && id >= 1 && id <= 15));
}

function readJson(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return isWizardState(state) ? state : null;
  } catch (_) { return null; }
}

function atomicWrite(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function writeWizardState(file, state) {
  if (!isWizardState(state)) throw new Error('El avance de certificación no tiene un paso o una lista de pasos válidos.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const previous = readJson(file);
  if (previous || !readJson(`${file}.bak`)) atomicWrite(`${file}.bak`, previous || state);
  atomicWrite(file, state);
}

function readWizardState(file, legacyFiles = []) {
  for (const candidate of [...new Set([file, `${file}.bak`, ...legacyFiles])]) {
    const state = readJson(candidate);
    if (!state) continue;
    if (candidate !== file) {
      // Recuperar en la ruta permanente sin cambiar ni aprobar ningún paso.
      try { writeWizardState(file, state); } catch (_) { /* Permite consultar el avance aunque el disco no sea escribible. */ }
    }
    return state;
  }
  return null;
}

module.exports = { isWizardState, readWizardState, writeWizardState };
