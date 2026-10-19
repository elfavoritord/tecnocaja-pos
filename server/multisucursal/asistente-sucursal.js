'use strict';

/**
 * server/multisucursal/asistente-sucursal.js — Asistente inicial de una PC
 * nueva que trabaja como sucursal de una empresa. Sin código de equipo:
 *
 *   1. El dueño del negocio entra con su cuenta de Tecno Caja (correo y
 *      contraseña, o Google) → empresasDelDueno() lista sus sucursales.
 *   2. Elige en cuál trabaja esta PC → unirse():
 *        a. enlaza la PC con la central (token de la Sync API);
 *        b. configura la base local desde cero como esa sucursal, con el
 *           perfil de la principal (tipo de negocio, moneda, ITBIS, RNC) y un
 *           administrador general para el dueño con su misma contraseña;
 *        c. registra la licencia propia de esta PC (cada PC de sucursal
 *           conserva la suya; lo que la ata a la empresa es el enlace);
 *        d. primera sincronización: llegan los usuarios de la sucursal, el
 *           catálogo de la empresa y los rangos NCF.
 *   3. La PC queda en la pantalla de entrada: entra el usuario que se creó
 *      para esa sucursal en la principal, abre su caja y vende.
 *
 * Solo mientras la PC está sin configurar (no hay sesión que pedir todavía).
 */

// Lo mismo que vacía /api/setup/complete (server.js) antes de configurar.
const TABLAS_A_VACIAR = [
  'sale_items', 'sales', 'cash_closings', 'cash_openings', 'cash_movements', 'cash_sessions',
  'branch_transfer_items', 'branch_transfers', 'inventory_movements', 'inventory_by_branch',
  'supplier_invoices', 'suppliers', 'clients', 'products', 'categories', 'suspended_sales',
  'quotations', 'dining_tables', 'delivery_locations', 'audit_logs', 'users', 'cash_registers', 'branches',
];

const TIPO_POR_DEFECTO = 'colmado';
const MONEDA_POR_DEFECTO = 'RD$';
const ITBIS_POR_DEFECTO = 18;
const DIAS_DE_PRUEBA = 30;

class ErrorAsistente extends Error {
  constructor(mensaje, codigo, status = 400) {
    super(mensaje);
    this.code = codigo;
    this.statusCode = status;
  }
}

function texto(valor, max) {
  return String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ').slice(0, max);
}

// Usuario local del dueño: la parte del correo antes de la @.
function usuarioDelCorreo(email) {
  const base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
  return base.length >= 3 ? base : 'dueno';
}

function sqlFecha(fecha) {
  return fecha.toISOString().slice(0, 19).replace('T', ' ');
}

function createAsistenteSucursal({
  query,
  withTransaction,
  multisucursal,
  getSetupStatus,
  crearHashClave,
  hayFormateoPendiente = () => false,
  esMysql = () => false,
  // Tablas que el arranque crea solo cuando hacen falta (ver /api/setup/complete).
  prepararTablas = async () => {},
  guardarTerminal = () => {},
  // Licencia propia de esta PC en Firestore (registerPosLicenseInFirestore).
  registrarLicencia = async () => null,
  // MariaDB: publicar la base en la red para las demás cajas de la sucursal.
  prepararRedLan = async () => null,
  tiposDeNegocio = () => [TIPO_POR_DEFECTO],
  monedas = () => [MONEDA_POR_DEFECTO],
  esEmpresaDeServicios = () => false,
  limpiarCaches = () => {},
  auditar = async () => {},
  logger = console,
  esperaPrimeraSincronizacionMs = 60000,
  now = () => new Date(),
}) {
  async function exigirSinConfigurar() {
    if (hayFormateoPendiente()) {
      throw new ErrorAsistente('Reinicia Tecno Caja para terminar el formateo antes de configurar la PC.', 'FORMATEO_PENDIENTE', 409);
    }
    const estado = await getSetupStatus();
    if (!estado?.setupRequired) {
      throw new ErrorAsistente(
        'Esta PC ya está configurada. Conéctala desde Configuración → Mi Negocio → Sucursal conectada a Tecno Caja.',
        'YA_CONFIGURADA', 409
      );
    }
    return estado;
  }

  async function empresasDelDueno(idToken) {
    await exigirSinConfigurar();
    const r = await multisucursal.enlace.empresasDelDueno(idToken);
    return { dueno: r.dueno || null, empresas: Array.isArray(r.empresas) ? r.empresas : [] };
  }

  // La sucursal elegida, revisada ANTES de enlazar: enlazar deja fuera a la PC
  // que la tenía, y la principal es la PC donde ya trabaja el negocio.
  async function sucursalElegida(idToken, licenseId, branchUuid) {
    const { empresas } = await empresasDelDueno(idToken);
    const empresa = empresas.find((e) => e.licenseId === licenseId);
    const sucursal = empresa?.sucursales?.find((s) => s.branchUuid === branchUuid);
    if (!empresa || !sucursal) throw new ErrorAsistente('Esa sucursal ya no está en tu empresa. Vuelve a entrar.', 'NO_ENCONTRADA', 404);
    if (empresa.activa === false) throw new ErrorAsistente('La licencia de la empresa no está activa.', 'LICENCIA_INACTIVA', 403);
    if (sucursal.estado !== 'activa') throw new ErrorAsistente('Esa sucursal está desactivada.', 'SUCURSAL_INACTIVA', 409);
    if (sucursal.esPrincipal) {
      throw new ErrorAsistente(
        'La sucursal principal es la PC donde ya trabaja tu negocio: conéctala desde su Configuración → Mi Negocio → Sucursal conectada a Tecno Caja. Aquí elige otra sucursal.',
        'ES_PRINCIPAL', 409
      );
    }
    return { empresa, sucursal };
  }

  function perfilLocal(perfil = {}) {
    const tipos = tiposDeNegocio();
    const tipo = String(perfil?.tipoNegocio || '').trim().toLowerCase();
    const moneda = String(perfil?.moneda || '').trim();
    const itbis = Number(perfil?.itbis);
    return {
      tipoNegocio: tipos.includes(tipo) ? tipo : (tipos.includes(TIPO_POR_DEFECTO) ? TIPO_POR_DEFECTO : tipos[0]),
      moneda: monedas().includes(moneda) ? moneda : MONEDA_POR_DEFECTO,
      itbis: Number.isFinite(itbis) && itbis >= 0 && itbis <= 100 ? itbis : ITBIS_POR_DEFECTO,
      rnc: String(perfil?.rnc || '').replace(/\D/g, '').slice(0, 11),
    };
  }

  // Base local desde cero como la sucursal elegida. La caja queda cerrada: el
  // cajero la abre con su monto al entrar (como cualquier día).
  async function configurarBase({ nombreNegocio, sucursal, perfil, modo, dueno, claveRed, inicio, finPrueba }) {
    await prepararTablas();
    return withTransaction(async (conn) => {
      for (const tabla of TABLAS_A_VACIAR) {
        await conn.query(`DELETE FROM ${tabla}`);
      }
      const negocio = await conn.query('SELECT business_id FROM config WHERE id = 1 LIMIT 1');
      const businessId = Number(negocio[0]?.business_id || 0) || null;
      if (businessId) {
        await conn.query(
          "UPDATE businesses SET nombre = ?, rnc = ?, direccion = ?, telefono = ?, estado = 'Activo' WHERE id = ?",
          [nombreNegocio, perfil.rnc || null, sucursal.direccion || null, sucursal.telefono || null, businessId]
        );
      }
      await conn.query(
        `UPDATE config
            SET business_name = ?, rnc = ?, address = ?, phone = ?, currency = ?, tax_rate = ?,
                invoice_prefix = 'FAC-', invoice_next_number = 1001, e_invoice_enabled = 1, e_invoice_prefix = 'ECF-',
                e_invoice_next_number = 1, receipt_message = '¡Gracias por su compra!', receipt_print_mode = 'dialog',
                receipt_printer_name = NULL, receipt_paper_size = '80mm', app_logo = NULL,
                active_branch_id = NULL, active_cash_register_id = NULL, cash_open = 0, cash_amount = 0, language = 'es',
                business_type = ?, business_structure_mode = ?, install_network_key = ?, starter_catalog_seeded = 1,
                setup_completed = 1, setup_completed_at = datetime('now'),
                trial_started_at = ?, trial_ends_at = ?, license_status = 'trial', license_activated_at = NULL,
                license_activated_by = NULL, require_cash_open_before_use = 1
          WHERE id = 1`,
        [
          nombreNegocio, perfil.rnc, sucursal.direccion || '', sucursal.telefono || '', perfil.moneda, perfil.itbis,
          perfil.tipoNegocio, modo, claveRed ? crearHashClave(claveRed) : null, sqlFecha(inicio), sqlFecha(finPrueba),
        ]
      );
      if (esEmpresaDeServicios(perfil.tipoNegocio)) {
        await conn.query(
          `UPDATE config
              SET service_company = 1, service_vertical = ?, service_invoice_default_format = 'a4', service_fiscal_mode = 'ncf',
                  require_cash_open_before_use = 0, cashier_register_required = 0, exclusive_cashier_per_register = 0
            WHERE id = 1`,
          [perfil.tipoNegocio]
        );
      }

      // El nombre, el código y los datos reales los pone el enlace con la
      // central (aplicarIdentidad) en cuanto termina esto.
      const sucursalLocal = await conn.query(
        "INSERT INTO branches (business_id, nombre, codigo, direccion, telefono, encargado, estado, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Activa', datetime('now'))",
        [businessId, texto(sucursal.nombre, 160) || 'Sucursal', 'SUC-001', sucursal.direccion || null, sucursal.telefono || null, sucursal.encargado || null]
      );
      const branchId = Number(sucursalLocal.insertId || 0) || 1;
      const caja = await conn.query(
        "INSERT INTO cash_registers (branch_id, nombre, codigo, estado, created_at) VALUES (?, 'Caja Principal', 'CAJ-001', 'Activa', datetime('now'))",
        [branchId]
      );
      const cashRegisterId = Number(caja.insertId || 0) || 1;
      await conn.query('UPDATE config SET active_branch_id = ?, active_cash_register_id = ? WHERE id = 1', [branchId, cashRegisterId]);

      // El dueño entra a esta PC con su usuario y su misma contraseña. Sin
      // correo: su cuenta de Tecno Caja es la de la principal y las
      // sincronizaciones de esta PC no deben tocarla.
      const rol = await conn.query("SELECT id FROM roles WHERE codigo = 'administrador_general' LIMIT 1");
      const usuario = await conn.query(
        `INSERT INTO users
          (usuario, email, password, password_hash, nombre, rol, role_id, branch_id, sucursal_id, caja_id, estado, last_login,
           linked_client_id, account_type, auth_provider, firebase_uid, creado_por, fecha_creacion)
         VALUES (?, NULL, '', ?, ?, 'Administrador', ?, ?, ?, NULL, 'Activo', '—', NULL, 'staff', 'local', NULL, NULL, datetime('now'))`,
        [dueno.usuario, crearHashClave(dueno.clave), dueno.nombre, Number(rol[0]?.id || 0) || null, branchId, branchId]
      );
      return { branchId, cashRegisterId, userId: usuario.insertId };
    });
  }

  // Espera la primera sincronización (usuarios primero) hasta un tope: con un
  // catálogo grande sigue sola en segundo plano.
  async function primeraSincronizacion() {
    let reloj;
    const tope = new Promise((resolve) => {
      reloj = setTimeout(() => resolve({ resultado: 'en_curso' }), esperaPrimeraSincronizacionMs);
      if (typeof reloj.unref === 'function') reloj.unref();
    });
    try {
      return await Promise.race([multisucursal.sincronizacion.ciclo(), tope]);
    } catch (error) {
      return { resultado: 'error', error: error.message };
    } finally {
      clearTimeout(reloj);
    }
  }

  async function unirse({ idToken, licenseId, branchUuid, nombre, email, clave, claveRed } = {}) {
    await exigirSinConfigurar();
    const claveDueno = String(clave || '');
    if (claveDueno.length < 4) throw new ErrorAsistente('Escribe la contraseña del dueño.', 'DATOS_INVALIDOS');
    const mysql = esMysql();
    const claveDeRed = String(claveRed || '').trim();
    if (mysql && claveDeRed.length < 6) {
      throw new ErrorAsistente('La clave de red (para las demás cajas de esta sucursal) debe tener al menos 6 caracteres.', 'DATOS_INVALIDOS');
    }
    const { empresa, sucursal } = await sucursalElegida(idToken, String(licenseId || ''), String(branchUuid || ''));

    // a. Enlace primero: si falla, la PC queda igual que antes (sin configurar).
    const enlace = await multisucursal.enlace.activarConDueno({ idToken, licenseId: empresa.licenseId, branchUuid: sucursal.branchUuid, baseNueva: true });

    // b. Base local.
    const perfil = perfilLocal(enlace.perfil || empresa.perfil);
    const nombreNegocio = texto(`${empresa.nombre} · ${sucursal.nombre}`, 150);
    const modo = mysql ? 'multicaja' : 'monocaja';
    const inicio = now();
    const finPrueba = new Date(inicio.getTime() + DIAS_DE_PRUEBA * 24 * 60 * 60 * 1000);
    const dueno = {
      usuario: usuarioDelCorreo(email || enlace.dueno?.email),
      nombre: texto(nombre, 120) || 'Dueño',
      clave: claveDueno,
    };
    const base = await configurarBase({ nombreNegocio, sucursal, perfil, modo, dueno, claveRed: mysql ? claveDeRed : '', inicio, finPrueba });
    limpiarCaches();
    guardarTerminal({
      branchId: base.branchId,
      branchName: sucursal.nombre,
      cashRegisterId: base.cashRegisterId,
      cashRegisterName: 'Caja Principal',
      setupMode: modo,
      linkedBy: dueno.usuario,
    });

    // c. Licencia propia de esta PC (sin el correo del dueño: su cuenta es la de
    //    la principal), marcada como sucursal de la empresa para los paneles.
    await Promise.resolve(registrarLicencia({
      businessName: nombreNegocio,
      trialEndsAt: finPrueba,
      businessStructureMode: modo,
      sucursalDe: {
        licenseId: empresa.licenseId,
        companyUuid: empresa.companyUuid || null,
        branchUuid: sucursal.branchUuid,
        empresa: empresa.nombre,
        sucursal: sucursal.nombre,
      },
    })).catch((error) => logger.warn?.('[asistente-sucursal] No se pudo registrar la licencia de esta PC:', error.message));
    const red = mysql ? await Promise.resolve(prepararRedLan()).catch((error) => ({ enabled: false, error: error.message })) : null;

    // d. Identidad sobre la base nueva (uuid y nombre de la sucursal) y primera
    //    sincronización.
    await multisucursal.prepararAlArrancar();
    await multisucursal.enlace.refrescarIdentidad();
    const ciclo = await primeraSincronizacion();
    limpiarCaches();

    await auditar({
      userId: base.userId,
      userName: dueno.nombre,
      userRole: 'Administrador',
      moduleName: 'Sistema',
      actionName: 'PC configurada como sucursal de la empresa',
      detail: `${empresa.nombre} · ${sucursal.nombre} · entró ${String(email || '').toLowerCase()} · prueba ${DIAS_DE_PRUEBA} días`,
    }).catch(() => {});

    const usuarios = await query("SELECT COUNT(*) AS n FROM users WHERE estado = 'Activo'").catch(() => [{ n: 0 }]);
    return {
      empresa: { nombre: empresa.nombre },
      sucursal: { nombre: sucursal.nombre },
      usuarioDueno: dueno.usuario,
      usuarios: Number(usuarios[0]?.n || 0),
      reemplazados: enlace.reemplazados || 0,
      sincronizacion: ciclo?.resultado || null,
      redLan: red,
    };
  }

  return { empresasDelDueno, unirse };
}

module.exports = { createAsistenteSucursal, ErrorAsistente, usuarioDelCorreo, TABLAS_A_VACIAR };
