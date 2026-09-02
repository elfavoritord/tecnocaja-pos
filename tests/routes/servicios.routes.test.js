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
