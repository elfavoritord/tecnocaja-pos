import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/cliente.dart';
import 'base_dao.dart';

class ClienteDao extends BaseDao<Cliente> {
  ClienteDao(Database db) : super(db, 'clientes');

  @override
  Map<String, Object?> toMap(Cliente entity) => entity.toMap();
  @override
  Cliente fromMap(Map<String, Object?> map) => Cliente.fromMap(map);
  @override
  String idOf(Cliente entity) => entity.id;

  Future<List<Cliente>> deEmpresa(String empresaId) {
    return findAll(
        where: 'empresa_id = ? AND activo = 1',
        whereArgs: [empresaId],
        orderBy: 'nombre ASC');
  }

  Future<List<Cliente>> buscar(String empresaId, String termino) {
    final like = '%$termino%';
    return findAll(
      where:
          'empresa_id = ? AND activo = 1 AND (nombre LIKE ? OR telefono LIKE ? OR cedula_rnc LIKE ?)',
      whereArgs: [empresaId, like, like, like],
      orderBy: 'nombre ASC',
      limit: 30,
    );
  }

  Future<List<Cliente>> conBalancePendiente(String empresaId) {
    return findAll(
        where: 'empresa_id = ? AND balance > 0',
        whereArgs: [empresaId],
        orderBy: 'balance DESC');
  }

  Future<Cliente?> porDocumento(String empresaId, String documento) async {
    final rows = await db.query(
      tableName,
      where: '''
        empresa_id = ?
        AND REPLACE(REPLACE(cedula_rnc, '-', ''), ' ', '') = ?
        AND eliminado = 0
      ''',
      whereArgs: [empresaId, documento],
      limit: 1,
    );
    return rows.isEmpty ? null : fromMap(rows.first);
  }
}
