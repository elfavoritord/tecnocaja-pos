import 'sync_columns.dart';

/// Tablas raiz: empresa (tenant), sucursales, cajas, usuarios, permisos,
/// configuracion del dispositivo y estado de vinculacion con Windows.
class SchemaCore {
  const SchemaCore._();

  static const String empresas = '''
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      nombre_comercial TEXT,
      rnc_cedula TEXT,
      direccion TEXT,
      telefono TEXT,
      email TEXT,
      tipo_negocio TEXT,
      pais TEXT NOT NULL DEFAULT 'RD',
      provincia TEXT,
      moneda_principal TEXT NOT NULL DEFAULT 'DOP',
      logo_path TEXT,
      tipo_plan TEXT NOT NULL DEFAULT 'trial',
      tasa_itbis_default REAL NOT NULL DEFAULT 0.18,
      ${SyncColumns.audit}
    )
  ''';

  static const String sucursales = '''
    CREATE TABLE IF NOT EXISTS sucursales (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nombre TEXT NOT NULL,
      codigo TEXT,
      direccion TEXT,
      telefono TEXT,
      encargado_usuario_id TEXT,
      activa INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.audit}
    )
  ''';

  static const String cajas = '''
    CREATE TABLE IF NOT EXISTS cajas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      sucursal_id TEXT NOT NULL,
      nombre TEXT NOT NULL,
      codigo TEXT,
      activa INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.audit}
    )
  ''';

  static const String usuarios = '''
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      sucursal_id TEXT,
      nombre TEXT NOT NULL,
      apellido TEXT,
      usuario TEXT NOT NULL,
      email TEXT,
      telefono TEXT,
      rol TEXT NOT NULL DEFAULT 'cajero',
      pin_hash TEXT,
      foto_path TEXT,
      firebase_uid TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      ultimo_acceso_en TEXT,
      ${SyncColumns.audit}
    )
  ''';

  static const String permisosUsuario = '''
    CREATE TABLE IF NOT EXISTS permisos_usuario (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      permiso TEXT NOT NULL,
      otorgado INTEGER NOT NULL DEFAULT 1,
      ${SyncColumns.audit}
    )
  ''';

  /// Singleton por instalacion (una fila). Incluye ajustes operativos y el
  /// estado de vinculacion con Tecno Caja POS Windows (evita una tabla aparte
  /// casi vacia para algo que es 1:1 con el dispositivo).
  static const String configuracion = '''
    CREATE TABLE IF NOT EXISTS configuracion (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      empresa_id TEXT,
      moneda_secundaria_activa INTEGER NOT NULL DEFAULT 0,
      tasa_cambio_usd_dop REAL,
      redondeo_activo INTEGER NOT NULL DEFAULT 0,
      redondeo_paso REAL NOT NULL DEFAULT 1.0,
      itbis_default REAL NOT NULL DEFAULT 0.18,
      prefijo_factura TEXT,
      secuencia_factura_actual INTEGER NOT NULL DEFAULT 1,
      periodo_gracia_offline_dias INTEGER NOT NULL DEFAULT 7,
      tema TEXT NOT NULL DEFAULT 'sistema',
      impresora_predeterminada_mac TEXT,
      impresora_ancho_mm INTEGER NOT NULL DEFAULT 58,
      imprimir_automatico INTEGER NOT NULL DEFAULT 0,
      sonido_scanner INTEGER NOT NULL DEFAULT 1,
      vibrar_scanner INTEGER NOT NULL DEFAULT 1,
      windows_vinculado INTEGER NOT NULL DEFAULT 0,
      windows_modo_conexion TEXT NOT NULL DEFAULT 'nube',
      windows_url_lan TEXT,
      windows_codigo_dispositivo TEXT,
      windows_nombre_dispositivo TEXT,
      windows_vinculado_en TEXT,
      actualizado_en TEXT NOT NULL
    )
  ''';

  static List<String> indexes() => [
        'CREATE INDEX IF NOT EXISTS idx_sucursales_empresa ON sucursales(empresa_id)',
        'CREATE INDEX IF NOT EXISTS idx_cajas_sucursal ON cajas(sucursal_id)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario)',
        'CREATE INDEX IF NOT EXISTS idx_usuarios_empresa ON usuarios(empresa_id)',
        'CREATE INDEX IF NOT EXISTS idx_permisos_usuario ON permisos_usuario(usuario_id)',
      ];

  static List<String> all() => [empresas, sucursales, cajas, usuarios, permisosUsuario, configuracion, ...indexes()];
}
