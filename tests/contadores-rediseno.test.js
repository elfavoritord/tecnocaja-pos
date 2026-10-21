'use strict';
/**
 * Portal de contadores — diseño 2026 (Dashboard, menú, modal "Nuevo producto").
 * - public/js/iconos.js es copia exacta del POS (vendor-sync).
 * - Cada emoji que sin-emojis.js cambia por ícono apunta a un ícono que existe.
 * - Cálculos del Dashboard y del modal de producto (contadores-app.js se carga
 *   en un contexto aparte con un document mínimo).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const PORTAL = path.join(RAIZ, 'tecno-caja-contadores', 'public');

test('iconos.js del portal es igual al del POS (correr: node tecno-caja-contadores/scripts/vendor-sync.js)', () => {
  const copia = fs.readFileSync(path.join(PORTAL, 'js', 'iconos.js'), 'utf8');
  const original = fs.readFileSync(path.join(RAIZ, 'js', 'iconos.js'), 'utf8');
  expect(copia).toBe(original);
});

test('cada emoji de sin-emojis.js tiene su ícono en iconos.js', () => {
  const ventana = {};
  vm.runInNewContext(fs.readFileSync(path.join(PORTAL, 'js', 'iconos.js'), 'utf8'), { window: ventana });
  const fuente = fs.readFileSync(path.join(PORTAL, 'js', 'sin-emojis.js'), 'utf8');
  const inicio = fuente.indexOf('const ICON = {');
  const mapa = fuente.slice(inicio, fuente.indexOf('};', inicio));
  const nombres = [...mapa.matchAll(/:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  expect(nombres.length).toBeGreaterThan(50);
  expect(nombres.filter((n) => !ventana.TcIconos.paths[n])).toEqual([]);
});

// ── contadores-app.js en un contexto con un document mínimo ────────────────
function cargarPortal() {
  const campos = {};
  const campo = (id) => {
    if (!campos[id]) {
      campos[id] = {
        id, value: '', checked: false, textContent: '', className: '', style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, focus() {},
      };
    }
    return campos[id];
  };
  const ctx = {
    console,
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: campo,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PORTAL, 'js', 'contadores-app.js'), 'utf8'), ctx);
  return { ctx, campo, run: (code) => vm.runInContext(code, ctx) };
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function enDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

describe('modal Nuevo producto: precio que se guarda (sin ITBIS, como el POS)', () => {
  test('18 % con "el precio ya incluye ITBIS": 25.00 → 21.19 + 3.81', () => {
    const { campo, run } = cargarPortal();
    campo('ap-precio-venta').value = '25';
    campo('ap-precio-compra').value = '15';
    campo('ap-precio-incluye').checked = true;
    run("_apItbis = 'porcentaje'");
    const p = run('_apPrecios()');
    expect(p.base).toBe(21.19);
    expect(p.itbis).toBe(3.81);
    expect(p.final).toBe(25);
  });

  test('18 % sin marcar la casilla: el precio escrito es el de venta y el ITBIS va encima', () => {
    const { campo, run } = cargarPortal();
    campo('ap-precio-venta').value = '25';
    run("_apItbis = 'porcentaje'");
    const p = run('_apPrecios()');
    expect(p.base).toBe(25);
    expect(p.final).toBe(29.5);
  });

  test('exento ignora la casilla; monto fijo resta el ITBIS fijo', () => {
    const { campo, run } = cargarPortal();
    campo('ap-precio-venta').value = '25';
    campo('ap-precio-incluye').checked = true;
    run("_apItbis = 'exento'");
    expect(run('_apPrecios()').base).toBe(25);
    campo('ap-itbis-monto').value = '3.81';
    run("_apItbis = 'monto'");
    const p = run('_apPrecios()');
    expect(p.base).toBe(21.19);
    expect(p.itbis).toBe(3.81);
  });

  test('"Generar" usa el siguiente código corto libre', () => {
    const { campo, run } = cargarPortal();
    run(`_repProductosRows = [{ codigo: '0001' }, { codigo: '0007' }, { codigo: '7501234567890' }];
         _productosPendientes = [{ codigo: '0008' }];
         generarCodigoProducto();`);
    expect(campo('ap-codigo').value).toBe('0009');
  });
});

describe('Secuencias NCF', () => {
  test('vista previa del rango', () => {
    const { run } = cargarPortal();
    expect(run("_ncfPreviewHtml('B02', 1, 500)"))
      .toBe('Primer NCF: <strong>B0200000001</strong> · Último: <strong>B0200000500</strong> · 500 comprobantes');
    expect(run("_ncfPreviewHtml('B02', 5, 5)")).toMatch(/Escribe el número inicial/);
  });

  test('validaciones: final mayor, fecha no vencida y sin choque con otra del mismo tipo', () => {
    const { run, ctx } = cargarPortal();
    const manana = ymd(enDias(1));
    const ayer = ymd(enDias(-1));
    ctx.__existentes = [
      { id: 'a', documentType: 'B02', status: 'activo', startNumber: 1, endNumber: 100 },
      { id: 'b', documentType: 'B02', status: 'suspendido', startNumber: 200, endNumber: 300 },
      { id: 'c', documentType: 'B01', status: 'activo', startNumber: 1, endNumber: 100 },
    ];
    const v = (o) => { ctx.__o = o; return run('_ncfValidar(Object.assign({}, __o, { existentes: __existentes }))'); };
    expect(v({ tipo: 'B02', desde: 101, hasta: 100, vence: manana })).toEqual({ hasta: 'El número final debe ser mayor que el inicial.' });
    expect(v({ tipo: 'B02', desde: 101, hasta: 150, vence: ayer }).vence).toMatch(/ya pasó/);
    expect(v({ tipo: 'B02', desde: 101, hasta: 150, vence: '' }).vence).toMatch(/fecha de vencimiento/);
    expect(v({ tipo: 'B04', desde: 1, hasta: 10, vence: '' })).toEqual({});           // B04 no vence
    expect(v({ tipo: 'B02', desde: 50, hasta: 150, vence: manana }).hasta).toBe('Se cruza con la secuencia B0200000001–B0200000100.');
    expect(v({ tipo: 'B02', desde: 250, hasta: 260, vence: manana })).toEqual({});    // la suspendida no bloquea
    expect(v({ tipo: 'B02', desde: 101, hasta: 150, vence: manana })).toEqual({});    // B01 1–100 es otro tipo
  });

  test('estado: activa, por agotarse (<10%), por vencer (<30 días), vencida y desactivada', () => {
    const { run, ctx } = cargarPortal();
    ctx.__s = [
      { status: 'activo', effectiveStatus: 'activo', startNumber: 1, endNumber: 500, nextNumber: 6, totalAuthorized: 500, totalAvailable: 495, expirationDate: ymd(enDias(400)) },
      { status: 'activo', effectiveStatus: 'activo', startNumber: 1, endNumber: 100, nextNumber: 95, totalAuthorized: 100, totalAvailable: 6, expirationDate: ymd(enDias(400)) },
      { status: 'activo', effectiveStatus: 'activo', startNumber: 1, endNumber: 100, nextNumber: 2, totalAuthorized: 100, totalAvailable: 99, expirationDate: ymd(enDias(10)) },
      { status: 'activo', effectiveStatus: 'vencido', startNumber: 1, endNumber: 100, nextNumber: 2, totalAuthorized: 100, totalAvailable: 99, expirationDate: ymd(enDias(-3)) },
      { status: 'suspendido', effectiveStatus: 'suspendido', startNumber: 1, endNumber: 100, nextNumber: 2, totalAuthorized: 100, totalAvailable: 99 },
    ];
    const e = run('__s.map(_ncfEstado)');
    expect(e.map(x => x.etiqueta)).toEqual(['Activa', 'Por agotarse', 'Por vencer', 'Vencida', 'Desactivada']);
    expect(e[1].alertas[0]).toBe('Quedan solo 6 comprobantes (6%).');
    expect(e[2].alertas[0]).toBe('Vence en 10 días.');
  });
});

describe('Factura y cotización: totales', () => {
  test('base gravada, exento, descuentos e ITBIS como el servidor', () => {
    const { run } = cargarPortal();
    const t = run(`_docTotales([
      { descripcion: 'Contabilidad mensual', cantidad: 1, precio: 5000, descuento: 0, itbis_rate: 18 },
      { descripcion: 'IT-1', cantidad: 1, precio: 500, descuento: 10, itbis_rate: 18 },
      { descripcion: 'Trámite exento', cantidad: 2, precio: 250, descuento: 0, itbis_rate: 0 },
    ])`);
    expect(t).toEqual({ subtotal: 6000, descuentos: 50, gravada: 5450, exento: 500, itbis: 981, total: 6931 });
    expect(run(`_docImporte({ cantidad: 1, precio: 500, descuento: 10 })`)).toBe(450);
  });

  test('las líneas vacías no se mandan', () => {
    const { run } = cargarPortal();
    expect(run(`_docItemsUtiles([{ descripcion: '', precio: 0 }, { descripcion: 'IT-1', precio: 500 }]).length`)).toBe(1);
  });
});

describe('Dashboard', () => {
  test('calendario: agrupa por fecha y el IT-1 es del mes anterior', () => {
    const { run, ctx } = cargarPortal();
    const hoy = enDias(0);
    const en5 = enDias(5);
    ctx.__lista = [
      { fecha: ymd(hoy), form: 'IT-1', desc: 'ITBIS — mes de X', mes: hoy.getMonth() + 1 },
      { fecha: ymd(en5), form: '606', desc: '606 Compras (Trim. 3 Jul-Sep)', mes: en5.getMonth() + 1 },
      { fecha: ymd(en5), form: '607', desc: '607 Ventas NCF (Trim. 3 Jul-Sep)', mes: en5.getMonth() + 1 },
      { fecha: ymd(enDias(-1)), form: 'TSS', desc: 'TSS Seguridad Social', mes: 1 },
      { fecha: ymd(enDias(40)), form: 'TSS', desc: 'TSS Seguridad Social', mes: 1 },
    ];
    const grupos = run('_oblProximas(__lista, 30)');
    expect(grupos).toHaveLength(2);
    const mesAnterior = run('_MESES')[(hoy.getMonth() + 11) % 12];
    expect(grupos[0].dias).toBe(0);
    expect(grupos[0].titulo).toBe(`IT-1 · ITBIS de ${mesAnterior}`);
    expect(grupos[1].dias).toBe(5);
    expect(grupos[1].titulo).toBe('606 · 607');
    expect(grupos[1].multiple).toBe(true);
  });

  test('salud de cada negocio según licencia y última sincronización', () => {
    const { run, ctx } = cargarPortal();
    const hace = (dias) => enDias(-dias).toISOString();
    ctx.__c = [
      { status: 'expired', diasRestantes: -12, syncedAt: hace(12) },
      { status: 'trial', diasRestantes: 9, syncedAt: hace(0) },
      { status: 'active', diasRestantes: 200, syncedAt: hace(4) },
      { status: 'active', diasRestantes: 200, syncedAt: hace(1) },
      { status: 'active', diasRestantes: null, syncedAt: null },
    ];
    const s = run('__c.map(_saludNegocio)');
    expect(s[0]).toMatchObject({ nivel: 'bad', pendiente: 'Licencia vencida' });
    expect(s[0].motivos).toHaveLength(2);
    expect(s[1]).toMatchObject({ nivel: 'warn', pendiente: 'Licencia vence en 9 días' });
    expect(s[2]).toMatchObject({ nivel: 'warn', pendiente: 'Sin sincronizar hace 4 días' });
    expect(s[3]).toMatchObject({ nivel: 'ok', pendiente: 'Al día', diasSync: 1 });
    expect(s[4]).toMatchObject({ nivel: 'bad', pendiente: 'Nunca ha sincronizado' });
  });

  test('el B01 exige el RNC o la cédula del cliente', () => {
    const { run, campo } = cargarPortal();
    run(`_misNcf = [{ id: 's1', documentType: 'B01', status: 'activo', effectiveStatus: 'activo', startNumber: 1, endNumber: 50, nextNumber: 3, totalAvailable: 48 }];
         _nfTipo = 'B01';
         _facItems = [{ descripcion: 'Contabilidad mensual', cantidad: 1, precio: 5000, descuento: 0, itbis_rate: 18 }];`);
    campo('nf-cli-nombre').value = 'Ferretería Pérez';
    campo('nf-fecha').value = '2026-10-20';
    let p = run('_nfProblemas()');
    expect(p.map(x => x.pie || x.msg)).toContain('Falta el RNC del cliente para emitir un B01.');
    campo('nf-cli-rnc').value = '1-31-88068-1';
    p = run('_nfProblemas()');
    expect(p).toEqual([]);
    campo('nf-cli-rnc').value = '12345';
    expect(run('_nfProblemas()')[0].msg).toBe('El RNC tiene 9 dígitos y la cédula 11.');
  });

  test('iniciales del menú', () => {
    const { run } = cargarPortal();
    expect(run("_iniciales('Emilio Manaurys Cabrera')")).toBe('EM');
    expect(run("_iniciales('Firma de Contadores SRL')")).toBe('FC');
    expect(run("_iniciales('')")).toBe('?');
  });
});
