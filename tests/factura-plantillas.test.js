'use strict';

/**
 * Plantillas de la factura A4 (js/factura-plantillas.js) y el saneo de lo que
 * se guarda en config (server/utils/invoice-design.js).
 */

const FacturaPlantillas = require('../js/factura-plantillas.js');
const {
  INVOICE_TEMPLATES,
  sanitizeInvoiceTemplate,
  sanitizeInvoiceAccentColor
} = require('../server/utils/invoice-design');

function documento(overrides = {}) {
  return { ...FacturaPlantillas.documentoDeMuestra({ nombre: 'Colmado La Esquina', rnc: '131-00000-1' }), ...overrides };
}

// Hoja falsa para ajustarAUnaHoja (jsdom no calcula alturas): el contenido
// mide `alto` px sin reducir, con 60 px de margen arriba y abajo.
function hojaFalsa(alto) {
  const estado = { zoom: null };
  const raiz = {
    style: { setProperty: (_k, v) => { estado.zoom = v; } },
    querySelector: (sel) => (sel === '.tcf-page' ? {} : { offsetTop: 60, offsetHeight: alto }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ paddingBottom: '60px' }) } }
  };
  return { estado, contenedor: { querySelectorAll: () => [raiz] } };
}

describe('Una sola hoja A4', () => {
  const { ajustarAUnaHoja, ESCALA_MINIMA } = FacturaPlantillas;

  test('si cabe, queda en tamaño normal', () => {
    const h = hojaFalsa(800);
    ajustarAUnaHoja(h.contenedor, ESCALA_MINIMA);
    expect(h.estado.zoom).toBe('1');
  });

  test('si se pasa un poco, reduce lo justo para caber en una hoja', () => {
    const h = hojaFalsa(1300); // 1420 px de alto; la hoja tiene ~1115 px útiles
    ajustarAUnaHoja(h.contenedor, ESCALA_MINIMA);
    expect(h.estado.zoom).toBe('0.78');
  });

  test('con muchas líneas no achica: salen varias hojas en tamaño normal', () => {
    const h = hojaFalsa(3000);
    ajustarAUnaHoja(h.contenedor, ESCALA_MINIMA);
    expect(h.estado.zoom).toBe('1');
  });

  test('el <script> para los documentos es JavaScript válido', () => {
    const s = FacturaPlantillas.scriptUnaHoja();
    expect(s.startsWith('<script>')).toBe(true);
    expect(() => new Function(s.replace(/^<script>|<\/script>$/g, ''))).not.toThrow();
  });
});

function acentoDe(html) {
  return /--acc:(#[0-9a-f]{6})/.exec(html)?.[1];
}

describe('FacturaPlantillas.render', () => {
  test.each(INVOICE_TEMPLATES)('la plantilla %s trae los datos fiscales y los totales', (plantilla) => {
    const html = FacturaPlantillas.render(documento(), { plantilla });
    expect(html).toContain(`tcf-tpl-${plantilla}`);
    expect(html).toContain('Colmado La Esquina');
    expect(html).toContain('131-00000-1');
    expect(html).toContain('B0200000123');
    expect(html).toContain('B02 — Consumidor Final');
    expect(html).toContain('FAC-0001016');
    expect(html).toContain('Cliente de muestra');
    expect(html).toContain('Café molido 1 lb');
    expect(html).toContain('Exento');
    expect(html).toMatch(/RD\$\s657\.70/);
    expect(html).toContain('SEISCIENTOS CINCUENTA Y SIETE PESOS DOMINICANOS CON 70/100');
    expect(html).toContain('<style>');
  });

  test('una plantilla desconocida cae en la clásica', () => {
    const html = FacturaPlantillas.render(documento(), { plantilla: 'no-existe' });
    expect(html).toContain('tcf-tpl-clasica');
    expect(acentoDe(html)).toBe('#15803d');
  });

  test('sin color usa el de la plantilla; con color usa el elegido', () => {
    expect(acentoDe(FacturaPlantillas.render(documento(), { plantilla: 'recuadro' }))).toBe('#dc2626');
    expect(acentoDe(FacturaPlantillas.render(documento(), { plantilla: 'recuadro', color: '#7E22CE' }))).toBe('#7e22ce');
    expect(acentoDe(FacturaPlantillas.render(documento(), { plantilla: 'banner', color: 'rojo' }))).toBe('#2c3e50');
  });

  test('escapa el texto de la venta', () => {
    const html = FacturaPlantillas.render(documento({
      cliente: { nombre: '<img src=x onerror=alert(1)>', rnc: '', tel: '', dir: '' }
    }), { plantilla: 'ejecutiva' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test.each(INVOICE_TEMPLATES)('e-CF en %s: QR, código de seguridad y fecha de firma', (plantilla) => {
    const html = FacturaPlantillas.render(documento({
      fiscalMode: 'ecf',
      ncf: 'E320000000123',
      qrDataUrl: 'data:image/png;base64,AAAA',
      codigoSeguridad: 'A7K2M9',
      fechaFirma: '11-10-2026 19:53:32'
    }), { plantilla });
    expect(html).toContain('e-NCF');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('A7K2M9');
    expect(html).toContain('11-10-2026 19:53:32');
  });

  test('sin e-CF no sale el bloque de seguridad', () => {
    const html = FacturaPlantillas.render(documento({ codigoSeguridad: 'A7K2M9' }), { plantilla: 'clasica' });
    expect(html).not.toContain('Código de seguridad');
  });

  test.each(INVOICE_TEMPLATES)('anulada en %s: marca de agua y estado', (plantilla) => {
    const html = FacturaPlantillas.render(documento({ anulada: true, estadoLabel: 'ANULADA' }), { plantilla });
    expect(html).toContain('<div class="tcf-wm">ANULADA</div>');
    expect(html).not.toContain('tcf-stamp ok');
  });

  test.each(['clasica', 'ejecutiva'])('el sello de %s sale en rojo aunque la anulada estuviera pagada', (plantilla) => {
    const html = FacturaPlantillas.render(documento({ anulada: true, estadoLabel: 'ANULADA', balance: 0 }), { plantilla });
    expect(html).toContain('tcf-stamp bad');
  });

  test('cotización: título y nota sin valor fiscal', () => {
    const html = FacturaPlantillas.render(documento({ isCot: true, estadoLabel: 'COTIZACIÓN' }), { plantilla: 'banner' });
    expect(html).toContain('COTIZACIÓN');
    expect(html).toContain('Cotización sin valor fiscal');
  });

  test('saldo pendiente en venta a crédito', () => {
    const html = FacturaPlantillas.render(documento({
      condicionPago: 'crédito', estadoLabel: 'PAGO PARCIAL', pagado: 200, balance: 457.7
    }), { plantilla: 'recuadro' });
    expect(html).toContain('Saldo pendiente');
    expect(html).toMatch(/RD\$\s457\.70/);
  });

  test('aguanta un documento sin ítems ni cliente', () => {
    expect(() => FacturaPlantillas.render({ total: 0 }, { plantilla: 'ejecutiva' })).not.toThrow();
  });
});

describe('FacturaPlantillas.resolverColores', () => {
  test('un color muy claro se oscurece para el texto y usa letra oscura encima', () => {
    const c = FacturaPlantillas.resolverColores('clasica', '#fde047');
    expect(c.acc).toBe('#fde047');
    expect(c.ink).not.toBe('#fde047');
    expect(c.onAcc).toBe('#111827');
  });

  test('los colores de la paleta llevan letra blanca encima', () => {
    FacturaPlantillas.PALETA.forEach(({ color }) => {
      expect(FacturaPlantillas.resolverColores('clasica', color).onAcc).toBe('#ffffff');
    });
  });
});

describe('montoEnLetras', () => {
  test.each([
    [0, 'CERO PESOS DOMINICANOS CON 00/100'],
    [1500.5, 'MIL QUINIENTOS PESOS DOMINICANOS CON 50/100'],
    [21, 'VEINTIUNO PESOS DOMINICANOS CON 00/100'],
    [1250000, 'UN MILLÓN DOSCIENTOS CINCUENTA MIL PESOS DOMINICANOS CON 00/100']
  ])('%s', (valor, esperado) => {
    expect(FacturaPlantillas.montoEnLetras(valor)).toBe(esperado);
  });
});

describe('server/utils/invoice-design', () => {
  test('la lista del servidor coincide con las plantillas del renderer', () => {
    expect(FacturaPlantillas.PLANTILLAS.map((p) => p.id)).toEqual([...INVOICE_TEMPLATES]);
  });

  test('sanitizeInvoiceTemplate', () => {
    expect(sanitizeInvoiceTemplate('Banner')).toBe('banner');
    expect(sanitizeInvoiceTemplate('otra')).toBeNull();
    expect(sanitizeInvoiceTemplate(undefined)).toBeNull();
  });

  test('sanitizeInvoiceAccentColor', () => {
    expect(sanitizeInvoiceAccentColor('#1E4E8C')).toBe('#1e4e8c');
    expect(sanitizeInvoiceAccentColor('')).toBeNull();
    expect(sanitizeInvoiceAccentColor('red')).toBeNull();
    expect(sanitizeInvoiceAccentColor('#fff')).toBeNull();
    expect(sanitizeInvoiceAccentColor('#123456; background:url(x)')).toBeNull();
  });
});
