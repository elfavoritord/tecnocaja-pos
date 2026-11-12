'use strict';

const fs = require('fs');
const { createPrintWindowPool } = require('../electron/print-window-pool');
const tick = () => new Promise(setImmediate);

function pool(options = {}) {
  const windows = [];
  const createWindow = jest.fn(() => {
    const w = { destroyed: false, documents: [], setContentSize: jest.fn(),
      isDestroyed() { return this.destroyed; }, destroy: jest.fn(function () { this.destroyed = true; }),
      async loadFile(file) { this.documents.push(await fs.promises.readFile(file, 'utf8')); },
    };
    windows.push(w); return w;
  });
  return { windows, createWindow, pool: createPrintWindowPool({ createWindow, ...options }) };
}

describe('ventanas reutilizables para todos los documentos y etiquetas', () => {
  const instances = [];
  const make = (options) => { const p = pool(options); instances.push(p); return p; };
  const layout = { previewWidth: 420, previewHeight: 900 };
  afterEach(() => { for (const p of instances.splice(0)) p.pool.close(); });

  test('recibo, cierre y etiqueta reutilizan ventana sin conservar contenido anterior', async () => {
    const p = make();
    for (const html of ['recibo con QR', 'cierre', 'etiqueta']) {
      expect(await p.pool.run('Impresora', layout, html, async () => ({ ok: true }))).toEqual({ ok: true });
    }
    expect(p.windows).toHaveLength(1);
    expect(p.windows[0].documents).toEqual(['recibo con QR', 'cierre', 'etiqueta']);
    expect(p.createWindow.mock.calls[0][0].webPreferences.backgroundThrottling).toBe(false);
  });

  test('no reemplaza un documento mientras su impresión esté pendiente y otra impresora avanza', async () => {
    const p = make();
    let finish;
    const started = [];
    let ready;
    const firstReady = new Promise((resolve) => { ready = resolve; });
    const first = p.pool.run('A', layout, 'uno', () => new Promise((resolve) => { started.push('uno'); finish = resolve; ready(); }));
    await firstReady;
    const second = p.pool.run('A', layout, 'dos', async () => { started.push('dos'); });
    await p.pool.run('B', layout, 'otra', async () => { started.push('otra'); });
    expect(started).toEqual(['uno', 'otra']);
    expect(p.windows[0].documents).toEqual(['uno']);
    finish({ ok: true });
    await Promise.all([first, second]);
    expect(started).toEqual(['uno', 'otra', 'dos']);
  });

  test('una ventana rota se descarta y el próximo trabajo se recupera', async () => {
    const p = make();
    await expect(p.pool.run('A', layout, 'uno', async () => { throw new Error('renderer cerrado'); })).rejects.toThrow('renderer cerrado');
    expect(p.windows[0].destroyed).toBe(true);
    await p.pool.run('A', layout, 'dos', async () => ({ ok: true }));
    expect(p.windows).toHaveLength(2);
  });

  test('limita ventanas inactivas y las libera al cerrar la principal', async () => {
    const p = make({ maxIdle: 1 });
    await p.pool.run('A', layout, 'uno', async () => {});
    await p.pool.run('B', layout, 'dos', async () => {});
    expect(p.windows[0].destroyed).toBe(true);
    p.pool.clear();
    expect(p.windows[1].destroyed).toBe(true);
    // Puede volver a activarse la app sin perder la impresión.
    await p.pool.run('B', layout, 'tres', async () => {});
    await tick();
    expect(p.windows).toHaveLength(3);
  });
});
