'use strict';

// Prueba estática de cableado del wizard de certificación DGII (15 pasos).
// No usa DOM/Electron (el wizard es JS vanilla inyectado en HTML) — lee el
// código fuente como texto y verifica los invariantes que el bug del Paso 11
// violó: cada paso debe usar su propio número en stepHeader()/isCompleted(),
// y ningún renderer puede reutilizarse entre dos pasos distintos.

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', 'js', 'ecf-cert-wizard.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractRenderersEntries() {
  const match = source.match(/const renderers = \[([\s\S]*?)\n\s*\];/);
  if (!match) throw new Error('No se encontró el arreglo renderers[] en ecf-cert-wizard.js');
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const nameMatch = line.match(/^(\w+)\s*,/);
      if (!nameMatch || nameMatch[1] === 'null') return null;
      return nameMatch[1];
    });
}

function extractFunctionBody(name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const startMatch = source.match(re);
  if (!startMatch) return null;
  const braceStart = source.indexOf('{', startMatch.index);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return null;
}

describe('ecf-cert-wizard.js — cableado de los 15 pasos', () => {
  const entries = extractRenderersEntries();

  test('el arreglo renderers[] tiene el null inicial + exactamente 15 pasos', () => {
    expect(entries[0]).toBeNull();
    expect(entries.length).toBe(16);
    for (let stepId = 1; stepId <= 15; stepId++) {
      expect(entries[stepId]).not.toBeNull();
    }
  });

  test('ninguna función de render se reutiliza entre dos pasos distintos', () => {
    const names = entries.slice(1).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });

  for (let stepId = 1; stepId <= 15; stepId++) {
    test(`Paso ${stepId}: su render usa stepHeader(${stepId})/isCompleted(${stepId}) — no los de otro paso`, () => {
      const fnName = entries[stepId];
      expect(fnName).toBeTruthy();

      const body = extractFunctionBody(fnName);
      expect(body).not.toBeNull();

      const headerCalls = [...body.matchAll(/stepHeader\((\d+)/g)].map((m) => Number(m[1]));
      const completedCalls = [...body.matchAll(/isCompleted\((\d+)/g)].map((m) => Number(m[1]));

      expect(headerCalls.length).toBeGreaterThan(0);
      for (const n of headerCalls) expect(n).toBe(stepId);
      for (const n of completedCalls) expect(n).toBe(stepId);
    });
  }
});
