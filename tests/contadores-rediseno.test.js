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

describe('recibo de pago (impresora térmica)', () => {
  const factura = {
    ncf: 'B0100000018', total: 4720, monto_pagado: 3000,
    cliente: { nombre: 'SURTIDORA SUAREZ HERRERA', rnc: '133607336' },
    items: [
      { cantidad: 1, descripcion: 'Contabilidad mensual de octubre' }, { cantidad: 2, descripcion: 'Declaración IT-1' },
      { cantidad: 1, descripcion: 'A' }, { cantidad: 1, descripcion: 'B' }, { cantidad: 1, descripcion: 'C' },
      { cantidad: 1, descripcion: 'D' }, { cantidad: 1, descripcion: 'E' }, { cantidad: 1, descripcion: '  ' },
    ],
    pagos: [
      { monto: 2000, metodo: 'transferencia', fecha: '2026-10-20T14:00:00.000Z' },
      { monto: 1000, metodo: 'efectivo', fecha: '2026-10-25T15:30:00.000Z', nota: 'Abono' },
    ],
  };

  test('el último pago, uno anterior y el saldo', () => {
    const { run, ctx } = cargarPortal();
    ctx.__f = factura;
    expect(run('reciboPagoDatos(__f)')).toMatchObject({
      numero: 'B0100000018-02', cliente: 'SURTIDORA SUAREZ HERRERA', total: 4720, anteriores: 2000, monto: 1000,
      saldo: 1720, saldada: false, metodo: 'Efectivo', nota: 'Abono', pagoNumero: 2, pagosTotal: 2,
    });
    expect(run('reciboPagoDatos(__f, 0)')).toMatchObject({ numero: 'B0100000018-01', anteriores: 0, monto: 2000, saldo: 2720, metodo: 'Transferencia' });
    // Por qué paga: lo facturado, hasta 6 líneas (las vacías no cuentan).
    expect(run('reciboPagoDatos(__f).concepto')).toEqual([
      'Contabilidad mensual de octubre', '2 x Declaración IT-1', 'A', 'B', 'C', 'D', 'y 1 más',
    ]);
    expect(run('reciboPagoDatos({ ncf: "B02", total: 100, pagos: [] })')).toBeNull();
  });

  test('una factura marcada pagada sin lista de pagos cuenta como un solo pago y queda saldada', () => {
    const { run } = cargarPortal();
    const d = run("reciboPagoDatos({ ncf: 'B0200000009', total: 14510, monto_pagado: 14510, metodo_pago: 'transferencia', estado: 'pagada', updatedAt: '2026-10-16T12:00:00Z' })");
    expect(d).toMatchObject({ monto: 14510, anteriores: 0, saldo: 0, saldada: true, metodo: 'Transferencia', pagosTotal: 1 });
  });

  test('el recibo trae la firma, el cliente, este pago, el saldo y el ancho del rollo', () => {
    const { run, ctx } = cargarPortal();
    ctx.__f = factura;
    const html80 = run("reciboPagoHtml(reciboPagoDatos(__f), { nombre_firma: 'VICRIS & ASOCIADOS SRL', rnc: '131000000', telefono: '809-000-0000' }, 80)");
    expect(html80).toMatch(/VICRIS &amp; ASOCIADOS SRL/);
    expect(html80).toMatch(/RECIBO DE PAGO/);
    expect(html80).toMatch(/No\. B0100000018-02/);
    expect(html80).toMatch(/SURTIDORA SUAREZ HERRERA/);
    expect(html80).toMatch(/ESTE PAGO<\/span><span>RD\$ 1,000\.00/);
    expect(html80).toMatch(/Pagado antes<\/span><span>2,000\.00/);
    expect(html80).toMatch(/Saldo pendiente<\/span><span>RD\$ 1,720\.00/);
    expect(html80).toMatch(/width: 72mm/);
    const html58 = run("reciboPagoHtml(reciboPagoDatos({ ...__f, monto_pagado: 4720, pagos: [{ monto: 4720, metodo: 'efectivo', fecha: '2026-10-25T15:30:00Z' }] }), {}, 58)");
    expect(html58).toMatch(/FACTURA SALDADA/);
    expect(html58).toMatch(/width: 48mm/);
    expect(html58).toMatch(/size: 58mm auto/);
  });

  test('apagado por defecto; la configuración se guarda en esta computadora', () => {
    const { run, ctx } = cargarPortal();
    expect(run('reciboConfig()')).toEqual({ activo: false, impresora: '', ancho: 80, alCobrar: 'preguntar', copias: 1, logo: true });
    const guardado = {};
    ctx.localStorage.setItem = (k, v) => { guardado[k] = v; };
    ctx.localStorage.getItem = (k) => guardado[k] || null;
    run("_reciboGuardar({ ...reciboConfig(), activo: true, impresora: 'POS-80', ancho: 58 })");
    expect(run('reciboConfig()')).toMatchObject({ activo: true, impresora: 'POS-80', ancho: 58, alCobrar: 'preguntar' });
  });
});

describe('ficha del negocio', () => {
  test('una tarjeta compacta: sin filas vacías, iniciales y contacto con enlace', () => {
    const { run, ctx } = cargarPortal();
    ctx.__c = {
      businessName: 'FARMACIA YAMASA SRL', rnc: '132-83967-6', tipo_negocio: 'farmacia', direccion: 'C/ Maria Matildez Estevez #32 Yamasa',
      razon_social: '', provincia: '', propietario: 'Eduardo Solano', telefono: '809-525-0132', correo: 'farmaciayamasa3@gmail.com',
      status: 'active', planCode: 'standalone', cantidad_sucursales: 1, businessKey: 'pos:tecno-caja-farmacia-yamasa-srl', source: 'pos',
      syncedAt: '2026-10-16', trialStartedAt: '2026-10-06',
    };
    const f = run("_fichaNegocio(__c, 'x')");
    expect(f.iniciales).toBe('FY');
    expect(f.sub).toBe('RNC 132-83967-6 · Farmacia · C/ Maria Matildez Estevez #32 Yamasa');
    const etiquetas = [...f.datos.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(etiquetas).toEqual(['Propietario', 'Teléfono', 'Correo', 'Licencia', 'Cliente desde', 'Estructura', 'Última sincronización']);
    expect(f.datos).toMatch(/href="tel:809-525-0132"/);
    expect(f.datos).toMatch(/href="mailto:farmaciayamasa3@gmail.com"/);
    expect(f.datos).toMatch(/Sin vencimiento/);
    expect(f.datos).toMatch(/1 sucursal</);
    expect(f.datos).not.toMatch(/—/);
    expect(f.pills).toMatch(/Plan Standalone/);
    expect(f.pie).toBe('Clave <code>pos:tecno-caja-farmacia-yamasa-srl</code> · Origen pos');
    expect(f.servicios).toBe('');
  });
});

describe('servicios en el portal (Empresa de Servicios)', () => {
  test('la fila de un servicio: sin costo ni stock, con su unidad, ITBIS y acciones de servicio', () => {
    const { run } = cargarPortal();
    const html = run(`renderFila({ id: 'svc-5', tipo: 'servicio', codigo: 'MANT-01', nombre: 'Mantenimiento <PC>', categoria: 'Soporte',
      precio: 1500, itbisPct: 18, unidad: 'visita', vendidos: 3 }, 'productos')`);
    expect(html).toMatch(/Mantenimiento &lt;PC&gt;/);
    expect(html).toMatch(/pill-info">Servicio/);
    expect(html).toMatch(/\+ 18% ITBIS/);
    expect(html).toMatch(/visita/);
    expect(html).toMatch(/app\.editarServicioReal\('svc-5'\)/);
    expect(html).toMatch(/app\.darDeBajaServicio\('svc-5'\)/);
    expect(run("_idServicio('svc-5')")).toBe(5);
  });

  test('importar CSV: nuevo o se actualiza, sucursal por nombre y lo que va a la cola', () => {
    const { run, ctx } = cargarPortal();
    run(`_repProductosRows = [
      { id: 1, codigo: '0001', nombre: 'Agua', precio: 20, costo: 10, stock: 5, branchId: null, sucursal: '', aplicaItbis: 1, tracksStock: 1 },
      { id: 'svc-3', tipo: 'servicio', codigo: 'MANT-01', nombre: 'Mantenimiento', precio: 1500, itbisPct: 18, unidad: 'visita' },
    ];
    _repNegocioSucursales = [{ id: 7, nombre: 'Norte' }];`);
    ctx.__filas = [
      { fila: 2, campos: ['codigo', 'nombre', 'precioVenta', 'sucursal'], codigo: '0001', nombre: 'Agua', precioVenta: 25, sucursal: '' },
      { fila: 3, campos: ['codigo', 'nombre', 'sucursal'], codigo: '0002', nombre: 'Jugo', sucursal: 'norte' },
      { fila: 4, campos: ['codigo', 'nombre', 'sucursal'], codigo: '0003', nombre: 'Pan', sucursal: 'Sur' },
    ];
    const p = run('_icClasificar(__filas, false)');
    expect(p.filas.map((f) => `${f.codigo} ${f.estado} ${f.branchArchivo} ${f.sucursalMala}`)).toEqual([
      '0001 actualiza null undefined', '0002 nuevo 7 undefined', '0003 nuevo undefined Sur',
    ]);
    ctx.__p = p;
    // Destino elegido en la ventana: todas, una sucursal, o la columna del archivo.
    expect(run("_icItem(__p.filas[1], false, '')").branchId).toBeNull();
    expect(run("_icItem(__p.filas[0], false, '7')").branchId).toBe('7');
    expect(run("_icItem(__p.filas[1], false, 'archivo')")).toMatchObject({ codigo: '0002', branchId: 7, campos: ['codigo', 'nombre', 'sucursal'] });
    // Con "según el archivo" la fila de una sucursal ajena no va; con otro destino sí.
    run("_icLeido = { filas: __p.filas, errores: [], servicios: false }; _repEsServicios = false;");
    ctx.document.getElementById('ic-destino').value = 'archivo';
    const segunArchivo = run('_icFilasValidas()');
    expect(segunArchivo.filas.map((f) => f.codigo)).toEqual(['0001', '0002']);
    expect(segunArchivo.errores).toEqual(['fila 4: la sucursal "Sur" no es de este negocio.']);
    ctx.document.getElementById('ic-destino').value = '';
    expect(run('_icFilasValidas()').filas.map((f) => f.codigo)).toEqual(['0001', '0002', '0003']);

    ctx.__srv = [{ fila: 2, campos: ['nombre', 'precio'], codigo: '', nombre: 'mantenimiento', precio: 1700 }];
    const s = run('_icClasificar(__srv, true)');
    expect(s.filas[0].estado).toBe('actualiza');
    expect(run('_icItem(__srv[0], true)')).toEqual({ fila: 2, campos: ['nombre', 'precio'], codigo: '', nombre: 'mantenimiento', descripcion: undefined, categoria: undefined, unidad: undefined, precioVenta: 1700, itbisPct: undefined });
  });

  test('exportar: las columnas que importa el POS, productos o servicios según el negocio', () => {
    const { run } = cargarPortal();
    run(`_repProductosRows = [
      { id: 1, codigo: '0001', nombre: 'Agua', categoria: 'Bebidas', precio: 20, costo: 10, stock: 5, stockMin: 1, branchId: null, sucursal: '', aplicaItbis: 1, tracksStock: 0 },
      { id: 'svc-3', tipo: 'servicio', codigo: 'MANT-01', nombre: 'Mantenimiento', precio: 1500, itbisPct: 18, unidad: 'visita' },
    ];`);
    run('_repEsServicios = false');
    expect(run('_icRegistrosCatalogo()')).toEqual([{
      codigo: '0001', nombre: 'Agua', sucursal: '', marca: undefined, categoria: 'Bebidas', unidad: undefined, precioCompra: '10.00',
      precioVenta: '20.00', stock: 5, stockMin: 1, estado: 'Activo', aplicaItbis: 'Sí', tracksStock: 'No',
    }]);
    run('_repEsServicios = true');
    expect(run('_icRegistrosCatalogo()').map((r) => [r.codigo, r.precio, r.itbisPct, r.unidad])).toEqual([['MANT-01', '1500.00', 18, 'visita']]);
  });

  test('precio sin ITBIS, como el Catálogo de servicios del POS', () => {
    const { campo, run } = cargarPortal();
    campo('as-precio').value = '1180';
    campo('as-precio-incluye').checked = true;
    run('_asItbis = 18');
    expect(run('_asPrecios()')).toEqual({ precio: 1180, base: 1000, itbis: 180, final: 1180 });
    campo('as-precio-incluye').checked = false;
    expect(run('_asPrecios()')).toEqual({ precio: 1180, base: 1180, itbis: 212.4, final: 1392.4 });
    run('_asItbis = 0');
    expect(run('_asPrecios()').final).toBe(1180);
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

  test('e-NCF: 10 dígitos, vencimiento opcional y una desactivada también bloquea (el POS no repite números)', () => {
    const { run, ctx } = cargarPortal();
    expect(run("_ncfPreviewHtml('E32', 1, 100)"))
      .toBe('Primer e-NCF: <strong>E320000000001</strong> · Último: <strong>E320000000100</strong> · 100 comprobantes');
    expect(run('_ncfOpcionesCliente()')).toMatch(/<optgroup label="Comprobantes electrónicos \(e-NCF\)"><option value="E31">E31 — Factura de Crédito Fiscal Electrónica/);
    expect(run('_ncfOpciones()')).not.toMatch(/E31/); // "Mis secuencias" del contador siguen siendo B
    ctx.__existentes = [{ id: 'ecf-1', documentType: 'E32', status: 'suspendido', startNumber: 1, endNumber: 100 }];
    const v = (o) => { ctx.__o = o; return run('_ncfValidar(Object.assign({}, __o, { existentes: __existentes }))'); };
    expect(v({ tipo: 'E32', desde: 101, hasta: 200, vence: '' })).toEqual({});
    expect(v({ tipo: 'E32', desde: 50, hasta: 150, vence: '' }).hasta).toBe('Se cruza con la secuencia E320000000001–E320000000100.');
    expect(v({ tipo: 'E31', desde: 1, hasta: 10000000000, vence: '' }).hasta).toMatch(/10 dígitos/);
    expect(v({ tipo: 'E31', desde: 1, hasta: 2000000, vence: '' }).hasta).toMatch(/demasiado grande/);
  });

  test('archivo de la DGII: nuevos, ya registrados y los que no se pueden registrar', () => {
    const { run, ctx } = cargarPortal();
    ctx.__leidos = [
      { tipo: 'E32', desde: 1, hasta: 100, referencia: '6005604697', fechaAutorizacion: '2026-10-25' },
      { tipo: 'E31', desde: 1, hasta: 50, referencia: '6005604697', fechaAutorizacion: '2026-10-25' },
      { tipo: 'B02', desde: 1, hasta: 500, referencia: 'X1', fechaAutorizacion: '' },
      { tipo: 'E33', desde: 1, hasta: 10, referencia: '', fechaAutorizacion: '2026-10-25' },
      { tipo: 'E99', desde: 1, hasta: 10, referencia: 'Y', fechaAutorizacion: '2026-10-25' },
      { tipo: 'E34', desde: 1, hasta: 10, referencia: 'Z', fechaAutorizacion: '' },
      { tipo: 'B01', desde: 1, hasta: 100, referencia: 'X2', fechaAutorizacion: '' },
    ];
    ctx.__existentes = [
      // Del espejo del POS: cargada allá (a mano o desde el portal), con lo usado.
      { documentType: 'E31', status: 'activo', startNumber: 1, endNumber: 50, nextNumber: 4 },
      { documentType: 'B02', status: 'pendiente', enCola: true, startNumber: 400, endNumber: 600 },
      { documentType: 'B01', status: 'pendiente', enCola: true, startNumber: 1, endNumber: 100 },
    ];
    const r = run('_anClasificarRangos(__leidos, __existentes, true)');
    expect(r.map((x) => `${x.tipo} ${x.estado}`)).toEqual([
      'E32 nuevo', 'E31 registrado', 'B02 registrado', 'E33 omitido', 'E99 omitido', 'E34 omitido', 'B01 registrado',
    ]);
    expect(r[1].motivo).toBe('Ya está en el POS del negocio · 3 usados, va por el E310000000004.');
    expect(r[2].motivo).toBe('Se cruza con B0200000400–B0200000600, que espera que el POS lo aplique.');
    expect(r[3].motivo).toMatch(/falta el Nº de autorización/);
    expect(r[5].motivo).toMatch(/falta la fecha de autorización/);
    expect(r[6].motivo).toBe('Ya se registró: espera que el POS lo aplique.');
  });

  test('varios archivos: un rango que se cruza con otro del mismo lote no se registra', () => {
    const { run, ctx } = cargarPortal();
    ctx.__leidos = [
      { tipo: 'E32', desde: 1, hasta: 100, referencia: 'A1', fechaAutorizacion: '2026-10-25', archivo: 'a.xml' },
      { tipo: 'E32', desde: 51, hasta: 150, referencia: 'A2', fechaAutorizacion: '2026-10-25', archivo: 'b.xml' },
      { tipo: 'E32', desde: 101, hasta: 200, referencia: 'A3', fechaAutorizacion: '2026-10-25', archivo: 'c.xml' },
    ];
    ctx.__existentes = [];
    const r = run('_anClasificarRangos(__leidos, __existentes, true)');
    expect(r.map((x) => `${x.archivo} ${x.estado}`)).toEqual(['a.xml nuevo', 'b.xml omitido', 'c.xml nuevo']);
    expect(r[1].motivo).toBe('Se cruza con E320000000001–E320000000100 de a.xml.');
  });

  test('Reportes → comprobantes activos: los que se acaban primero, sin agotadas y con lo que falta por aplicar', () => {
    const { run, ctx } = cargarPortal();
    const lejos = ymd(enDias(400));
    ctx.__aplicadas = [
      { id: 'ecf-13', documentType: 'E32', status: 'activo', effectiveStatus: 'activo', startNumber: 1, endNumber: 100, nextNumber: 2, totalAuthorized: 100, totalAvailable: 99 },
      { id: 12, documentType: 'B02', status: 'activo', effectiveStatus: 'proximo_agotarse', startNumber: 1, endNumber: 500, nextNumber: 461, totalAuthorized: 500, totalAvailable: 40, expirationDate: lejos },
      { id: 11, documentType: 'B01', status: 'activo', effectiveStatus: 'agotado', startNumber: 1, endNumber: 50, nextNumber: 51, totalAuthorized: 50, totalAvailable: 0 },
      { id: 10, documentType: 'B14', status: 'suspendido', effectiveStatus: 'suspendido', startNumber: 1, endNumber: 50, nextNumber: 1, totalAuthorized: 50, totalAvailable: 50 },
    ];
    ctx.__pendientes = [
      { id: 'p1', action: 'create', documentType: 'E32', startNumber: 101, endNumber: 200, status: 'pendiente' },
      { id: 'p2', action: 'create', documentType: 'E31', startNumber: 1, endNumber: 10, status: 'aplicado' },
    ];
    const r = run('_comprobantesActivos(__aplicadas, __pendientes)');
    expect(r.activas.map((x) => x.s.documentType)).toEqual(['B02', 'E32']); // B02 se está acabando
    expect(r.enCola.map((n) => n.id)).toEqual(['p1']);
    expect(r.resumen).toBe('2 activas · 1 por agotarse o vencer · 1 por aplicar · 2 agotadas, vencidas o desactivadas');
    ctx.__r = r;
    const html = run('_comprobantesActivosHtml(__r, true)');
    expect(html).toMatch(/E320000000002/);   // próximo e-NCF
    expect(html).toMatch(/Por aplicar/);
    expect(run('_comprobantesActivosHtml(__r, false)')).toMatch(/no le informa al portal sus e-NCF/);
  });

  test('lo usado en el POS y un POS viejo que no informa sus e-NCF', () => {
    const { run, ctx } = cargarPortal();
    ctx.__leidos = [
      { tipo: 'E32', desde: 1, hasta: 100, referencia: '6005604697', fechaAutorizacion: '2026-10-25' },
      { tipo: 'B02', desde: 1, hasta: 500, referencia: 'X1', fechaAutorizacion: '' },
    ];
    ctx.__existentes = [{ documentType: 'E32', status: 'activo', startNumber: 1, endNumber: 100, nextNumber: 101 }];
    expect(run('_anClasificarRangos(__leidos, __existentes, true)[0].motivo')).toBe('Ya está en el POS del negocio · ya se usó completo.');

    // POS sin ncfEspejoVersion 2: no se sabe qué E tiene y tampoco los aplicaría.
    ctx.__existentes = [];
    const viejo = run('_anClasificarRangos(__leidos, __existentes, false)');
    expect(viejo.map((x) => `${x.tipo} ${x.estado}`)).toEqual(['E32 sin_confirmar', 'B02 nuevo']);
    expect(run('_posInformaEcf({ ncfEspejoVersion: 2 })')).toBe(true);
    expect(run('_posInformaEcf({})')).toBe(false);
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

describe('Configuración: cada sección en su pestaña', () => {
  const html = fs.readFileSync(path.join(PORTAL, 'index.html'), 'utf8');
  const panel = (s) => {
    const inicio = html.indexOf(`data-cfg-panel="${s}"`);
    return inicio < 0 ? '' : html.slice(inicio, html.indexOf('</section>', inicio));
  };

  test('cada botón del menú tiene su sección, con lo que le toca adentro', () => {
    const botones = [...html.matchAll(/data-cfg="([a-z]+)"/g)].map((m) => m[1]);
    expect(botones).toEqual(['firma', 'factura', 'recibo', 'correo', 'apariencia', 'ia']);
    const contenido = {
      firma: ['id="cfg-nombre-firma"', 'id="cfg-rnc"', 'id="cfg-whatsapp"', 'id="cfg-logo-file"', 'id="cfg-logo"'],
      factura: ['id="cfg-invoice-design"', 'id="cfg-invoice-templates"'],
      recibo: ['id="cfg-recibo"', 'id="cfg-recibo-impresora"', 'id="cfg-recibo-logo"'],
      correo: ['id="cfg-correo-card"', 'id="cfg-email-user"'],
      apariencia: ['id="cfg-apariencia"', 'data-tema="dia"', 'data-tamano="grande"'],
      ia: ['id="cfg-ia-card"', 'id="cfg-ia-key"'],
    };
    for (const [s, ids] of Object.entries(contenido)) {
      for (const id of ids) expect(`${s}: ${panel(s).includes(id)}`).toBe(`${s}: true`);
    }
    // Una sola sección se ve al abrir: las demás empiezan ocultas.
    expect([...html.matchAll(/data-cfg-panel="([a-z]+)"[^>]*>/g)].filter((m) => !/\shidden/.test(m[0])).map((m) => m[1])).toEqual(['firma']);
  });

  function conMenu() {
    const portal = cargarPortal();
    const botones = ['firma', 'factura', 'recibo', 'correo', 'apariencia', 'ia'].map((s) => ({
      dataset: { cfg: s }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    }));
    const paneles = botones.map((b) => ({ dataset: { cfgPanel: b.dataset.cfg }, hidden: false }));
    portal.ctx.document.querySelectorAll = (sel) => (sel === '[data-cfg]' ? botones : sel === '[data-cfg-panel]' ? paneles : []);
    portal.campo('cfg-nav-ia').style.display = 'none'; // asistente desactivado
    portal.campo('main-content').scrollTo = () => {};
    const visibles = () => paneles.filter((p) => !p.hidden).map((p) => p.dataset.cfgPanel);
    return { ...portal, visibles };
  }

  test('cfgIr muestra una sola sección y "Guardar cambios" solo donde hace falta', () => {
    const { run, campo, visibles } = conMenu();
    run("cfgIr('recibo')");
    expect(visibles()).toEqual(['recibo']);
    expect(campo('cfg-btn-guardar').style.display).toBe('none');
    expect(campo('cfg-sub').textContent).toMatch(/impresora térmica/);
    run("cfgIr('factura')");
    expect(visibles()).toEqual(['factura']);
    expect(campo('cfg-btn-guardar').style.display).toBe('');
    // Sin sección vuelve a la última; la del asistente (oculta) no se abre.
    run('cfgIr()');
    expect(visibles()).toEqual(['factura']);
    run("cfgIr('ia')");
    expect(visibles()).toEqual(['firma']);
  });
});
