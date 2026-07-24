/// Fragmentos SQL compartidos por todas las tablas.
///
/// Todo registro de negocio (producto, venta, cliente...) lleva estas
/// columnas para poder sincronizar offline-first: UUID local, quien y en que
/// dispositivo lo creo, version para deteccion de conflictos, estado de
/// sincronizacion, y `remoto_id` -- el backend Windows usa INT AUTO_INCREMENT
/// en todo (no UUIDs), asi que la cola de sincronizacion mapea
/// id_local(UUID) <-> remoto_id(INT) una vez que el registro sube.
///
/// `eliminado` es borrado logico: nunca se hace DELETE fisico de un registro
/// que ya pudo haber sincronizado, para no perder el historial en otros
/// dispositivos.
class SyncColumns {
  const SyncColumns._();

  static const String audit = '''
    usuario_creador_id TEXT,
    dispositivo_id TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    sync_estado TEXT NOT NULL DEFAULT 'pendiente',
    sincronizado_en TEXT,
    remoto_id TEXT,
    eliminado INTEGER NOT NULL DEFAULT 0
  ''';

  /// Para tablas de negocio colgadas de empresa/sucursal/caja.
  static const String full = '''
    empresa_id TEXT NOT NULL,
    sucursal_id TEXT,
    caja_id TEXT,
    $audit
  ''';

  /// Indices que casi toda tabla de negocio necesita: filtrar por tenant y
  /// por cola de sincronizacion pendiente.
  static List<String> commonIndexes(String table) => [
        'CREATE INDEX IF NOT EXISTS idx_${table}_empresa ON $table(empresa_id)',
        'CREATE INDEX IF NOT EXISTS idx_${table}_sync ON $table(sync_estado)',
        'CREATE INDEX IF NOT EXISTS idx_${table}_eliminado ON $table(eliminado)',
      ];
}
