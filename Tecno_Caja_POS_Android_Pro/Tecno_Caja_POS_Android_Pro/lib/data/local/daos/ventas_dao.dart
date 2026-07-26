import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/sesion_caja.dart';
import '../../../domain/entities/venta.dart';
import 'base_dao.dart';

class VentaDao extends BaseDao<Venta> {
  VentaDao(Database db) : super(db, 'ventas');

  @override
  Map<String, Object?> toMap(Venta entity) => entity.toMap();
  @override
  Venta fromMap(Map<String, Object?> map) => Venta.fromMap(map);
  @override
  String idOf(Venta entity) => entity.id;

  Future<List<Venta>> deSesion(String sesionCajaId) {
    return findAll(
        where: 'sesion_caja_id = ?',
        whereArgs: [sesionCajaId],
        orderBy: 'creado_en DESC');
  }

  Future<List<Venta>> deEmpresa(String empresaId, {int limit = 500}) {
    return findAll(
      where: "empresa_id = ? AND estado != 'suspendida'",
      whereArgs: [empresaId],
      orderBy: 'creado_en DESC',
      limit: limit,
    );
  }

  Future<List<Venta>> deRango(
      String empresaId, DateTime desde, DateTime hasta) {
    return findAll(
      where: 'empresa_id = ? AND creado_en >= ? AND creado_en <= ?',
      whereArgs: [empresaId, desde.toIso8601String(), hasta.toIso8601String()],
      orderBy: 'creado_en DESC',
    );
  }

  Future<List<Venta>> deCliente(String clienteId, {int limit = 100}) {
    return findAll(
        where: 'cliente_id = ?',
        whereArgs: [clienteId],
        orderBy: 'creado_en DESC',
        limit: limit);
  }

  Future<List<Venta>> suspendidas(String empresaId) {
    return findAll(
        where: "empresa_id = ? AND estado = 'suspendida'",
        whereArgs: [empresaId],
        orderBy: 'creado_en DESC');
  }
}

class VentaItemDao extends BaseDao<VentaItem> {
  VentaItemDao(Database db) : super(db, 'venta_items');

  @override
  Map<String, Object?> toMap(VentaItem entity) => entity.toMap();
  @override
  VentaItem fromMap(Map<String, Object?> map) => VentaItem.fromMap(map);
  @override
  String idOf(VentaItem entity) => entity.id;

  Future<List<VentaItem>> deVenta(String ventaId) {
    return findAll(where: 'venta_id = ?', whereArgs: [ventaId]);
  }
}

class SesionCajaDao extends BaseDao<SesionCaja> {
  SesionCajaDao(Database db) : super(db, 'sesiones_caja');

  @override
  Map<String, Object?> toMap(SesionCaja entity) => entity.toMap();
  @override
  SesionCaja fromMap(Map<String, Object?> map) => SesionCaja.fromMap(map);
  @override
  String idOf(SesionCaja entity) => entity.id;

  Future<SesionCaja?> abiertaEn(String cajaId) async {
    final rows = await findAll(
        where: "caja_id = ? AND estado = 'abierta'",
        whereArgs: [cajaId],
        limit: 1);
    return rows.isEmpty ? null : rows.first;
  }

  Future<List<SesionCaja>> historial(String sucursalId, {int limit = 50}) {
    return findAll(
        where: 'sucursal_id = ?',
        whereArgs: [sucursalId],
        orderBy: 'abierta_en DESC',
        limit: limit);
  }
}

class MovimientoCajaDao extends BaseDao<MovimientoCaja> {
  MovimientoCajaDao(Database db) : super(db, 'movimientos_caja');

  @override
  Map<String, Object?> toMap(MovimientoCaja entity) => entity.toMap();
  @override
  MovimientoCaja fromMap(Map<String, Object?> map) =>
      MovimientoCaja.fromMap(map);
  @override
  String idOf(MovimientoCaja entity) => entity.id;

  Future<List<MovimientoCaja>> deSesion(String sesionCajaId) {
    return findAll(
        where: 'sesion_caja_id = ?',
        whereArgs: [sesionCajaId],
        orderBy: 'ocurrido_en ASC');
  }
}
