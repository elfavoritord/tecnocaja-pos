import 'package:sqflite/sqflite.dart';

/// CRUD generico compartido por todos los DAO de entidades sincronizables.
/// Cada DAO concreto solo necesita mapear su entidad <-> fila y agregar sus
/// consultas propias -- evita repetir insert/update/soft-delete/pendingSync
/// en cada uno de los ~20 DAOs de la app.
abstract class BaseDao<T> {
  BaseDao(this.db, this.tableName);

  final Database db;
  final String tableName;

  Map<String, Object?> toMap(T entity);

  T fromMap(Map<String, Object?> map);

  String idOf(T entity);

  Future<T> insert(T entity) async {
    await db.insert(tableName, toMap(entity), conflictAlgorithm: ConflictAlgorithm.replace);
    return entity;
  }

  Future<void> insertMany(List<T> entities) async {
    if (entities.isEmpty) return;
    final batch = db.batch();
    for (final entity in entities) {
      batch.insert(tableName, toMap(entity), conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  Future<int> update(T entity) {
    return db.update(tableName, toMap(entity), where: 'id = ?', whereArgs: [idOf(entity)]);
  }

  Future<int> softDelete(String id, {required String nowIso}) {
    return db.update(
      tableName,
      {'eliminado': 1, 'actualizado_en': nowIso, 'sync_estado': 'pendiente'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Usado por la sincronizacion con Tecno Caja Windows: busca la fila local
  /// que ya representa un id remoto (INT de Windows) para decidir si toca
  /// insert o update. `incluirEliminados: true` porque un pull no debe
  /// duplicar una fila que el usuario borro localmente -- si reaparece del
  /// lado remoto, gana el remoto (se revive).
  Future<T?> porRemotoId(String remotoId) async {
    final rows = await findAll(where: 'remoto_id = ?', whereArgs: [remotoId], limit: 1, incluirEliminados: true);
    return rows.isEmpty ? null : rows.first;
  }

  Future<T?> findById(String id, {bool incluirEliminados = false}) async {
    final rows = await db.query(
      tableName,
      where: incluirEliminados ? 'id = ?' : 'id = ? AND eliminado = 0',
      whereArgs: [id],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return fromMap(rows.first);
  }

  Future<List<T>> findAll({
    String? where,
    List<Object?>? whereArgs,
    String? orderBy,
    int? limit,
    bool incluirEliminados = false,
  }) async {
    final effectiveWhere = incluirEliminados
        ? where
        : (where == null ? 'eliminado = 0' : '($where) AND eliminado = 0');
    final rows = await db.query(
      tableName,
      where: effectiveWhere,
      whereArgs: whereArgs,
      orderBy: orderBy,
      limit: limit,
    );
    return rows.map(fromMap).toList();
  }

  Future<int> count({String? where, List<Object?>? whereArgs}) async {
    final effectiveWhere = where == null ? 'eliminado = 0' : '($where) AND eliminado = 0';
    final result = await db.rawQuery(
      'SELECT COUNT(*) as total FROM $tableName WHERE $effectiveWhere',
      whereArgs,
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  Future<int> markSynced(String id, {required String remoteId, required String nowIso}) {
    return db.update(
      tableName,
      {'sync_estado': 'sincronizado', 'sincronizado_en': nowIso, 'remoto_id': remoteId},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// El detalle del error vive en `cola_sincronizacion.ultimo_error` (el
  /// intento fallido), no en la fila de la entidad -- aqui solo se marca el
  /// estado para que quede fuera del proximo batch hasta reintentar.
  Future<int> markSyncError(String id) {
    return db.update(
      tableName,
      {'sync_estado': 'error'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<List<T>> pendingSync({int limit = 100}) async {
    final rows = await db.query(
      tableName,
      where: "sync_estado = 'pendiente'",
      orderBy: 'actualizado_en ASC',
      limit: limit,
    );
    return rows.map(fromMap).toList();
  }
}
