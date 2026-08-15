import 'sync_columns.dart';

/// Cola de sincronizacion, auditoria, notificaciones locales y cache de
/// licencia. Estas tablas son "de sistema": no participan del modelo
/// empresa/sucursal/caja igual que las de negocio, cada una tiene su propio
/// set minimo de columnas.
class SchemaSistema {
  const SchemaSistema._();

  static const String colaSincronizacion = '''
    CREATE TABLE IF NOT EXISTS cola_sincronizacion (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      entidad_tipo TEXT NOT NULL,
      entidad_id TEXT NOT NULL,
      operacion TEXT NOT NULL,
      payload_json TEXT,
      intentos INTEGER NOT NULL DEFAULT 0,
      ultimo_error TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      prioridad INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL,
      actualizado_en TEXT NOT NULL,
      sincronizado_en TEXT
    )
  ''';

  static const String registroAuditoria = '''
    CREATE TABLE IF NOT EXISTS registro_auditoria (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      sucursal_id TEXT,
      usuario_id TEXT,
      dispositivo_id TEXT,
      accion TEXT NOT NULL,
      entidad_tipo TEXT,
      entidad_id TEXT,
      detalle_json TEXT,
      ocurrido_en TEXT NOT NULL,
      sincronizado INTEGER NOT NULL DEFAULT 0
    )
  ''';

  static const String notificacionesLocales = '''
    CREATE TABLE IF NOT EXISTS notificaciones_locales (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      cuerpo TEXT,
      data_json TEXT,
      leida INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL
    )
  ''';

  static const String licenciaCache = '''
    CREATE TABLE IF NOT EXISTS licencia_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      empresa_id TEXT,
      estado TEXT NOT NULL DEFAULT 'trial',
      plan_code TEXT,
      plan_name TEXT,
      fecha_activacion TEXT,
      fecha_expiracion TEXT,
      limite_usuarios INTEGER,
      limite_dispositivos INTEGER,
      limite_sucursales INTEGER,
      limite_cajas INTEGER,
      ultima_validacion_en TEXT,
      blob_cifrado TEXT,
      actualizado_en TEXT NOT NULL
    )
  ''';

  static const String rrhhAsistencias = '''
    CREATE TABLE IF NOT EXISTS rrhh_asistencias (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      entrada_en TEXT NOT NULL,
      salida_en TEXT,
      nota TEXT,
      ${SyncColumns.full}
    )
  ''';

  static List<String> indexes() => [
        'CREATE INDEX IF NOT EXISTS idx_cola_estado ON cola_sincronizacion(estado)',
        'CREATE INDEX IF NOT EXISTS idx_cola_entidad ON cola_sincronizacion(entidad_tipo, entidad_id)',
        'CREATE INDEX IF NOT EXISTS idx_auditoria_ocurrido ON registro_auditoria(ocurrido_en)',
        'CREATE INDEX IF NOT EXISTS idx_auditoria_sync ON registro_auditoria(sincronizado)',
        'CREATE INDEX IF NOT EXISTS idx_notificaciones_leida ON notificaciones_locales(leida)',
        'CREATE INDEX IF NOT EXISTS idx_rrhh_usuario ON rrhh_asistencias(usuario_id)',
        'CREATE INDEX IF NOT EXISTS idx_rrhh_entrada ON rrhh_asistencias(entrada_en)',
        ...SyncColumns.commonIndexes('rrhh_asistencias'),
      ];

  static List<String> all() => [
        colaSincronizacion,
        registroAuditoria,
        notificacionesLocales,
        licenciaCache,
        rrhhAsistencias,
        ...indexes(),
      ];
}
