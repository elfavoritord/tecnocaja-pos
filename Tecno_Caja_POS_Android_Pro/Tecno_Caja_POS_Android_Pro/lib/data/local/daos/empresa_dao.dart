import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/empresa.dart';
import 'base_dao.dart';

class EmpresaDao extends BaseDao<Empresa> {
  EmpresaDao(Database db) : super(db, 'empresas');

  @override
  Map<String, Object?> toMap(Empresa entity) => entity.toMap();

  @override
  Empresa fromMap(Map<String, Object?> map) => Empresa.fromMap(map);

  @override
  String idOf(Empresa entity) => entity.id;

  /// La app es single-tenant por instalacion: siempre hay a lo sumo una fila
  /// activa en `empresas` (la del negocio configurado en este dispositivo).
  Future<Empresa?> actual() async {
    final rows = await findAll(limit: 1, orderBy: 'creado_en ASC');
    return rows.isEmpty ? null : rows.first;
  }
}
