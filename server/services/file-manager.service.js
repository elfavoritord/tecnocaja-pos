/**
 * file-manager.service.js
 * Gestiona la estructura de carpetas Sistema_Data, el registro de archivos
 * y operaciones de búsqueda, estadísticas y limpieza.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MONTHS_ES = [
  '01-Enero','02-Febrero','03-Marzo','04-Abril','05-Mayo','06-Junio',
  '07-Julio','08-Agosto','09-Septiembre','10-Octubre','11-Noviembre','12-Diciembre'
];

const FOLDER_STRUCTURE = {
  Backups_Base_Datos: { Automaticos: null, Manuales: null },
  Inventario:        { Productos: null, Ajustes_Inventario: null, Entradas: null, Salidas: null },
  Reportes:          { Ventas: null, Compras: null, Ganancias: null, Gastos: null, Cuadres_Caja: null, Reportes_Generales: null },
  Facturas:          { Facturas_Termicas: null, Facturas_A4: null, Facturas_Electronicas_eCF: null, Facturas_Anuladas: null },
  Clientes:          { Historial_Compras: null, Creditos: null, Estados_Cuenta: null },
  Delivery:          { Pedidos: null, Entregados: null, Historial_Rutas: null },
  Proveedores:       { Datos_Proveedores: null, Facturas_Compras: null, Cuentas_Por_Pagar: null, Historial_Compras: null, Devoluciones: null, Estados_Cuenta: null },
  Exportaciones:     {}
};

// Mapeo tipo → categoría / subcategoría por defecto
const TYPE_MAP = {
  factura_termica:     { cat: 'Facturas',           sub: 'Facturas_Termicas' },
  factura_a4:          { cat: 'Facturas',           sub: 'Facturas_A4' },
  factura_electronica: { cat: 'Facturas',           sub: 'Facturas_Electronicas_eCF' },
  factura_anulada:     { cat: 'Facturas',           sub: 'Facturas_Anuladas' },
  reporte_ventas:      { cat: 'Reportes',           sub: 'Ventas' },
  reporte_compras:     { cat: 'Reportes',           sub: 'Compras' },
  reporte_ganancias:   { cat: 'Reportes',           sub: 'Ganancias' },
  reporte_gastos:      { cat: 'Reportes',           sub: 'Gastos' },
  cuadre_caja:         { cat: 'Reportes',           sub: 'Cuadres_Caja' },
  reporte_general:     { cat: 'Reportes',           sub: 'Reportes_Generales' },
  inventario:          { cat: 'Inventario',         sub: 'Productos' },
  ajuste_inventario:   { cat: 'Inventario',         sub: 'Ajustes_Inventario' },
  entrada_inventario:  { cat: 'Inventario',         sub: 'Entradas' },
  salida_inventario:   { cat: 'Inventario',         sub: 'Salidas' },
  cliente_estado:      { cat: 'Clientes',           sub: 'Estados_Cuenta' },
  cliente_historial:   { cat: 'Clientes',           sub: 'Historial_Compras' },
  cliente_credito:     { cat: 'Clientes',           sub: 'Creditos' },
  delivery_pedido:     { cat: 'Delivery',           sub: 'Pedidos' },
  delivery_entregado:  { cat: 'Delivery',           sub: 'Entregados' },
  proveedor_datos:     { cat: 'Proveedores',        sub: 'Datos_Proveedores' },
  compra_proveedor:    { cat: 'Proveedores',        sub: 'Facturas_Compras' },
  cuenta_pagar:        { cat: 'Proveedores',        sub: 'Cuentas_Por_Pagar' },
  historial_proveedor: { cat: 'Proveedores',        sub: 'Historial_Compras' },
  devolucion_proveedor:{ cat: 'Proveedores',        sub: 'Devoluciones' },
  proveedor_estado:    { cat: 'Proveedores',        sub: 'Estados_Cuenta' },
  backup_auto:         { cat: 'Backups_Base_Datos', sub: 'Automaticos' },
  backup_manual:       { cat: 'Backups_Base_Datos', sub: 'Manuales' },
  exportacion:         { cat: 'Exportaciones',      sub: null },
};

function createFileManagerService({ query, userDataPath }) {
  const baseDir = path.join(userDataPath, 'Sistema_Data');

  // ── Helpers internos ───────────────────────────────────────────────────────

  function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  function buildTree(parentPath, structure) {
    for (const [folder, children] of Object.entries(structure)) {
      const p = path.join(parentPath, folder);
      ensureDir(p);
      if (children && Object.keys(children).length > 0) buildTree(p, children);
    }
  }

  function dateParts(date) {
    const d = (date instanceof Date) ? date : new Date(date || Date.now());
    return {
      year:  String(d.getFullYear()),
      month: MONTHS_ES[d.getMonth()],
      day:   String(d.getDate()).padStart(2, '0'),
    };
  }

  function pad(n, len = 6) { return String(n || 0).padStart(len, '0'); }

  // ── API pública ────────────────────────────────────────────────────────────

  async function initStructure() {
    try {
      ensureDir(baseDir);
      buildTree(baseDir, FOLDER_STRUCTURE);

      await query(`
        CREATE TABLE IF NOT EXISTS file_registry (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          document_type VARCHAR(60)  NOT NULL,
          category      VARCHAR(100) NOT NULL,
          sub_category  VARCHAR(100) DEFAULT NULL,
          file_name     VARCHAR(255) NOT NULL,
          file_path     TEXT         NOT NULL,
          relative_path TEXT         NOT NULL,
          file_size     INTEGER      DEFAULT 0,
          reference_id  VARCHAR(100) DEFAULT NULL,
          reference_date DATE        DEFAULT NULL,
          description   TEXT         DEFAULT NULL,
          branch_id     INTEGER      DEFAULT 1,
          terminal_id   VARCHAR(100) DEFAULT NULL,
          is_deleted    INTEGER      DEFAULT 0,
          created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_fr_type ON file_registry (document_type)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_fr_date ON file_registry (reference_date)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_fr_cat  ON file_registry (category, sub_category)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_fr_ref  ON file_registry (reference_id)`).catch(() => {});

      console.log('[file-manager] Estructura inicializada en:', baseDir);
    } catch (err) {
      console.error('[file-manager] Error init:', err.message);
    }
  }

  /** Devuelve la ruta absoluta donde guardar un archivo, creando las carpetas necesarias. */
  function resolveFilePath(category, subCategory, fileName, date) {
    const { year, month, day } = dateParts(date);
    const parts = [baseDir, category];
    if (subCategory) parts.push(subCategory);
    parts.push(year, month, day);
    const dir = ensureDir(path.join(...parts));
    return path.join(dir, fileName);
  }

  /** Genera un nombre de archivo estándar según el tipo de documento. */
  function generateFileName(type, opts = {}) {
    const { id, date, period, extension = 'pdf', clientName, provName, name } = opts;
    const d   = date ? new Date(date) : new Date();
    const ds  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const ts  = `${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
    const safe = s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);

    const templates = {
      factura_termica:      `Factura_Termica_${pad(id)}_${ds}`,
      factura_a4:           `Factura_${pad(id)}_${ds}`,
      factura_electronica:  `eCF_${pad(id)}_${ds}`,
      factura_anulada:      `Factura_Anulada_${pad(id)}_${ds}`,
      reporte_ventas:       `ReporteVentas_${period || ds}`,
      reporte_compras:      `ReporteCompras_${period || ds}`,
      reporte_ganancias:    `ReporteGanancias_${period || ds}`,
      reporte_gastos:       `ReporteGastos_${period || ds}`,
      cuadre_caja:          `CuadreCaja_${id ? `Caja${id}_` : ''}${ds}`,
      reporte_general:      `Reporte_${safe(name) || ds}`,
      inventario:           `Inventario_Actual_${ds}`,
      ajuste_inventario:    `Ajuste_Inventario_${pad(id)}_${ds}`,
      entrada_inventario:   `Entrada_${pad(id)}_${ds}`,
      salida_inventario:    `Salida_${pad(id)}_${ds}`,
      cliente_estado:       `${safe(clientName)}_EstadoCuenta_${ds}`,
      cliente_historial:    `Historial_${safe(clientName)}_${ds}`,
      cliente_credito:      `Credito_${safe(clientName)}_${ds}`,
      delivery_pedido:      `Pedido_${pad(id)}_${ds}`,
      delivery_entregado:   `Entregado_${pad(id)}_${ds}`,
      proveedor_datos:      `Proveedor_${safe(provName)}_${ds}`,
      compra_proveedor:     `Compra_Proveedor_${pad(id,5)}_${ds}`,
      cuenta_pagar:         `CuentaPorPagar_Proveedor_${pad(id,5)}`,
      historial_proveedor:  `Historial_${safe(provName)}_${ds}`,
      devolucion_proveedor: `Devolucion_Proveedor_${pad(id,5)}_${ds}`,
      proveedor_estado:     `Proveedor_${safe(provName)}_EstadoCuenta_${ds}`,
      backup_auto:          `Backup_DB_${ds}_${ts}`,
      backup_manual:        `Backup_Manual_${ds}_${ts}`,
      exportacion:          `Exportacion_${safe(name) || ds}`,
    };

    const base = templates[type] || `Documento_${ds}`;
    return `${base}.${extension}`;
  }

  /** Guarda contenido binario o base64 en disco. */
  function saveFileToDisk(filePath, content) {
    ensureDir(path.dirname(filePath));
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(filePath, content);
    } else if (typeof content === 'string' && content.includes('base64,')) {
      fs.writeFileSync(filePath, Buffer.from(content.split('base64,')[1], 'base64'));
    } else {
      fs.writeFileSync(filePath, content);
    }
  }

  /** Registra un archivo en la base de datos. */
  async function registerFile(opts) {
    const {
      documentType, category, subCategory, filePath,
      referenceId, referenceDate, description, branchId = 1, terminalId = null
    } = opts;
    try {
      const fileName     = path.basename(filePath);
      const relativePath = path.relative(baseDir, filePath);
      let   fileSize     = 0;
      try { fileSize = fs.statSync(filePath).size; } catch (_) {}

      const result = await query(
        `INSERT INTO file_registry
           (document_type, category, sub_category, file_name, file_path, relative_path,
            file_size, reference_id, reference_date, description, branch_id, terminal_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [documentType, category, subCategory || null, fileName, filePath, relativePath,
         fileSize, referenceId || null, referenceDate || null, description || null, branchId, terminalId]
      );
      return { ok: true, id: result?.insertId, fileName, filePath };
    } catch (err) {
      console.error('[file-manager] registerFile error:', err.message);
      return { ok: false, error: err.message };
    }
  }

  /** Guarda el archivo en disco + lo registra en un solo paso. */
  async function saveAndRegister(opts) {
    const { documentType, content, referenceDate } = opts;
    const typeInfo  = TYPE_MAP[documentType] || { cat: 'Exportaciones', sub: null };
    const category  = opts.category    || typeInfo.cat;
    const subCat    = opts.subCategory || typeInfo.sub;
    const fileName  = opts.fileName    || generateFileName(documentType, opts);
    const filePath  = resolveFilePath(category, subCat, fileName, referenceDate ? new Date(referenceDate) : new Date());

    saveFileToDisk(filePath, content);
    return registerFile({ ...opts, category, subCategory: subCat, filePath });
  }

  /** Búsqueda con filtros, paginada. */
  async function searchFiles(opts = {}) {
    const { term, category, subCategory, startDate, endDate, documentType, page = 1, limit = 50 } = opts;
    const cond   = ['is_deleted = 0'];
    const params = [];

    if (term) {
      cond.push('(file_name LIKE ? OR description LIKE ? OR reference_id LIKE ?)');
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    if (category)     { cond.push('category = ?');      params.push(category); }
    if (subCategory)  { cond.push('sub_category = ?');  params.push(subCategory); }
    if (documentType) { cond.push('document_type = ?'); params.push(documentType); }
    if (startDate)    { cond.push('(reference_date >= ? OR (reference_date IS NULL AND created_at >= ?))'); params.push(startDate, startDate); }
    if (endDate)      { cond.push('(reference_date <= ? OR (reference_date IS NULL AND created_at <= ?))'); params.push(endDate, endDate); }

    const where  = `WHERE ${cond.join(' AND ')}`;
    const offset = (page - 1) * limit;

    const [rows, totals] = await Promise.all([
      query(`SELECT * FROM file_registry ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
      query(`SELECT COUNT(*) as total, COALESCE(SUM(file_size),0) as total_size FROM file_registry ${where}`, params),
    ]);

    const total = totals[0]?.total || 0;
    return { files: rows || [], total, totalSize: totals[0]?.total_size || 0, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Estadísticas de disco y uso por categoría. */
  async function getDiskStats() {
    let folderSize = 0, fileCount = 0;

    function walkDir(dir) {
      if (!fs.existsSync(dir)) return;
      try {
        for (const item of fs.readdirSync(dir)) {
          const p = path.join(dir, item);
          try {
            const s = fs.statSync(p);
            if (s.isDirectory()) walkDir(p);
            else { folderSize += s.size; fileCount++; }
          } catch (_) {}
        }
      } catch (_) {}
    }
    walkDir(baseDir);

    const byCategory = await query(
      `SELECT category, sub_category, COUNT(*) as count, COALESCE(SUM(file_size),0) as size
       FROM file_registry WHERE is_deleted = 0 GROUP BY category, sub_category ORDER BY size DESC`
    ).catch(() => []);

    return {
      baseDir,
      totalSizeBytes: folderSize,
      totalSizeMB:    (folderSize / 1048576).toFixed(2),
      totalSizeGB:    (folderSize / 1073741824).toFixed(3),
      fileCount,
      byCategory: byCategory || [],
    };
  }

  /** Lista archivos candidatos para limpieza. */
  async function getOldFiles(daysOld = 365) {
    const cutoff = new Date(Date.now() - daysOld * 86400000);
    return query(
      `SELECT * FROM file_registry WHERE is_deleted = 0 AND created_at < ? ORDER BY created_at ASC`,
      [cutoff]
    ).catch(() => []);
  }

  /** Elimina (lógicamente o físicamente) un archivo del registro. */
  async function deleteFile(id, permanent = false) {
    const rows = await query('SELECT * FROM file_registry WHERE id = ? AND is_deleted = 0', [id]);
    if (!rows?.length) return { ok: false, error: 'Archivo no encontrado' };
    const file = rows[0];
    if (permanent && fs.existsSync(file.file_path)) {
      try { fs.unlinkSync(file.file_path); } catch (_) {}
    }
    await query('UPDATE file_registry SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    return { ok: true, fileName: file.file_name };
  }

  /** Ejecuta limpieza de archivos anteriores a N días. */
  async function cleanupOldFiles(daysOld = 365) {
    const files = await getOldFiles(daysOld);
    let deleted = 0, errors = 0;
    for (const f of files) {
      try {
        if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
        await query('UPDATE file_registry SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [f.id]);
        deleted++;
      } catch (_) { errors++; }
    }
    return { deleted, errors, total: files.length };
  }

  /** Árbol de carpetas para la UI. */
  function getFolderTree() {
    function buildUiTree(parentPath, structure) {
      return Object.entries(structure).map(([folder, children]) => ({
        name:     folder,
        label:    folder.replace(/_/g, ' '),
        path:     path.join(parentPath, folder),
        children: (children && Object.keys(children).length > 0)
          ? buildUiTree(path.join(parentPath, folder), children)
          : [],
      }));
    }
    return buildUiTree(baseDir, FOLDER_STRUCTURE);
  }

  return {
    initStructure,
    resolveFilePath,
    generateFileName,
    saveFileToDisk,
    saveAndRegister,
    registerFile,
    searchFiles,
    getDiskStats,
    getOldFiles,
    deleteFile,
    cleanupOldFiles,
    getFolderTree,
    TYPE_MAP,
    baseDir,
  };
}

module.exports = { createFileManagerService };
