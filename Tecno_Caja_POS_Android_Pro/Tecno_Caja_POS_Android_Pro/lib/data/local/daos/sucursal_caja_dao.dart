import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/sucursal_caja.dart';
import 'base_dao.dart';

class SucursalDao extends BaseDao<Sucursal> {
  SucursalDao(Database db) : super(db, 'sucursales');

  @override
  Map<String, Object?> toMap(Sucursal entity) => entity.toMap();

  @override
  Sucursal fromMap(Map<String, Object?> map) => Sucursal.fromMap(map);

  @override
  String idOf(Sucursal entity) => entity.id;

  Future<List<Sucursal>> deEmpresa(String empresaId) {
    return findAll(where: 'empresa_id = ? AND activa = 1', whereArgs: [empresaId], orderBy: 'nombre ASC');
  }
}

class CajaDao extends BaseDao<Caja> {
  CajaDao(Database db) : super(db, 'cajas');

  @override
  Map<String, Object?> toMap(Caja entity) => entity.toMap();

  @override
  Caja fromMap(Map<String, Object?> map) => Caja.fromMap(map);

  @override
  String idOf(Caja entity) => entity.id;

  Future<List<Caja>> deSucursal(String sucursalId) {
    return findAll(where: 'sucursal_id = ? AND activa = 1', whereArgs: [sucursalId], orderBy: 'nombre ASC');
  }
}
