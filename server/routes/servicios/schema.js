'use strict';

/**
 * schema.js — Esquema del modo "Empresa de Servicios" (M1 núcleo).
 *
 * Prefijo svc_. Todas las tablas llevan branch_id + cash_register_id (terminal) +
 * created_by_user_id para trazabilidad/auditoría (spec §3, §4, §5). Las FK a
 * branches/clients/users son nullable con ON DELETE SET NULL — un FK NOT NULL +
 * SET NULL revienta en MySQL (no en sqlite), ver memoria de Tesorería.
 *
 * Idempotente (CREATE TABLE IF NOT EXISTS + addColumnIfMissing). Se llama desde
 * server.js dentro de runCoreSchemaMigrations y también de forma perezosa en el
 * router (primer request) por si la migración aún no corrió.
 */

async function hasColumn(query, table, column) {
  const rows = await query(`PRAGMA table_info(${table})`).catch(() => []);
  return rows.some((r) => String(r.name || r.Field || '').toLowerCase() === String(column).toLowerCase());
}

async function addColumnIfMissing(query, table, column, definition) {
  try {
    if (await hasColumn(query, table, column)) return;
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('no such table') && !message.includes("doesn't exist")) throw error;
  }
}

async function ensureServiciosSchema(query) {
  // ── Config: correo saliente para facturas de servicios (Gmail) ───────────
  await addColumnIfMissing(query, 'config', 'service_mail_user', 'VARCHAR(160) DEFAULT NULL');
  await addColumnIfMissing(query, 'config', 'service_mail_pass', 'VARCHAR(255) DEFAULT NULL');
  await addColumnIfMissing(query, 'config', 'service_mail_from', 'VARCHAR(160) DEFAULT NULL');
  // Espejo de la factura de servicios en la tabla `sales` del POS (para que los
  // Reportes/Dashboard/sync del contador la vean como una venta normal).
  await addColumnIfMissing(query, 'svc_invoices', 'sale_id', 'INT DEFAULT NULL');

  // ── Catálogo de servicios ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS svc_service_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre VARCHAR(120) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(40) DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      descripcion TEXT DEFAULT NULL,
      categoria_id INT DEFAULT NULL,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      unidad VARCHAR(40) NOT NULL DEFAULT 'servicio',
      duracion_min INT DEFAULT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_svc_services_cat FOREIGN KEY (categoria_id) REFERENCES svc_service_categories(id) ON DELETE SET NULL
    )
  `);

  // ── Cotizaciones ─────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS svc_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      client_rnc VARCHAR(40) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      fecha DATE NOT NULL,
      validez_dias INT NOT NULL DEFAULT 15,
      estado VARCHAR(20) NOT NULL DEFAULT 'borrador',
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      notas TEXT DEFAULT NULL,
      condiciones TEXT DEFAULT NULL,
      converted_invoice_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_quo_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_quo_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INT NOT NULL,
      service_id INT DEFAULT NULL,
      descripcion VARCHAR(255) NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL DEFAULT 1,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      CONSTRAINT fk_svc_quoit_quo FOREIGN KEY (quotation_id) REFERENCES svc_quotations(id) ON DELETE CASCADE
    )
  `);

  // ── Facturación de servicios ─────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS svc_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      quotation_id INT DEFAULT NULL,
      origin_type VARCHAR(20) NOT NULL DEFAULT 'directa',
      origin_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      client_rnc VARCHAR(40) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      fecha DATE NOT NULL,
      vencimiento DATE DEFAULT NULL,
      condicion_pago VARCHAR(30) NOT NULL DEFAULT 'contado',
      fiscal_mode VARCHAR(10) NOT NULL DEFAULT 'ncf',
      ncf VARCHAR(30) DEFAULT NULL,
      ncf_tipo VARCHAR(10) DEFAULT NULL,
      ncf_vencimiento DATE DEFAULT NULL,
      ecf_status VARCHAR(20) DEFAULT NULL,
      subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      itbis DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      pagado DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      anulada_at DATETIME DEFAULT NULL,
      anulada_by_user_name VARCHAR(120) DEFAULT NULL,
      motivo_anulacion VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_inv_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_inv_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INT NOT NULL,
      service_id INT DEFAULT NULL,
      descripcion VARCHAR(255) NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL DEFAULT 1,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      descuento_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      itbis_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      CONSTRAINT fk_svc_invit_inv FOREIGN KEY (invoice_id) REFERENCES svc_invoices(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_invoice_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INT NOT NULL,
      fecha DATE NOT NULL,
      monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      metodo VARCHAR(30) NOT NULL DEFAULT 'efectivo',
      referencia VARCHAR(120) DEFAULT NULL,
      notas VARCHAR(255) DEFAULT NULL,
      is_anticipo TINYINT(1) NOT NULL DEFAULT 0,
      branch_id INT DEFAULT NULL,
      cash_register_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      anulado_at DATETIME DEFAULT NULL,
      anulado_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_pay_inv FOREIGN KEY (invoice_id) REFERENCES svc_invoices(id) ON DELETE CASCADE
    )
  `);

  // ═══ M2 — Contratos, Órdenes de trabajo, Proyectos, Calendario ═══════════
  await query(`
    CREATE TABLE IF NOT EXISTS svc_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      titulo VARCHAR(200) NOT NULL,
      descripcion TEXT DEFAULT NULL,
      fecha_inicio DATE DEFAULT NULL,
      fecha_fin DATE DEFAULT NULL,
      monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      frecuencia VARCHAR(20) NOT NULL DEFAULT 'mensual',
      estado VARCHAR(20) NOT NULL DEFAULT 'activo',
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_ct_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_ct_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      contract_id INT DEFAULT NULL,
      titulo VARCHAR(200) NOT NULL,
      descripcion TEXT DEFAULT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'servicio',
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      prioridad VARCHAR(10) NOT NULL DEFAULT 'normal',
      responsable_id INT DEFAULT NULL,
      responsable_nombre VARCHAR(160) DEFAULT NULL,
      fecha_programada DATE DEFAULT NULL,
      hora VARCHAR(10) DEFAULT NULL,
      ubicacion VARCHAR(255) DEFAULT NULL,
      materiales TEXT DEFAULT NULL,
      observaciones TEXT DEFAULT NULL,
      evidencias TEXT DEFAULT NULL,
      firma_cliente TEXT DEFAULT NULL,
      completada_at DATETIME DEFAULT NULL,
      invoice_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_wo_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_wo_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_work_order_assignees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INT NOT NULL,
      employee_id INT DEFAULT NULL,
      employee_name VARCHAR(160) NOT NULL,
      rol VARCHAR(60) DEFAULT NULL,
      CONSTRAINT fk_svc_woa_order FOREIGN KEY (order_id) REFERENCES svc_work_orders(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      descripcion TEXT DEFAULT NULL,
      presupuesto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      fecha_inicio DATE DEFAULT NULL,
      fecha_entrega DATE DEFAULT NULL,
      responsable_id INT DEFAULT NULL,
      responsable_nombre VARCHAR(160) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'planificacion',
      avance_pct INT NOT NULL DEFAULT 0,
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_pr_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_pr_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INT NOT NULL,
      titulo VARCHAR(200) NOT NULL,
      descripcion TEXT DEFAULT NULL,
      asignado_id INT DEFAULT NULL,
      asignado_nombre VARCHAR(160) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      fecha_limite DATE DEFAULT NULL,
      orden INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      done_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_svc_pt_project FOREIGN KEY (project_id) REFERENCES svc_projects(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_project_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INT NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      categoria VARCHAR(60) DEFAULT NULL,
      monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      fecha DATE NOT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_pe_project FOREIGN KEY (project_id) REFERENCES svc_projects(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS svc_scheduled_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      service_id INT DEFAULT NULL,
      titulo VARCHAR(200) NOT NULL,
      fecha DATE NOT NULL,
      hora VARCHAR(10) DEFAULT NULL,
      recurrencia VARCHAR(20) NOT NULL DEFAULT 'unica',
      empleado_id INT DEFAULT NULL,
      empleado_nombre VARCHAR(160) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'programado',
      notas TEXT DEFAULT NULL,
      work_order_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_ss_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);

  // ═══ M3 — Verticales especializados ═════════════════════════════════════
  // Seguridad
  await query(`
    CREATE TABLE IF NOT EXISTS svc_security_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      contract_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      ubicacion VARCHAR(255) DEFAULT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'fijo',
      turnos_por_dia INT NOT NULL DEFAULT 1,
      guardias_requeridos INT NOT NULL DEFAULT 1,
      tarifa_mensual DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'activo',
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_sp_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_guard_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INT NOT NULL,
      employee_id INT DEFAULT NULL,
      employee_name VARCHAR(160) NOT NULL,
      fecha DATE NOT NULL,
      turno VARCHAR(20) NOT NULL DEFAULT 'diurno',
      hora_inicio VARCHAR(10) DEFAULT NULL,
      hora_fin VARCHAR(10) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'programado',
      notas VARCHAR(255) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_gs_post FOREIGN KEY (post_id) REFERENCES svc_security_posts(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_security_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      fecha DATE NOT NULL,
      hora VARCHAR(10) DEFAULT NULL,
      tipo VARCHAR(60) DEFAULT NULL,
      gravedad VARCHAR(20) NOT NULL DEFAULT 'media',
      descripcion TEXT NOT NULL,
      reportado_por VARCHAR(160) DEFAULT NULL,
      acciones TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_si_post FOREIGN KEY (post_id) REFERENCES svc_security_posts(id) ON DELETE SET NULL
    )
  `);

  // Mantenimiento
  await query(`
    CREATE TABLE IF NOT EXISTS svc_equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      tipo VARCHAR(80) DEFAULT NULL,
      marca VARCHAR(120) DEFAULT NULL,
      modelo VARCHAR(120) DEFAULT NULL,
      serie VARCHAR(120) DEFAULT NULL,
      ubicacion VARCHAR(255) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'operativo',
      ultima_revision DATE DEFAULT NULL,
      proxima_revision DATE DEFAULT NULL,
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      CONSTRAINT fk_svc_eq_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_maintenance_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      titulo VARCHAR(200) NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'preventivo',
      frecuencia VARCHAR(20) NOT NULL DEFAULT 'mensual',
      proxima_fecha DATE DEFAULT NULL,
      checklist TEXT DEFAULT NULL,
      responsable_id INT DEFAULT NULL,
      responsable_nombre VARCHAR(160) DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'activo',
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_mp_eq FOREIGN KEY (equipment_id) REFERENCES svc_equipment(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_equipment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INT NOT NULL,
      fecha DATE NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'preventivo',
      descripcion TEXT NOT NULL,
      work_order_id INT DEFAULT NULL,
      tecnico VARCHAR(160) DEFAULT NULL,
      materiales TEXT DEFAULT NULL,
      costo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_eh_eq FOREIGN KEY (equipment_id) REFERENCES svc_equipment(id) ON DELETE CASCADE
    )
  `);

  // Agencia de viajes
  await query(`
    CREATE TABLE IF NOT EXISTS svc_travelers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      documento_tipo VARCHAR(20) NOT NULL DEFAULT 'pasaporte',
      documento_numero VARCHAR(60) DEFAULT NULL,
      nacionalidad VARCHAR(80) DEFAULT NULL,
      fecha_nacimiento DATE DEFAULT NULL,
      telefono VARCHAR(40) DEFAULT NULL,
      email VARCHAR(160) DEFAULT NULL,
      notas TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_tv_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      titulo VARCHAR(200) NOT NULL,
      destino VARCHAR(160) DEFAULT NULL,
      fecha_salida DATE DEFAULT NULL,
      fecha_regreso DATE DEFAULT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'cotizada',
      costo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      anticipo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      saldo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      proveedor_principal VARCHAR(160) DEFAULT NULL,
      notas TEXT DEFAULT NULL,
      invoice_id INT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_rs_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      CONSTRAINT fk_svc_rs_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_reservation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INT NOT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'vuelo',
      descripcion VARCHAR(255) NOT NULL,
      proveedor VARCHAR(160) DEFAULT NULL,
      fecha_inicio DATE DEFAULT NULL,
      fecha_fin DATE DEFAULT NULL,
      costo DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      confirmacion VARCHAR(120) DEFAULT NULL,
      notas VARCHAR(255) DEFAULT NULL,
      CONSTRAINT fk_svc_ri_res FOREIGN KEY (reservation_id) REFERENCES svc_reservations(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_reservation_travelers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INT NOT NULL,
      traveler_id INT DEFAULT NULL,
      traveler_name VARCHAR(200) NOT NULL,
      CONSTRAINT fk_svc_rt_res FOREIGN KEY (reservation_id) REFERENCES svc_reservations(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INT DEFAULT NULL,
      item_id INT DEFAULT NULL,
      descripcion VARCHAR(255) NOT NULL,
      base DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      fecha DATE DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_cm_res FOREIGN KEY (reservation_id) REFERENCES svc_reservations(id) ON DELETE SET NULL
    )
  `);

  // Agencia de publicidad — campañas
  await query(`
    CREATE TABLE IF NOT EXISTS svc_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      project_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      objetivo TEXT DEFAULT NULL,
      canal VARCHAR(20) NOT NULL DEFAULT 'mixto',
      fecha_inicio DATE DEFAULT NULL,
      fecha_fin DATE DEFAULT NULL,
      presupuesto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      estado VARCHAR(20) NOT NULL DEFAULT 'planificacion',
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_cp_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_campaign_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INT NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      categoria VARCHAR(30) NOT NULL DEFAULT 'pauta',
      monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      fecha DATE NOT NULL,
      proveedor VARCHAR(160) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_ce_camp FOREIGN KEY (campaign_id) REFERENCES svc_campaigns(id) ON DELETE CASCADE
    )
  `);

  // Arquitectura e ingeniería — obras
  await query(`
    CREATE TABLE IF NOT EXISTS svc_construction_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero VARCHAR(40) NOT NULL,
      project_id INT DEFAULT NULL,
      client_id INT DEFAULT NULL,
      client_name VARCHAR(200) DEFAULT NULL,
      branch_id INT DEFAULT NULL,
      nombre VARCHAR(200) NOT NULL,
      direccion VARCHAR(255) DEFAULT NULL,
      tipo VARCHAR(20) NOT NULL DEFAULT 'residencial',
      fecha_inicio DATE DEFAULT NULL,
      fecha_fin_estimada DATE DEFAULT NULL,
      presupuesto DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      avance_pct INT NOT NULL DEFAULT 0,
      estado VARCHAR(20) NOT NULL DEFAULT 'en_curso',
      responsable_id INT DEFAULT NULL,
      responsable_nombre VARCHAR(160) DEFAULT NULL,
      notas TEXT DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT NULL,
      UNIQUE (numero),
      CONSTRAINT fk_svc_cs_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_site_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INT NOT NULL,
      fecha DATE NOT NULL,
      avance_pct INT NOT NULL DEFAULT 0,
      descripcion TEXT DEFAULT NULL,
      hitos TEXT DEFAULT NULL,
      reportado_por VARCHAR(160) DEFAULT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_spg_site FOREIGN KEY (site_id) REFERENCES svc_construction_sites(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS svc_site_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INT NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      cantidad DECIMAL(12,2) NOT NULL DEFAULT 1,
      unidad VARCHAR(40) DEFAULT NULL,
      costo_unit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      costo_total DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      proveedor VARCHAR(160) DEFAULT NULL,
      fecha DATE NOT NULL,
      created_by_user_id INT DEFAULT NULL,
      created_by_user_name VARCHAR(120) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_svc_sm_site FOREIGN KEY (site_id) REFERENCES svc_construction_sites(id) ON DELETE CASCADE
    )
  `);

  // Contador de folios por documento (numero interno FAC-/COT- antes del NCF).
  await query(`
    CREATE TABLE IF NOT EXISTS svc_doc_counters (
      doc_type VARCHAR(20) PRIMARY KEY,
      prefix VARCHAR(12) NOT NULL,
      next_number INT NOT NULL DEFAULT 1
    )
  `);
  for (const [docType, prefix] of [
    ['quotation', 'COT-'], ['invoice', 'FAC-'],
    ['contract', 'CTR-'], ['workorder', 'OT-'], ['project', 'PRY-'],
    ['post', 'PST-'], ['reservation', 'RES-'], ['campaign', 'CMP-'], ['site', 'OBR-'],
  ]) {
    await query(
      `INSERT OR IGNORE INTO svc_doc_counters (doc_type, prefix, next_number) VALUES (?, ?, 1)`,
      [docType, prefix]
    ).catch(async () => {
      // MySQL no soporta INSERT OR IGNORE
      const [row] = await query('SELECT doc_type FROM svc_doc_counters WHERE doc_type = ? LIMIT 1', [docType]);
      if (!row) await query('INSERT INTO svc_doc_counters (doc_type, prefix, next_number) VALUES (?, ?, 1)', [docType, prefix]);
    });
  }
}

// Toma y consume el siguiente folio interno (COT-000123 / FAC-000123).
// `conn` es una conexión de transacción activa (mismo patrón que getNextNcfFromSequence).
async function nextServiceDocNumber(conn, docType) {
  const runner = conn && conn.query ? conn.query.bind(conn) : null;
  if (!runner) throw new Error('nextServiceDocNumber requiere una conexión de transacción.');
  const rows = await runner('SELECT prefix, next_number FROM svc_doc_counters WHERE doc_type = ? LIMIT 1', [docType]);
  const row = rows[0] || { prefix: docType === 'invoice' ? 'FAC-' : 'COT-', next_number: 1 };
  const n = Number(row.next_number || 1);
  await runner('UPDATE svc_doc_counters SET next_number = ? WHERE doc_type = ?', [n + 1, docType]);
  return `${row.prefix}${String(n).padStart(6, '0')}`;
}

module.exports = { ensureServiciosSchema, nextServiceDocNumber, addColumnIfMissing };
