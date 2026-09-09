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

function buildApp({ query, config, actor } = {}) {
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
