'use strict';

/**
 * tests/routes/servicios.routes.test.js
 *
 * Modo "Empresa de Servicios" (M1 núcleo): gating por instalación, catálogo,
 * cotizaciones, conversión a factura, cobros (balance) y helpers puros
 * (computeTotals / numeroALetras / renderInvoiceDoc).
 */

const express = require('express');
const request = require('supertest');

const { createServiciosRouter } = require('../../server/routes/servicios');
const { computeTotals } = require('../../server/routes/servicios/_common');
const { renderInvoiceDoc, numeroALetras } = require('../../server/routes/servicios/renderDoc');

function buildApp({ query, config, actor, ecfService } = {}) {
  const mockQuery = query || jest.fn().mockResolvedValue([]);
  const app = express();
  app.use(express.json());
  app.use('/api/servicios', createServiciosRouter({
    query: mockQuery,
    withTransaction: async (fn) => fn({ query: mockQuery }),
    resolveRequestActorUser: jest.fn().mockResolvedValue(
      actor !== undefined ? actor : { id: 1, usuario: 'admin', role_code: 'administrador_general' }
    ),
    userRoleHasPermission: jest.fn().mockReturnValue(true),
    writeAuditLog: jest.fn().mockResolvedValue(),
    getUserScopeBranchId: () => null,
    isGlobalAdministratorUser: (u) => (u?.role_code || u?.rol) === 'administrador_general',
    isBranchAdministratorUser: () => false,
    getConfig: jest.fn().mockResolvedValue(config === undefined ? { serviceCompany: true, serviceFiscalMode: 'ncf' } : config),
    getNextNcfFromSequence: jest.fn().mockResolvedValue({ ncf: 'B0200000001', fechaVencimiento: '2026-12-31' }),
    ecfService,
  }));
  return { app, mockQuery };
}

describe('servicios.routes — helpers puros', () => {
  it('computeTotals suma subtotal, descuento e ITBIS por línea', () => {
    const t = computeTotals([
      { descripcion: 'Consultoría', cantidad: 2, precio: 1000, descuentoPct: 10, itbisPct: 18 },
    ]);
    expect(t.subtotal).toBe(2000);
    expect(t.descuento).toBe(200);
    expect(t.itbis).toBe(324); // (2000-200)*0.18
    expect(t.total).toBe(2124);
    expect(t.items[0].total).toBe(2124);
  });

  it('numeroALetras genera el texto fiscal', () => {
    expect(numeroALetras(2124)).toContain('PESOS DOMINICANOS CON 00/100');
    expect(numeroALetras(1234.5)).toContain('CON 50/100');
  });

  it('renderInvoiceDoc soporta A4, 80mm y 58mm', () => {
    const doc = {
      empresa: { nombre: 'Firma X', rnc: '101' },
      invoice: { numero: 'FAC-000001', ncf: 'B0200000001', fiscalMode: 'ncf', clientName: 'ACME', fecha: '2026-09-01', estado: 'pendiente', subtotal: 100, descuento: 0, itbis: 18, total: 118, pagado: 0, balance: 118 },
      items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, total: 118 }],
    };
    expect(renderInvoiceDoc(doc, 'a4')).toContain('>FACTURA<');
    expect(renderInvoiceDoc({ ...doc, invoice: { ...doc.invoice, docType: 'cotizacion' } }, 'a4')).toContain('>COTIZACIÓN<');
    expect(renderInvoiceDoc(doc, '80mm')).toContain('80mm');
    expect(renderInvoiceDoc(doc, '58mm')).toContain('58mm');
  });

  it('renderInvoiceDoc imprime QR, código de seguridad y fecha de firma del e-CF (A4 y térmico)', () => {
    const doc = {
      empresa: { nombre: 'Firma X', rnc: '101' },
      invoice: {
        numero: 'FAC-000002', ncf: 'E310000000001', ncfTipo: 'E31', fiscalMode: 'ecf', clientName: 'ACME', clientRnc: '131123456',
        fecha: '2026-10-21', estado: 'pagada', subtotal: 100, descuento: 0, itbis: 18, total: 118, pagado: 118, balance: 0,
        ecfQrDataUrl: 'data:image/png;base64,AAAA', ecfCodigoSeguridad: 'Ab12Cd', ecfFechaFirma: '21-10-2026 09:30:00',
      },
      items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, total: 118 }],
    };
    for (const formato of ['a4', '80mm']) {
      const html = renderInvoiceDoc(doc, formato);
      expect(html).toContain('data:image/png;base64,AAAA');
      expect(html).toContain('Ab12Cd');
      expect(html).toContain('21-10-2026 09:30:00');
    }
  });

  it('renderInvoiceDoc estampa el bloque "FIRMADO DIGITALMENTE" cuando hay digitalSign', () => {
    const base = {
      empresa: { nombre: 'Firma X', rnc: '101' },
      invoice: { numero: 'FAC-1', clientName: 'ACME', fecha: '2026-09-05', estado: 'pendiente', subtotal: 100, descuento: 0, itbis: 18, total: 118, pagado: 0, balance: 118 },
      items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, total: 118 }],
    };
    // Cotización sin firma → línea simple "Firma y sello"; sin bloque digital.
    const cotSin = renderInvoiceDoc({ ...base, invoice: { ...base.invoice, docType: 'cotizacion' } }, 'a4');
    expect(cotSin).not.toContain('FIRMADO DIGITALMENTE');
    expect(cotSin).toContain('Firma y sello');

    // Factura + digitalSign → bloque "FIRMADO DIGITALMENTE" con nombre y RNC.
    const con = renderInvoiceDoc(
      { ...base, invoice: { ...base.invoice, digitalSign: { nombre: 'Firma X SRL', rnc: '40211932609', fecha: new Date('2026-09-05T17:18:00') } } },
      'a4'
    );
    expect(con).toContain('FIRMADO DIGITALMENTE');
    expect(con).toContain('Firma X SRL');
    expect(con).toContain('RNC 40211932609');
  });

  it('renderInvoiceDoc A4 usa la plantilla y el color de Configuración', () => {
    const doc = {
      empresa: { nombre: 'Firma X', rnc: '101' },
      invoice: { numero: 'FAC-2', clientName: 'ACME', fecha: '2026-10-14', estado: 'pagada', subtotal: 200, descuento: 20, itbis: 32.4, total: 212.4, pagado: 212.4, balance: 0, pagos: [{ metodo: 'transferencia' }], notas: 'CONDICIONES\nPago al 50%' },
      items: [{ descripcion: 'Soporte', cantidad: 2, precio: 100, descuentoPct: 10, itbisPct: 18, total: 212.4 }],
      diseno: { plantilla: 'ejecutiva', color: '#7e22ce' },
    };
    const html = renderInvoiceDoc(doc, 'a4');
    expect(html).toContain('tcf-tpl-ejecutiva');
    expect(html).toContain('--acc:#7e22ce');
    expect(html).toContain('Transferencia');
    expect(html).toContain('Descuento 10%');       // descuento de la línea, bajo la descripción
    expect(html).toContain('<strong>CONDICIONES</strong>');
    // Sin diseño guardado → plantilla clásica.
    expect(renderInvoiceDoc({ ...doc, diseno: undefined }, 'a4')).toContain('tcf-tpl-clasica');
  });

  it('los términos y condiciones de Ajustes salen en factura y cotización (A4 y ticket)', () => {
    const doc = {
      empresa: { nombre: 'Firma X' },
      invoice: { numero: 'FAC-3', clientName: 'ACME', fecha: '2026-10-14', estado: 'pendiente', subtotal: 100, descuento: 0, itbis: 18, total: 118, pagado: 0, balance: 118 },
      items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, itbisPct: 18, total: 118 }],
      terminos: 'Garantía de 30 días.\nNo se aceptan devoluciones.',
    };
    for (const plantilla of ['clasica', 'ejecutiva', 'recuadro', 'banner']) {
      const html = renderInvoiceDoc({ ...doc, diseno: { plantilla } }, 'a4');
      expect(html).toContain('Términos y condiciones');
      expect(html).toContain('Garantía de 30 días.');
    }
    expect(renderInvoiceDoc({ ...doc, invoice: { ...doc.invoice, docType: 'cotizacion' } }, 'a4')).toContain('No se aceptan devoluciones.');
    expect(renderInvoiceDoc(doc, '80mm')).toContain('Garantía de 30 días.');
    // Sin términos guardados no sale el bloque.
    expect(renderInvoiceDoc({ ...doc, terminos: '' }, 'a4')).not.toContain('Términos y condiciones');
  });
});

describe('servicios.routes — gating', () => {
  it('devuelve 404 si la instalación no es Empresa de Servicios', async () => {
    const { app } = buildApp({ config: { serviceCompany: false } });
    const res = await request(app).get('/api/servicios/catalogo');
    expect(res.status).toBe(404);
  });

  it('permite el catálogo cuando serviceCompany = true', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/servicios/catalogo');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('servicios.routes — catálogo', () => {
  it('rechaza un servicio sin nombre', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/servicios/catalogo').send({ precio: 100 });
    expect(res.status).toBe(400);
  });

  it('importar CSV: crea y actualiza; sin filas o con demasiadas lo rechaza', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql, params) => {
      if (/FROM svc_services WHERE LOWER\(COALESCE\(codigo/i.test(sql) && params[0] === 'MANT-01') {
        return [{ id: 3, codigo: 'MANT-01', nombre: 'Mantenimiento', precio: 1500, itbis_pct: 18, unidad: 'visita', activo: 1 }];
      }
      if (/^INSERT INTO svc_services/i.test(sql)) return { insertId: 9 };
      if (/^UPDATE svc_services/i.test(sql)) return { affectedRows: 1 };
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/catalogo/importar').send({ servicios: [
      { fila: 2, campos: ['codigo', 'precio'], codigo: 'MANT-01', nombre: '', precio: 1800 },
      { fila: 3, campos: ['nombre', 'precio', 'itbisPct'], codigo: '', nombre: 'Asesoría', precio: 2500, itbisPct: 0 },
    ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ creados: 1, actualizados: 1, omitidos: 0, errores: [] });
    const update = mockQuery.mock.calls.find(([sql]) => /^UPDATE svc_services/i.test(sql));
    expect(update[1].slice(0, 6)).toEqual(['MANT-01', 'Mantenimiento', undefined, undefined, 1800, 18]);

    expect((await request(app).post('/api/servicios/catalogo/importar').send({ servicios: [] })).status).toBe(400);
    const muchos = Array.from({ length: 2001 }, (_, i) => ({ nombre: `S${i}` }));
    expect((await request(app).post('/api/servicios/catalogo/importar').send({ servicios: muchos })).status).toBe(400);
  });

  it('crea un servicio válido', async () => {
    const mockQuery = jest.fn()
      .mockResolvedValueOnce([]) // ensureSchema PRAGMA/…
      .mockResolvedValue([]);
    // ensureSchema hace muchas queries; devolvemos [] a todo salvo el INSERT/SELECT finales
    mockQuery.mockImplementation(async (sql) => {
      if (/^INSERT INTO svc_services/i.test(sql)) return { insertId: 7 };
      if (/FROM svc_services s/i.test(sql)) return [{ id: 7, nombre: 'Auditoría', precio: 5000, itbis_pct: 18, unidad: 'servicio', activo: 1 }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/catalogo').send({ nombre: 'Auditoría', precio: 5000, itbisPct: 18 });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Auditoría');
  });
});

describe('servicios.routes — cotizaciones', () => {
  it('una cotización nueva nace en estado "aprobada" (sin borrador)', async () => {
    let insertedEstado = null;
    const mockQuery = jest.fn().mockImplementation(async (sql, params) => {
      if (/^INSERT INTO svc_quotations/i.test(sql)) { insertedEstado = params[8]; return { insertId: 4 }; }
      if (/FROM svc_quotations q/i.test(sql) && /q\.id = \?/.test(sql)) {
        return [{ id: 4, numero: 'COT-000004', estado: insertedEstado || 'aprobada', client_id: null, client_name: 'emilio',
          fecha: '2026-09-06', validez_dias: 15, subtotal: 100, descuento: 0, itbis: 18, total: 118 }];
      }
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/cotizaciones').send({
      clientName: 'emilio', items: [{ descripcion: 'Servicio', cantidad: 1, precio: 100, itbisPct: 18 }],
    });
    expect(res.status).toBe(201);
    expect(insertedEstado).toBe('aprobada');
    expect(res.body.estado).toBe('aprobada');
  });
});

describe('servicios.routes — cobros', () => {
  it('rechaza un pago mayor al balance si no es anticipo', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/FROM svc_invoices WHERE id/i.test(sql)) {
        return [{ id: 1, estado: 'pendiente', balance: 500, total: 500, branch_id: null, client_id: null, cash_register_id: null, numero: 'FAC-1' }];
      }
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/cobros').send({ invoiceId: 1, monto: 900, metodo: 'efectivo' });
    expect(res.status).toBe(409);
  });
});

describe('servicios.routes — M2 (contratos / órdenes / proyectos)', () => {
  it('contrato requiere título', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/servicios/contratos').send({ monto: 1000 });
    expect(res.status).toBe(400);
  });

  it('crea una orden de trabajo y queda "asignada" si trae responsable', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/^INSERT INTO svc_work_orders/i.test(sql)) return { insertId: 3 };
      if (/FROM svc_work_orders o/i.test(sql)) return [{ id: 3, numero: 'OT-000003', titulo: 'Reparación', tipo: 'servicio', estado: 'asignada', prioridad: 'normal', responsable_nombre: 'Carlos' }];
      if (/svc_work_order_assignees/i.test(sql)) return [];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/ordenes')
      .send({ titulo: 'Reparación', responsableId: 5, responsableNombre: 'Carlos' });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('asignada');
  });

  it('la factura de servicios se espeja en la tabla sales del POS', async () => {
    const calls = [];
    const mockQuery = jest.fn().mockImplementation(async (sql, params) => {
      calls.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 40));
      if (/^INSERT INTO svc_invoices/i.test(sql)) return { insertId: 10 };
      if (/^INSERT INTO sales/i.test(sql)) return { insertId: 77 };
      if (/^INSERT INTO sale_items/i.test(sql)) return { insertId: 1 };
      if (/FROM svc_invoices i\s+LEFT JOIN/i.test(sql)) return [{ id: 10, numero: 'FAC-000010', estado: 'pagada', total: 118, subtotal: 100, descuento: 0, itbis: 18, fiscal_mode: 'ncf', ncf: 'B0200000001', items: [] }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/facturas').send({
      clientName: 'ACME', fiscalMode: 'consumidor', condicionPago: 'contado', metodoPago: 'efectivo',
      items: [{ descripcion: 'Consultoría', cantidad: 1, precio: 100, itbisPct: 18 }],
    });
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.startsWith('INSERT INTO sales'))).toBe(true);
    expect(calls.some((c) => c.startsWith('INSERT INTO sale_items'))).toBe(true);
    expect(calls.some((c) => c.startsWith('UPDATE svc_invoices SET sale_id'))).toBe(true);
  });

  it('proyecto rechaza estado inválido', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/FROM svc_projects p\s+LEFT JOIN/i.test(sql)) return [{ id: 1, numero: 'PRY-1', nombre: 'X', estado: 'planificacion', avance_pct: 0 }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/proyectos/1/estado').send({ estado: 'volando' });
    expect(res.status).toBe(400);
  });

  it('lista de empleados para asignar responde 200', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/servicios/recursos/empleados');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('servicios.routes — M3 verticales', () => {
  it('puesto de seguridad requiere nombre', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/servicios/seguridad/puestos').send({ ubicacion: 'Torre A' });
    expect(res.status).toBe(400);
  });

  it('lista de equipos responde 200', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/servicios/mantenimiento/equipos');
    expect(res.status).toBe(200);
  });

  it('reservación calcula saldo = total - anticipo', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/^INSERT INTO svc_reservations/i.test(sql)) return { insertId: 4 };
      if (/FROM svc_reservations r\s+LEFT JOIN/i.test(sql)) {
        return [{ id: 4, numero: 'RES-000004', titulo: 'Cancún', estado: 'cotizada', total: 50000, anticipo: 20000, saldo: 30000, costo: 40000 }];
      }
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/viajes/reservaciones')
      .send({ titulo: 'Cancún', total: 50000, anticipo: 20000, costo: 40000 });
    expect(res.status).toBe(201);
    expect(res.body.saldo).toBe(30000);
  });

  it('campaña calcula disponible = presupuesto - gastado', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/^INSERT INTO svc_campaigns/i.test(sql)) return { insertId: 2 };
      if (/FROM svc_campaigns c\s+LEFT JOIN/i.test(sql)) return [{ id: 2, numero: 'CMP-2', nombre: 'Lanzamiento', canal: 'mixto', presupuesto: 100000, estado: 'planificacion' }];
      if (/FROM svc_campaign_expenses/i.test(sql)) return [{ id: 1, descripcion: 'Pauta', categoria: 'pauta', monto: 25000, fecha: '2026-09-01' }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/campanas').send({ nombre: 'Lanzamiento', presupuesto: 100000 });
    expect(res.status).toBe(201);
    expect(res.body.disponible).toBe(75000);
  });

  it('obra rechaza tipo desconocido pero acepta creación con nombre', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/^INSERT INTO svc_construction_sites/i.test(sql)) return { insertId: 1 };
      if (/FROM svc_construction_sites s\s+LEFT JOIN/i.test(sql)) return [{ id: 1, numero: 'OBR-1', nombre: 'Casa 1', tipo: 'residencial', estado: 'en_curso', avance_pct: 0, presupuesto: 0 }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery });
    const res = await request(app).post('/api/servicios/obras').send({ nombre: 'Casa 1', tipo: 'loquesea' });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('residencial');
  });
});

describe('servicios.routes — factura e-CF con las secuencias del módulo e-CF', () => {
  const seq = (over) => ({ tipoComprobante: 'E31', activo: true, isExpired: false, isExhausted: false, branchId: null, cashRegisterId: null, remaining: 50, fechaVencimiento: '2027-12-31', ...over });
  const checklistOk = { items: [{ key: 'emitter_rnc', status: 'ok' }, { key: 'certificate', status: 'ok' }, { key: 'sequences', status: 'ok' }] };
  const ecfServiceMock = (over = {}) => ({
    ensureReady: jest.fn().mockResolvedValue(),
    listSequences: jest.fn().mockResolvedValue([
      seq({}), seq({ tipoComprobante: 'E32', remaining: 10 }),
      seq({ tipoComprobante: 'E44', isExpired: true }), // vencida
      seq({ tipoComprobante: 'E34' }), // nota de crédito: no se factura desde aquí
      seq({ tipoComprobante: 'E45', branchId: 9 }), // de otra sucursal
    ]),
    getSystemStatus: jest.fn().mockResolvedValue({ isActive: true, checklist: checklistOk }),
    getCertificateStatus: jest.fn().mockResolvedValue({ hasCertificate: true, status: 'valido', isExpired: false }),
    processSaleForElectronicInvoicing: jest.fn().mockResolvedValue({ ok: true, encf: 'E310000000007', tipoEcf: 'E31', estado: 'aceptado' }),
    ...over,
  });
  const factura = (over) => ({
    clientName: 'ACME SRL', clientRnc: '131123456', fiscalMode: 'ecf', ncfTipo: 'E31', condicionPago: 'contado', metodoPago: 'efectivo',
    items: [{ descripcion: 'Consultoría', cantidad: 1, precio: 100, itbisPct: 18 }], ...over,
  });
  function queryFactura(calls) {
    return jest.fn().mockImplementation(async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^INSERT INTO svc_invoices/i.test(sql)) return { insertId: 10 };
      if (/^INSERT INTO sales/i.test(sql)) return { insertId: 77 };
      if (/^INSERT INTO sale_items/i.test(sql)) return { insertId: 1 };
      if (/FROM ecf_documents d/i.test(sql)) return [{ encf: 'E310000000007', tipo_ecf: 'E31', estado_dgii: 'aceptado', fecha_vencimiento: '2027-12-31' }];
      if (/FROM svc_invoices i\s+LEFT JOIN/i.test(sql)) return [{ id: 10, numero: 'FAC-000010', estado: 'pagada', total: 118, subtotal: 100, descuento: 0, itbis: 18, fiscal_mode: 'ecf', ncf: 'E310000000007' }];
      return [];
    });
  }

  it('comprobantes lista un e-CF por tipo con secuencia activa (sin vencidas, notas ni de otra sucursal)', async () => {
    const { app } = buildApp({ ecfService: ecfServiceMock() });
    const res = await request(app).get('/api/servicios/facturas/comprobantes');
    expect(res.status).toBe(200);
    expect(res.body.electronicos.map((e) => e.tipo)).toEqual(['E31', 'E32']);
    expect(res.body.electronicos[0]).toMatchObject({ disponibles: 50, vencimiento: '2027-12-31' });
    expect(res.body.ecfActivo).toBe(true);
  });

  it('avisa cuando las secuencias e-CF activas son de otra sucursal', async () => {
    const ecfService = ecfServiceMock({ listSequences: jest.fn().mockResolvedValue([seq({ branchId: 4 })]) });
    const { app } = buildApp({ ecfService });
    const res = await request(app).get('/api/servicios/facturas/comprobantes');
    expect(res.body.electronicos).toEqual([]);
    expect(res.body.ecfFueraDeAlcance).toBe(true);
  });

  it('emite la factura e-CF con el motor del POS y guarda el e-NCF de la secuencia', async () => {
    const calls = [];
    const ecfService = ecfServiceMock();
    const { app } = buildApp({ query: queryFactura(calls), ecfService });
    const res = await request(app).post('/api/servicios/facturas').send(factura());
    expect(res.status).toBe(201);
    expect(ecfService.processSaleForElectronicInvoicing).toHaveBeenCalledWith(77, expect.objectContaining({ requestedType: 'E31' }));
    const update = calls.find((c) => c.sql.startsWith('UPDATE svc_invoices SET ncf = ?'));
    expect(update.params).toEqual(['E310000000007', 'E31', '2027-12-31', 'aceptado', 10]);
    // El e-NCF ya no sale del contador viejo de config.
    expect(calls.some((c) => /e_invoice_next_number/.test(c.sql))).toBe(false);
    expect(res.body.ecf).toMatchObject({ ok: true, encf: 'E310000000007' });
  });

  it('con la facturación electrónica desactivada no guarda la factura (409)', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({ getSystemStatus: jest.fn().mockResolvedValue({ isActive: false, checklist: checklistOk }) });
    const { app } = buildApp({ query: queryFactura(calls), ecfService });
    const res = await request(app).post('/api/servicios/facturas').send(factura());
    expect(res.status).toBe(409);
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO svc_invoices'))).toBe(false);
    expect(ecfService.processSaleForElectronicInvoicing).not.toHaveBeenCalled();
  });

  it('sin secuencia del tipo elegido responde 409 sin guardar', async () => {
    const calls = [];
    const { app } = buildApp({ query: queryFactura(calls), ecfService: ecfServiceMock() });
    const res = await request(app).post('/api/servicios/facturas').send(factura({ ncfTipo: 'E44' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/E44/);
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO svc_invoices'))).toBe(false);
  });

  it('E31 sin RNC del cliente responde 400 sin guardar', async () => {
    const calls = [];
    const { app } = buildApp({ query: queryFactura(calls), ecfService: ecfServiceMock() });
    const res = await request(app).post('/api/servicios/facturas').send(factura({ clientRnc: '' }));
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO svc_invoices'))).toBe(false);
  });

  function queryReintento(calls, { doc = null, inv = {} } = {}) {
    return jest.fn().mockImplementation(async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/FROM svc_invoices WHERE id = \?/i.test(sql)) {
        return [{ id: 2, numero: 'FAC-000002', fiscal_mode: 'ecf', ncf: 'E320000000001', ncf_tipo: 'E32', sale_id: 2, estado: 'pagada', client_name: 'emilio', client_rnc: '40211932609', branch_id: null, cash_register_id: null, ...inv }];
      }
      if (/FROM ecf_documents WHERE sale_id = \?/i.test(sql)) return doc ? [doc] : [];
      if (/FROM ecf_documents d/i.test(sql)) return [{ encf: 'E320000000001', tipo_ecf: 'E32', estado_dgii: 'aceptado', fecha_vencimiento: '2028-10-20' }];
      if (/FROM svc_invoices i\s+LEFT JOIN/i.test(sql)) return [{ id: 2, numero: 'FAC-000002', estado: 'pagada', total: 295, fiscal_mode: 'ecf', ncf: 'E320000000001' }];
      return [];
    });
  }

  it('reintentar: documento sin firmar (el XML falló) se emite otra vez con el mismo e-NCF', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({
      processSaleForElectronicInvoicing: jest.fn().mockResolvedValue({ ok: true, encf: 'E320000000001', tipoEcf: 'E32', estado: 'aceptado' }),
      resendDocument: jest.fn(),
    });
    const { app } = buildApp({ query: queryReintento(calls, { doc: { id: 1, encf: 'E320000000001', tipo_ecf: 'E32', estado_dgii: 'pendiente', firmado: 0 } }), ecfService });
    const res = await request(app).post('/api/servicios/facturas/2/reintentar-ecf').send({});
    expect(res.status).toBe(200);
    expect(ecfService.processSaleForElectronicInvoicing).toHaveBeenCalledWith(2, expect.objectContaining({ requestedType: 'E32' }));
    expect(ecfService.resendDocument).not.toHaveBeenCalled();
    expect(ecfService.listSequences).not.toHaveBeenCalled(); // reusa su número: no pide uno libre
    expect(res.body.ecf).toMatchObject({ ok: true, encf: 'E320000000001' });
  });

  it('reintentar: documento ya firmado solo se reenvía', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({ resendDocument: jest.fn().mockResolvedValue({ ok: true, estado: 'aceptado', encf: 'E320000000001' }) });
    const { app } = buildApp({ query: queryReintento(calls, { doc: { id: 5, encf: 'E320000000001', tipo_ecf: 'E32', estado_dgii: 'error', firmado: 1 } }), ecfService });
    const res = await request(app).post('/api/servicios/facturas/2/reintentar-ecf').send({});
    expect(res.status).toBe(200);
    expect(ecfService.resendDocument).toHaveBeenCalledWith(5);
    expect(ecfService.processSaleForElectronicInvoicing).not.toHaveBeenCalled();
  });

  it('reintentar: un e-CF ya aceptado no se vuelve a enviar (409)', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({ resendDocument: jest.fn() });
    const { app } = buildApp({ query: queryReintento(calls, { doc: { id: 5, encf: 'E320000000001', tipo_ecf: 'E32', estado_dgii: 'aceptado', firmado: 1 } }), ecfService });
    const res = await request(app).post('/api/servicios/facturas/2/reintentar-ecf').send({});
    expect(res.status).toBe(409);
    expect(ecfService.resendDocument).not.toHaveBeenCalled();
    expect(ecfService.processSaleForElectronicInvoicing).not.toHaveBeenCalled();
  });

  it('reintentar: una factura empezada en TesteCF no se manda estando en producción (409)', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({
      getSystemStatus: jest.fn().mockResolvedValue({ isActive: true, environment: 'ecf', checklist: checklistOk }),
      resendDocument: jest.fn(),
    });
    const { app } = buildApp({ query: queryReintento(calls, { doc: { id: 1, encf: 'E320000000001', tipo_ecf: 'E32', estado_dgii: 'pendiente', environment: 'testecf', firmado: 0 } }), ecfService });
    const res = await request(app).post('/api/servicios/facturas/2/reintentar-ecf').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/testecf/);
    expect(ecfService.processSaleForElectronicInvoicing).not.toHaveBeenCalled();
  });

  it('reintentar: factura vieja con número inventado se emite con la secuencia y se limpia el número viejo', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({ processSaleForElectronicInvoicing: jest.fn().mockResolvedValue({ ok: true, encf: 'E310000000001', tipoEcf: 'E31', estado: 'aceptado' }) });
    const q = queryReintento(calls, { inv: { id: 1, ncf: 'ECF0000000001', ncf_tipo: 'E31', sale_id: 1, client_name: 'Emilio Manaurys Cabrera' } });
    const { app } = buildApp({ query: q, ecfService });
    const res = await request(app).post('/api/servicios/facturas/1/reintentar-ecf').send({});
    expect(res.status).toBe(200);
    expect(ecfService.processSaleForElectronicInvoicing).toHaveBeenCalledWith(1, expect.objectContaining({ requestedType: 'E31' }));
    const limpia = calls.find((c) => c.sql.startsWith('UPDATE sales SET ncf = NULL'));
    expect(limpia.params).toEqual([1, 'ECF0000000001']);
  });

  it('si la DGII falla, la factura queda guardada y la respuesta trae el error', async () => {
    const calls = [];
    const ecfService = ecfServiceMock({ processSaleForElectronicInvoicing: jest.fn().mockRejectedValue(new Error('DGII no responde')) });
    const q = queryFactura(calls);
    const { app } = buildApp({ query: q, ecfService });
    const res = await request(app).post('/api/servicios/facturas').send(factura());
    expect(res.status).toBe(201);
    expect(res.body.ecf).toMatchObject({ ok: false, estado: 'error', error: 'DGII no responde' });
  });
});

describe('servicios.routes — firma digital del PDF', () => {
  const fs = require('fs');
  const path = require('path');
  const P12 = path.join(__dirname, '../../modules/ecf/certificates/business-1-active.p12');
  const P12_PASS = 'TecnoCaja95';

  function buildAppWithEcf(ecfService) {
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use('/api/servicios', createServiciosRouter({
      query: jest.fn().mockResolvedValue([]),
      withTransaction: async (fn) => fn({ query: jest.fn().mockResolvedValue([]) }),
      resolveRequestActorUser: jest.fn().mockResolvedValue({ id: 1, usuario: 'admin', role_code: 'administrador_general' }),
      userRoleHasPermission: jest.fn().mockReturnValue(true),
      writeAuditLog: jest.fn().mockResolvedValue(),
      getUserScopeBranchId: () => null,
      isGlobalAdministratorUser: () => true,
      isBranchAdministratorUser: () => false,
      getConfig: jest.fn().mockResolvedValue({ serviceCompany: true, nombre: 'TECNO SRL', rnc: '131-12345-6', direccion: 'SDQ' }),
      getNextNcfFromSequence: jest.fn(),
      ecfService,
    }));
    return app;
  }

  async function tinyPdfBase64() {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 400]).drawText('Factura de prueba', { x: 20, y: 360, size: 12, font: f });
    return Buffer.from(await doc.save()).toString('base64');
  }

  it('firma-estado indica que no hay certificado si el módulo e-CF no está disponible', async () => {
    const app = buildAppWithEcf(undefined);
    const res = await request(app).get('/api/servicios/documento/firma-estado');
    expect(res.status).toBe(200);
    expect(res.body.hasCertificate).toBe(false);
  });

  it('config acepta y persiste el flag autoSign', async () => {
    const store = {};
    const mockQuery = jest.fn().mockImplementation(async (sql, params) => {
      if (/^UPDATE config SET/i.test(sql)) {
        if (/service_autosign/i.test(sql)) store.autosign = params[params.length - 1];
        return { affectedRows: 1 };
      }
      if (/^SELECT .*service_autosign.* FROM config/is.test(sql)) return [{ service_autosign: store.autosign ?? 0 }];
      return [];
    });
    const { app } = buildApp({ query: mockQuery, config: { serviceCompany: true } });
    const put = await request(app).put('/api/servicios/config').send({ autoSign: true });
    expect(put.status).toBe(200);
    expect(store.autosign).toBe(1);
    const get = await request(app).get('/api/servicios/config');
    expect(get.body.autoSign).toBe(true);
  });

  it('firmar sin pdfBase64 responde 400', async () => {
    const app = buildAppWithEcf(undefined);
    const res = await request(app).post('/api/servicios/documento/firmar').send({});
    expect(res.status).toBe(400);
  });

  it('firmar sin certificado devuelve ok:false reason no-cert (no 500)', async () => {
    const app = buildAppWithEcf({ getCertificateStatus: async () => ({ hasCertificate: false }) });
    const res = await request(app).post('/api/servicios/documento/firmar').send({ pdfBase64: await tinyPdfBase64() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'no-cert', message: expect.any(String) });
  });

  it('el documento con ?firmar=1 estampa el bloque de firma si el .p12 está vigente', async () => {
    const mockQuery = jest.fn().mockImplementation(async (sql) => {
      if (/FROM svc_quotations q/i.test(sql) && /q\.id = \?/.test(sql)) {
        return [{ id: 7, numero: 'COT-000007', client_id: null, client_name: 'ACME', branch_id: null,
          fecha: '2026-09-05', validez_dias: 15, estado: 'enviada', subtotal: 100, descuento: 0, itbis: 18, total: 118 }];
      }
      if (/FROM svc_quotation_items/i.test(sql)) return [{ id: 1, quotation_id: 7, descripcion: 'Servicio', cantidad: 1, precio: 100, itbis_pct: 18, total: 118 }];
      if (/service_autosign/i.test(sql)) return [{ service_autosign: 0 }];
      return [];
    });
    const app = express();
    app.use(express.json());
    app.use('/api/servicios', createServiciosRouter({
      query: mockQuery,
      withTransaction: async (fn) => fn({ query: mockQuery }),
      resolveRequestActorUser: jest.fn().mockResolvedValue({ id: 1, role_code: 'administrador_general' }),
      userRoleHasPermission: jest.fn().mockReturnValue(true),
      writeAuditLog: jest.fn().mockResolvedValue(),
      getUserScopeBranchId: () => null,
      isGlobalAdministratorUser: () => true,
      isBranchAdministratorUser: () => false,
      getConfig: jest.fn().mockResolvedValue({ serviceCompany: true, nombre: 'TECNO SRL', rnc: '131-98765-4' }),
      getNextNcfFromSequence: jest.fn(),
      ecfService: { getCertificateStatus: async () => ({ hasCertificate: true, status: 'valido', isExpired: false }) },
    }));
    const res = await request(app).get('/api/servicios/cotizaciones/7/documento?formato=a4&firmar=1');
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('FIRMADO DIGITALMENTE');
    expect(res.body.html).toContain('TECNO SRL');
    expect(res.body.html).toContain('RNC 131987654');
  });

  it('guardar-firmado rechaza un PDF sin firma y acepta uno firmado; luego GET lo devuelve', async () => {
    const { PDFDocument } = require('pdf-lib');
    const store = {};
    const mockQuery = jest.fn().mockImplementation(async (sql, params) => {
      if (/^UPDATE svc_invoices SET signed_pdf = \?/i.test(sql)) { store.pdf = params[0]; return { affectedRows: 1 }; }
      if (/SELECT signed_pdf, signed_at FROM svc_invoices/i.test(sql)) return store.pdf ? [{ signed_pdf: store.pdf, signed_at: '2026-09-05 12:00:00' }] : [];
      return [];
    });
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use('/api/servicios', createServiciosRouter({
      query: mockQuery,
      withTransaction: async (fn) => fn({ query: mockQuery }),
      resolveRequestActorUser: jest.fn().mockResolvedValue({ id: 1, role_code: 'administrador_general' }),
      userRoleHasPermission: jest.fn().mockReturnValue(true),
      writeAuditLog: jest.fn().mockResolvedValue(),
      getUserScopeBranchId: () => null,
      isGlobalAdministratorUser: () => true,
      isBranchAdministratorUser: () => false,
      getConfig: jest.fn().mockResolvedValue({ serviceCompany: true }),
      getNextNcfFromSequence: jest.fn(),
    }));

    const plain = Buffer.from(await (await PDFDocument.create()).save()).toString('base64');
    const noSign = await request(app).post('/api/servicios/documento/facturas/5/guardar-firmado').send({ pdfBase64: plain });
    expect(noSign.status).toBe(400);

    // Un "PDF firmado" de mentira: base64 de bytes que empiezan por %PDF y traen /ByteRange [
    const fakeSigned = Buffer.from('%PDF-1.7\n/Type /Sig /ByteRange [0 100 200 300]\n%%EOF').toString('base64');
    const ok = await request(app).post('/api/servicios/documento/facturas/5/guardar-firmado').send({ pdfBase64: fakeSigned });
    expect(ok.status).toBe(200);
    expect(store.pdf).toBe(fakeSigned);

    const got = await request(app).get('/api/servicios/documento/facturas/5/firmado');
    expect(got.status).toBe(200);
    expect(got.body.pdfBase64).toBe(fakeSigned);
  });

  it('firmado devuelve 404 si no hay PDF guardado', async () => {
    const { app } = buildApp({ query: jest.fn().mockResolvedValue([]), config: { serviceCompany: true } });
    const res = await request(app).get('/api/servicios/documento/cotizaciones/9/firmado');
    expect(res.status).toBe(404);
  });

  (fs.existsSync(P12) ? it : it.skip)('firma el PDF con el .p12 y devuelve un PDF con /ByteRange resuelto', async () => {
    const ecfService = {
      getCertificateStatus: async () => ({ hasCertificate: true, status: 'valido', isExpired: false }),
      resolveCertificate: async () => ({ certPath: P12, certPassword: P12_PASS }),
    };
    const app = buildAppWithEcf(ecfService);
    const res = await request(app).post('/api/servicios/documento/firmar').send({ pdfBase64: await tinyPdfBase64() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const signed = Buffer.from(res.body.signedBase64, 'base64').toString('latin1');
    expect(signed).toMatch(/\/Type\s*\/Sig/);
    expect(signed).toMatch(/\/ByteRange\s*\[/);
    expect(signed).not.toMatch(/\/ByteRange\s*\[[^\]]*\*/); // sin placeholder **
    expect(signed).toContain('adbe.pkcs7.detached');
  });
});
