'use strict';
// Paso 3 en la pantalla: cuando el Excel trae e-NCF que esta PC no tiene aceptados,
// el asistente pregunta "¿Enviar las 11 aprobaciones igual?". Hasta la 1.6.32, al
// decir que sí no se enviaba nada: el reintento quedaba después de un `return`
// dentro del try (2026-11-17, "el Paso 3 solo compara los datos pero no lo envía").
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FUENTE = fs.readFileSync(path.join(__dirname, '..', 'js', 'ecf-cert-wizard.js'), 'utf8');

function cargarRunStep3({ respuestas, aceptar }) {
  const inicio = FUENTE.indexOf('  async function runStep3(');
  const fin = FUENTE.indexOf('  async function _confirmStep3(');
  if (inicio < 0 || fin < 0) throw new Error('no encontré runStep3 en ecf-cert-wizard.js');
  const llamadas = [];
  const preguntas = [];
  const avisos = [];
  const elementos = {
    'ecf-wz-step3-file': { files: [{ name: '131880681-16112026123706.xlsx' }] },
    'ecf-wz-step3-result': { style: {}, innerHTML: '' },
    'ecf-wz-step3-status': { innerHTML: '' },
  };
  class FormDataFalso {
    constructor() { this.campos = []; }
    append(k, v) { this.campos.push([k, v]); }
    tiene(k) { return this.campos.some(([c]) => c === k); }
  }
  const ctx = vm.createContext({
    FormData: FormDataFalso,
    document: { getElementById: (id) => elementos[id] || null },
    WZ: { state: { environment: 'certecf', steps: {} } },
    h: (s) => String(s ?? ''),
    setBtnState: () => {},
    saveState: async () => {},
    showFiscalToast: (texto, tipo) => avisos.push({ texto, tipo }),
    confirm: (texto) => { preguntas.push(texto); return aceptar; },
    fiscalApi: async (metodo, ruta, form) => {
      const confirmado = form.tiene('confirmarFueraDeLote');
      llamadas.push({ ruta, confirmado });
      const r = respuestas[llamadas.length - 1];
      if (r instanceof Error) throw r;
      return r;
    },
  });
  vm.runInContext(`${FUENTE.slice(inicio, fin)}\nthis.runStep3 = runStep3;`, ctx);
  return { runStep3: ctx.runStep3, llamadas, preguntas, avisos, elementos };
}

const fueraDeLote = Object.assign(new Error('Estos e-NCF del Excel no aparecen aceptados en esta PC: E310000000001'), {
  details: { code: 'ACECF_FUERA_DE_LOTE', faltan: ['E310000000001'] },
});
const once = { ok: true, accepted: 11, total: 11, results: [], message: '11/11 Aprobaciones Comerciales enviadas correctamente.' };

test('al decir que sí, envía las aprobaciones (segunda llamada con la confirmación)', async () => {
  const p = cargarRunStep3({ respuestas: [fueraDeLote, once], aceptar: true });
  await p.runStep3();
  expect(p.preguntas).toHaveLength(1);
  expect(p.llamadas).toEqual([
    { ruta: '/certification/aprobacion-comercial/process', confirmado: false },
    { ruta: '/certification/aprobacion-comercial/process', confirmado: true },
  ]);
  expect(p.elementos['ecf-wz-step3-status'].innerHTML).toMatch(/11\/11/);
  expect(p.avisos.filter((a) => a.tipo === 'error')).toEqual([]);
});

test('al decir que no, no envía nada ni muestra error', async () => {
  const p = cargarRunStep3({ respuestas: [fueraDeLote], aceptar: false });
  await p.runStep3();
  expect(p.llamadas).toHaveLength(1);
  expect(p.avisos).toEqual([]);
});

test('sin e-NCF de otro lote envía a la primera, sin preguntar', async () => {
  const p = cargarRunStep3({ respuestas: [once], aceptar: true });
  await p.runStep3();
  expect(p.preguntas).toHaveLength(0);
  expect(p.llamadas).toHaveLength(1);
});
