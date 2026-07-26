import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/categoria.dart';
import '../../../domain/entities/inventario.dart';
import '../../../domain/entities/producto.dart';
import 'base_dao.dart';

class CategoriaDao extends BaseDao<Categoria> {
  CategoriaDao(Database db) : super(db, 'categorias');

  @override
  Map<String, Object?> toMap(Categoria entity) => entity.toMap();
  @override
  Categoria fromMap(Map<String, Object?> map) => Categoria.fromMap(map);
  @override
  String idOf(Categoria entity) => entity.id;

  Future<List<Categoria>> deEmpresa(String empresaId) {
    return findAll(
        where: 'empresa_id = ? AND activa = 1',
        whereArgs: [empresaId],
        orderBy: 'orden ASC, nombre ASC');
  }
}

class ProductoDao extends BaseDao<Producto> {
  ProductoDao(Database db) : super(db, 'productos');

  @override
  Map<String, Object?> toMap(Producto entity) => entity.toMap();
  @override
  Producto fromMap(Map<String, Object?> map) => Producto.fromMap(map);
  @override
  String idOf(Producto entity) => entity.id;

  Future<List<Producto>> deEmpresa(String empresaId,
      {bool soloActivos = true}) {
    return findAll(
      where: soloActivos ? 'empresa_id = ? AND activo = 1' : 'empresa_id = ?',
      whereArgs: [empresaId],
      orderBy: 'nombre ASC, actualizado_en DESC',
    );
  }

  Future<Producto?> porCodigoBarras(String empresaId, String codigo) async {
    final rows = await findAll(
      where: 'empresa_id = ? AND (codigo_barras = ? OR sku = ? OR plu = ?)',
      whereArgs: [empresaId, codigo, codigo, codigo],
      limit: 1,
    );
    return rows.isEmpty ? null : rows.first;
  }

  Future<List<Producto>> buscar(String empresaId, String termino) {
    final like = '%$termino%';
    return findAll(
      where:
          'empresa_id = ? AND activo = 1 AND (nombre LIKE ? OR sku LIKE ? OR codigo_barras LIKE ?)',
      whereArgs: [empresaId, like, like, like],
      orderBy: 'nombre ASC, actualizado_en DESC',
      limit: 50,
    );
  }

  Future<List<Producto>> favoritos(String empresaId) {
    return findAll(
        where: 'empresa_id = ? AND activo = 1 AND favorito = 1',
        whereArgs: [empresaId],
        orderBy: 'nombre ASC');
  }
}

class InventarioSucursalDao extends BaseDao<InventarioSucursal> {
  InventarioSucursalDao(Database db) : super(db, 'inventario_sucursal');

  @override
  Map<String, Object?> toMap(InventarioSucursal entity) => entity.toMap();
  @override
  InventarioSucursal fromMap(Map<String, Object?> map) =>
      InventarioSucursal.fromMap(map);
  @override
  String idOf(InventarioSucursal entity) => entity.id;

  Future<InventarioSucursal?> deProductoEnSucursal(
      String productoId, String sucursalId) async {
    final rows = await findAll(
        where: 'producto_id = ? AND sucursal_id = ?',
        whereArgs: [productoId, sucursalId],
        limit: 1);
    return rows.isEmpty ? null : rows.first;
  }

  Future<List<InventarioSucursal>> deSucursal(String sucursalId) {
    return findAll(where: 'sucursal_id = ?', whereArgs: [sucursalId]);
  }

  Future<List<InventarioSucursal>> stockBajo(String sucursalId) {
    return findAll(
      where: 'sucursal_id = ? AND stock_minimo > 0 AND stock <= stock_minimo',
      whereArgs: [sucursalId],
    );
  }
}

class MovimientoInventarioDao extends BaseDao<MovimientoInventario> {
  MovimientoInventarioDao(Database db) : super(db, 'movimientos_inventario');

  @override
  Map<String, Object?> toMap(MovimientoInventario entity) => entity.toMap();
  @override
  MovimientoInventario fromMap(Map<String, Object?> map) =>
      MovimientoInventario.fromMap(map);
  @override
  String idOf(MovimientoInventario entity) => entity.id;

  Future<List<MovimientoInventario>> deProducto(String productoId,
      {int limit = 100}) {
    return findAll(
        where: 'producto_id = ?',
        whereArgs: [productoId],
        orderBy: 'creado_en DESC',
        limit: limit);
  }
}
