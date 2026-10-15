'use strict';

/**
 * Factura del portal de contadores con las plantillas A4 del POS:
 * - tecno-caja-contadores/public/js/factura-plantillas.js es copia exacta de
 *   js/factura-plantillas.js (la hace tecno-caja-contadores/scripts/vendor-sync.js).
 * - tecno-caja-contadores/public/js/factura-contador.js arma los datos.
 * - El selector de Configuración funciona en el portal (sin papel) y en el POS.
 */

const fs = require('fs');
const path = require('path');

const FacturaPlantillas = require('../js/factura-plantillas.js');
const FacturaContador = require('../tecno-caja-contadores/public/js/factura-contador.js');

const PLANTILLAS = FacturaPlantillas.PLANTILLAS.map((p) => p.id);

// Factura como la devuelve GET /api/facturacion/facturas/:id
function factura(overrides = {}) {
  return {
    ncf: 'B0100000045', tipo_ncf: 'B01', tipo_ncf_label: 'Crédito Fiscal',
    ncf_vencimiento: '2027-12-31',
    fecha: '2026-10-14',
    cliente: {
      nombre: 'Ferretería El Clavo, SRL', rnc: '131-22222-3', direccion: 'Av. Duarte 10',
      telefono: '809-555-0000', correo: 'pagos@elclavo.do',
    },
    items: [
      { descripcion: 'Contabilidad mensual', cantidad: 1, precio: 10000, descuento: 10, itbis_rate: 18, itbis: 1620, total: 10620 },
      { descripcion: 'Asesoría fiscal', cantidad: 2, precio: 1500, descuento: 0, itbis_rate: 0, itbis: 0, total: 3000 },
    ],
    subtotal: 13000, descuento_total: 1000, itbis_total: 1620, total: 13620,
    monto_pagado: 0, balance: 13620,
    condicion_pago: 'credito', metodo_pago: 'transferencia',
    observacion: 'Pagar antes del día 15.',
    estado: 'pendiente',
    contador_nombre: 'Pérez & Asociados', contador_rnc: '101-00000-1',
    contador_direccion: 'Calle Las Flores 5, Santiago',
    contador_tel: '809-555-1111', contador_correo: 'firma@perez.do', contador_logo: null,
    ...overrides,
  };
}

describe('copia de las plantillas en el portal', () => {
  test('es idéntica a la del POS (correr: node tecno-caja-contadores/scripts/vendor-sync.js)', () => {
    const pos = fs.readFileSync(path.join(__dirname, '..', 'js', 'factura-plantillas.js'), 'utf8');
    const portal = fs.readFileSync(path.join(__dirname, '..', 'tecno-caja-contadores', 'public', 'js', 'factura-plantillas.js'), 'utf8');
    expect(portal).toBe(pos);
  });
});

describe('FacturaContador.aDocumento', () => {
  test('emisor, cliente, NCF y fechas', () => {
    const d = FacturaContador.aDocumento(factura());
    expect(d.empresa).toEqual({
      nombre: 'Pérez & Asociados', rnc: '101-00000-1', direccion: 'Calle Las Flores 5, Santiago',
      telefono: '809-555-1111', correo: 'firma@perez.do', logo: '',
    });
    expect(d.cliente).toEqual({
      nombre: 'Ferretería El Clavo, SRL', rnc: '131-22222-3', tel: '809-555-0000',
      dir: 'Av. Duarte 10', correo: 'pagos@elclavo.do',
    });
    expect(d.numero).toBe('');
    expect(d.ncf).toBe('B01-00000045');
    expect(d.ncfTipoLabel).toBe('B01 — Crédito Fiscal');
    expect(d.fechaTexto).toBe('14 de octubre de 2026');
    expect(d.vencimientoTexto).toBe('31 de diciembre de 2027');
    expect(d.condicionPago).toBe('Crédito');
    expect(d.metodoPago).toBe('Transferencia');
    expect(d.notas).toBe('Pagar antes del día 15.');
  });

  test('importe = cantidad × precio y el descuento va como nota; los totales son los de la factura', () => {
    const d = FacturaContador.aDocumento(factura());
    expect(d.items[0]).toMatchObject({ total: 10000, itbisPct: 18, itbisMonto: 1620 });
    expect(d.items[0].nota).toMatch(/^Descuento 10% \(- RD\$\s1,000\.00\)$/);
    expect(d.items[1]).toMatchObject({ total: 3000, itbisPct: 0, nota: '' });
    expect(d.items.reduce((a, it) => a + it.total, 0)).toBe(d.subtotal);
    expect(d.subtotal - d.descuento + d.itbis).toBe(d.total);
  });

  test.each([
    ['pendiente', 'PENDIENTE DE PAGO', 'warn'],
    ['parcial', 'PAGO PARCIAL', 'warn'],
    ['pagada', 'PAGADA', 'ok'],
    ['anulada', 'ANULADA', 'bad'],
  ])('estado %s', (estado, etiqueta, sello) => {
    const d = FacturaContador.aDocumento(factura({ estado }));
    expect(d.estadoLabel).toBe(etiqueta);
    expect(d.selloClase).toBe(sello);
    expect(d.anulada).toBe(estado === 'anulada');
  });

  test('las facturas viejas sin dirección del emisor usan la del perfil', () => {
    const vieja = factura();
    delete vieja.contador_direccion;
    expect(FacturaContador.aDocumento(vieja, { direccion: 'Av. Perfil 1' }).empresa.direccion).toBe('Av. Perfil 1');
    // Si la factura la trae (aunque sea vacía), manda la factura.
    expect(FacturaContador.aDocumento(factura({ contador_direccion: '' }), { direccion: 'Av. Perfil 1' }).empresa.direccion).toBe('');
  });

  test('notas de crédito y débito llevan su título', () => {
    expect(FacturaContador.aDocumento(factura({ tipo_ncf: 'B04' })).titulo).toBe('NOTA DE CRÉDITO');
    expect(FacturaContador.aDocumento(factura({ tipo_ncf: 'B03' })).titulo).toBe('NOTA DE DÉBITO');
    expect(FacturaContador.aDocumento(factura()).titulo).toBe('');
  });
});

describe('FacturaContador.documentoHtml', () => {
  test.each(PLANTILLAS)('plantilla %s: datos de la factura, correos y sin "No." vacío', (plantilla) => {
    const html = FacturaContador.documentoHtml(factura(), { factura_plantilla: plantilla });
    expect(html).toContain(`tcf-tpl-${plantilla}`);
    expect(html).toContain('Pérez &amp; Asociados');
    expect(html).toContain('B01-00000045');
    expect(html).toContain('firma@perez.do');
    expect(html).toContain('pagos@elclavo.do');
    expect(html).toContain('Calle Las Flores 5, Santiago');
    expect(html).toContain('Contabilidad mensual');
    expect(html).toMatch(/RD\$\s13,620\.00/);
    expect(html).toContain('TRECE MIL SEISCIENTOS VEINTE PESOS DOMINICANOS CON 00/100');
    expect(html).toContain('Saldo pendiente');
    expect(html).toContain('Pagar antes del día 15.');
    expect(html).not.toMatch(/No\.:<\/b>\s*<\/div>|Nº\s*<\/div>|<span>Número<\/span><span><\/span>|<b>Nº:<\/b><\/div>/);
  });

  test('usa el color elegido y, sin color, el de la plantilla', () => {
    const conColor = FacturaContador.documentoHtml(factura(), { factura_plantilla: 'ejecutiva', factura_color: '#7e22ce' });
    expect(conColor).toContain('--acc:#7e22ce');
    const sinColor = FacturaContador.documentoHtml(factura(), { factura_plantilla: 'recuadro', factura_color: null });
    expect(sinColor).toContain('--acc:#dc2626');
  });

  test('sin diseño guardado sale la clásica (como la factura de antes)', () => {
    expect(FacturaContador.documentoHtml(factura(), {})).toContain('tcf-tpl-clasica');
  });

  test('documento listo para PDF: @page sin márgenes y ajuste a una hoja', () => {
    const html = FacturaContador.documentoHtml(factura(), {});
    expect(html).toContain('@page{size:A4;margin:0}');
    expect(html).toContain('<script>');
  });

  test('anulada: marca de agua', () => {
    expect(FacturaContador.documentoHtml(factura({ estado: 'anulada' }), {})).toContain('<div class="tcf-wm">ANULADA</div>');
  });

  test('escapa los datos del cliente', () => {
    const html = FacturaContador.documentoHtml(factura({ cliente: { nombre: '<img src=x onerror=alert(1)>' } }), {});
    expect(html).not.toContain('<img src=x');
  });
});

// Cotización como la devuelve GET /api/cotizaciones/cotizaciones/:id
function cotizacion(overrides = {}) {
  const { ncf, tipo_ncf, tipo_ncf_label, ncf_vencimiento, monto_pagado, balance, metodo_pago, ...base } = factura();
  return {
    ...base,
    numero: 'COT-000012', validez_dias: 30, fecha_vencimiento: '2026-11-13',
    condicion_pago: 'contado', notas: 'Incluye cierre fiscal anual.', observacion: '',
    estado: 'aprobada',
    ...overrides,
  };
}

describe('FacturaContador.aCotizacion / cotizacionHtml', () => {
  test('número propio, sin NCF, válida hasta y condiciones', () => {
    const d = FacturaContador.aCotizacion(cotizacion());
    expect(d.isCot).toBe(true);
    expect(d.numero).toBe('COT-000012');
    expect(d.ncf).toBe('');
    expect(d.vencimientoTexto).toBe('13 de noviembre de 2026');
    expect(d.condicionPago).toBe('Contado · válida por 30 días');
    expect(d.notas).toBe('Incluye cierre fiscal anual.');
    expect(d.empresa.direccion).toBe('Calle Las Flores 5, Santiago');
  });

  test.each([
    ['aprobada', 'APROBADA', 'ok', false],
    ['convertida', 'CONVERTIDA EN FACTURA', 'ok', false],
    ['vencida', 'VENCIDA', 'bad', false],
    ['rechazada', 'RECHAZADA', 'bad', true],
  ])('estado %s', (estado, etiqueta, sello, marca) => {
    const d = FacturaContador.aCotizacion(cotizacion({ estado }));
    expect(d.estadoLabel).toBe(etiqueta);
    expect(d.selloClase).toBe(sello);
    expect(d.anulada).toBe(marca);
  });

  test.each(PLANTILLAS)('plantilla %s: COTIZACIÓN con el diseño elegido', (plantilla) => {
    const html = FacturaContador.cotizacionHtml(cotizacion(), { factura_plantilla: plantilla, factura_color: '#0f766e' });
    expect(html).toContain(`tcf-tpl-${plantilla}`);
    expect(html).toContain('--acc:#0f766e');
    expect(html).toContain('COTIZACIÓN');
    expect(html).toContain('COT-000012');
    expect(html).toContain('Cotización de servicios profesionales');
    expect(html).toContain('TRECE MIL SEISCIENTOS VEINTE PESOS DOMINICANOS CON 00/100');
    expect(html).not.toContain('Saldo pendiente');
    expect(html).toContain('@page{size:A4;margin:0}');
  });

  test('rechazada: marca de agua RECHAZADA', () => {
    expect(FacturaContador.cotizacionHtml(cotizacion({ estado: 'rechazada' }), {}))
      .toContain('<div class="tcf-wm">RECHAZADA</div>');
  });
});

describe('selector de Configuración', () => {
  // DOM mínimo: solo lo que usa sincronizarSelector.
  function domFalso(ids, valores = {}) {
    const els = {};
    ids.forEach((id) => {
      els[id] = {
        id, value: valores[id] ?? '', style: {}, innerHTML: '', dataset: {},
        addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, contains: () => false,
      };
    });
    globalThis.document = { getElementById: (id) => els[id] || null, activeElement: null };
    return els;
  }
  const IDS = ['cfg-invoice-design', 'cfg-invoice-template', 'cfg-invoice-color', 'cfg-invoice-templates', 'cfg-invoice-colors'];

  afterEach(() => { delete globalThis.document; });

  test('POS: con papel 80 mm el bloque se oculta (sin cambios)', () => {
    const els = domFalso([...IDS, 'cfg-paper-size'], { 'cfg-paper-size': '80mm' });
    FacturaPlantillas.sincronizarSelector({ invoiceTemplate: 'banner' });
    expect(els['cfg-invoice-design'].style.display).toBe('none');
  });

  test('POS: con papel A4 se ve y la muestra es la venta de ejemplo', () => {
    const els = domFalso([...IDS, 'cfg-paper-size'], { 'cfg-paper-size': 'a4' });
    FacturaPlantillas.sincronizarSelector({ invoiceTemplate: 'banner' });
    expect(els['cfg-invoice-design'].style.display).toBe('');
    expect(els['cfg-invoice-templates'].innerHTML).toContain('Café molido 1 lb');
  });

  test('portal: sin selector de papel se ve siempre y usa su factura de muestra', () => {
    const els = domFalso(IDS);
    FacturaPlantillas.sincronizarSelector(
      { invoiceTemplate: 'Recuadro', invoiceAccentColor: '#0369A1' },
      { muestra: () => FacturaContador.documentoDeMuestra({ nombre: 'Firma Gómez', correo: 'hola@gomez.do' }) }
    );
    expect(els['cfg-invoice-design'].style.display).toBe('');
    expect(els['cfg-invoice-template'].value).toBe('recuadro');
    expect(els['cfg-invoice-color'].value).toBe('#0369a1');
    const miniaturas = els['cfg-invoice-templates'].innerHTML;
    PLANTILLAS.forEach((id) => expect(miniaturas).toContain(`data-plantilla="${id}"`));
    expect(miniaturas).toContain('Firma Gómez');
    expect(miniaturas).toContain('hola@gomez.do');
    expect(miniaturas).toContain('Contabilidad mensual');
    expect(miniaturas).not.toContain('Café molido');
    expect(els['cfg-invoice-colors'].innerHTML).toContain('data-color="#0369a1"');
  });
});
