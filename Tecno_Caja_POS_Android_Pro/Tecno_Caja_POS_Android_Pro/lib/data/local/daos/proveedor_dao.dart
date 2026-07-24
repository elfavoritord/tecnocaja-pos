import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/proveedor.dart';
import 'base_dao.dart';

class ProveedorDao extends BaseDao<Proveedor> {
  ProveedorDao(Database db) : super(db, 'proveedores');

  @override
  Map<String, Object?> toMap(Proveedor entity) => entity.toMap();
  @override
  Proveedor fromMap(Map<String, Object?> map) => Proveedor.fromMap(map);
  @override
  String idOf(Proveedor entity) => entity.id;

  Future<List<Proveedor>> deEmpresa(String empresaId) {
    return findAll(where: 'empresa_id = ? AND activo = 1', whereArgs: [empresaId], orderBy: 'nombre ASC');
  }

  Future<List<Proveedor>> buscar(String empresaId, String termino) {
    final like = '%$termino%';
    return findAll(
      where: 'empresa_id = ? AND activo = 1 AND (nombre LIKE ? OR empresa_proveedora LIKE ? OR rnc LIKE ?)',
      whereArgs: [empresaId, like, like, like],
      orderBy: 'nombre ASC',
      limit: 30,
    );
  }
}
