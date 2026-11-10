'use strict';
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');
function ask(worker, action, payload) {
  return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage({ id: 1, action, payload: { ...payload, allowNetwork: false } }); });
}
test('consulta un catálogo antiguo sin intentar actualizarlo por internet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rnc-offline-'));
  const dataPath = path.join(dir, 'rnc.txt');
  fs.writeFileSync(dataPath, '123456789|EMPRESA LOCAL|COMERCIO|GENERAL||||||ORDINARIO|ACTIVO', 'latin1');
  const yesterday = new Date(Date.now() - 86400000); fs.utimesSync(dataPath, yesterday, yesterday);
  const worker = new Worker(path.resolve(__dirname, '../../server/routes/rnc-worker.js'), { env: { ...process.env, DGII_RNC_DATA_PATH: dataPath } });
  try {
    const result = await ask(worker, 'lookup', { raw: '123456789', candidates: ['123456789'] });
    expect(result.ok).toBe(true); expect(result.result.nombre).toBe('EMPRESA LOCAL');
    expect(fs.statSync(dataPath).mtimeMs).toBeCloseTo(yesterday.getTime(), -1);
  } finally { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20000);
test('si falta el catálogo responde para captura manual sin esperar una descarga', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rnc-offline-'));
  const worker = new Worker(path.resolve(__dirname, '../../server/routes/rnc-worker.js'), { env: { ...process.env, DGII_RNC_DATA_PATH: path.join(dir, 'ausente.txt') } });
  try {
    const result = await ask(worker, 'lookup', { raw: '123456789', candidates: ['123456789'] });
    expect(result.ok).toBe(false); expect(result.error).toMatch(/manualmente/);
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 20000);
