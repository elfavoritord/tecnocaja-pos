import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/inventario.dart';
import '../local/daos/catalogo_dao.dart';

/// Unico punto de entrada para tocar stock en toda la app. Cada movimiento
/// (venta, compra, ajuste, transferencia...) pasa por [registrarMovimiento],
/// que actualiza `inventario_sucursal` e inserta el renglon del kardex en la
/// MISMA transaccion -- asi nunca queda un stock actualizado sin su
/// movimiento (o viceversa), y nunca se descuenta dos veces la misma venta.
class InventarioRepository {
  InventarioRepository(this._db, this._inventarioDao, this._movimientoDao);

  final Database _db;
  final InventarioSucursalDao _inventarioDao;
  final MovimientoInventarioDao _movimientoDao;

  Future<InventarioSucursal> obtenerOCrear(
    String productoId,
    String sucursalId,
    String empresaId, {
    String? dispositivoId,
  }) async {
    final existente = await _inventarioDao.deProductoEnSucursal(productoId, sucursalId);
    if (existente != null) return existente;

    final now = DateTime.now();
    final productoRows = await _db.query('productos', columns: ['stock_minimo'], where: 'id = ?', whereArgs: [productoId], limit: 1);
    final stockMinimo = productoRows.isEmpty ? 0.0 : (productoRows.first['stock_minimo'] as num?)?.toDouble() ?? 0.0;

    final nuevo = InventarioSucursal(
      id: IdGenerator.newId(),
      productoId: productoId,
      sucursalId: sucursalId,
      empresaId: empresaId,
      stockMinimo: stockMinimo,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _inventarioDao.insert(nuevo);
    return nuevo;
  }

  /// [cantidad] positiva = entra stock, negativa = sale. Lanza
  /// [InsufficientStockException] si dejaria el stock negativo y
  /// [permitirNegativo] es false. Abre su propia transaccion -- para
  /// descontar varios productos junto con la creacion de otro registro
  /// (ej. una venta completa) en una unica transaccion atomica, usar
  /// [registrarMovimientoEnTransaccion] pasando el `txn` del llamador.
  Future<MovimientoInventario> registrarMovimiento({
    required String productoId,
    required String sucursalId,
    required String empresaId,
    required String tipoMovimiento,
    required double cantidad,
    double? costoUnitario,
    String? referenciaTipo,
    String? referenciaId,
    String? nota,
    String? dispositivoId,
    bool permitirNegativo = false,
  }) async {
    late MovimientoInventario movimiento;
    await _db.transaction((txn) async {
      movimiento = await registrarMovimientoEnTransaccion(
        txn,
        productoId: productoId,
        sucursalId: sucursalId,
        empresaId: empresaId,
        tipoMovimiento: tipoMovimiento,
        cantidad: cantidad,
        costoUnitario: costoUnitario,
        referenciaTipo: referenciaTipo,
        referenciaId: referenciaId,
        nota: nota,
        dispositivoId: dispositivoId,
        permitirNegativo: permitirNegativo,
      );
    });
    return movimiento;
  }

  /// Version reentrante: sqflite no permite anidar `Database.transaction()`,
  /// asi que quien ya tenga una transaccion abierta (ej.
  /// VentaRepository.registrarVenta) llama esto pasando su propio `txn` en
  /// vez de usar [registrarMovimiento].
  Future<MovimientoInventario> registrarMovimientoEnTransaccion(
    DatabaseExecutor txn, {
    required String productoId,
    required String sucursalId,
    required String empresaId,
    required String tipoMovimiento,
    required double cantidad,
    double? costoUnitario,
    String? referenciaTipo,
    String? referenciaId,
    String? nota,
    String? dispositivoId,
    bool permitirNegativo = false,
  }) async {
    final now = DateTime.now();
    final rows = await txn.query(
      'inventario_sucursal',
      where: 'producto_id = ? AND sucursal_id = ?',
      whereArgs: [productoId, sucursalId],
      limit: 1,
    );

    InventarioSucursal inventario;
    if (rows.isEmpty) {
      final productoRows = await txn.query('productos', columns: ['stock_minimo'], where: 'id = ?', whereArgs: [productoId], limit: 1);
      final stockMinimo = productoRows.isEmpty ? 0.0 : (productoRows.first['stock_minimo'] as num?)?.toDouble() ?? 0.0;
      inventario = InventarioSucursal(
        id: IdGenerator.newId(),
        productoId: productoId,
        sucursalId: sucursalId,
        empresaId: empresaId,
        stockMinimo: stockMinimo,
        dispositivoId: dispositivoId,
        creadoEn: now,
        actualizadoEn: now,
      );
    } else {
      inventario = InventarioSucursal.fromMap(rows.first);
    }

    final stockAnterior = inventario.stock;
    final stockNuevo = stockAnterior + cantidad;

    if (stockNuevo < 0 && !permitirNegativo) {
      final productoRows = await txn.query('productos', columns: ['nombre'], where: 'id = ?', whereArgs: [productoId], limit: 1);
      final nombre = productoRows.isEmpty ? productoId : productoRows.first['nombre'] as String;
      throw InsufficientStockException(nombre, stockAnterior);
    }

    final inventarioActualizado = inventario.copyWith(stock: stockNuevo);
    await txn.insert('inventario_sucursal', inventarioActualizado.toMap(), conflictAlgorithm: ConflictAlgorithm.replace);

    final movimiento = MovimientoInventario(
      id: IdGenerator.newId(),
      productoId: productoId,
      sucursalId: sucursalId,
      empresaId: empresaId,
      tipoMovimiento: tipoMovimiento,
      cantidad: cantidad,
      stockAnterior: stockAnterior,
      stockNuevo: stockNuevo,
      costoUnitario: costoUnitario,
      referenciaTipo: referenciaTipo,
      referenciaId: referenciaId,
      nota: nota,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await txn.insert('movimientos_inventario', movimiento.toMap());
    return movimiento;
  }

  Future<List<InventarioSucursal>> deSucursal(String sucursalId) => _inventarioDao.deSucursal(sucursalId);

  Future<List<InventarioSucursal>> stockBajo(String sucursalId) => _inventarioDao.stockBajo(sucursalId);

  Future<List<MovimientoInventario>> historialDe(String productoId) => _movimientoDao.deProducto(productoId);

  /// Lista para la pantalla de Inventario: stock + datos minimos del
  /// producto en una sola consulta, en vez de cargar cada Producto aparte.
  Future<List<ItemInventario>> deSucursalConProducto(
    String sucursalId, {
    String? termino,
    bool soloStockBajo = false,
  }) async {
    final condiciones = ['i.sucursal_id = ?', 'i.eliminado = 0', 'p.eliminado = 0'];
    final args = <Object?>[sucursalId];

    if (termino != null && termino.isNotEmpty) {
      condiciones.add('(p.nombre LIKE ? OR p.sku LIKE ? OR p.codigo_barras LIKE ?)');
      final like = '%$termino%';
      args.addAll([like, like, like]);
    }
    if (soloStockBajo) {
      condiciones.add('i.stock_minimo > 0 AND i.stock <= i.stock_minimo');
    }

    final rows = await _db.rawQuery('''
      SELECT i.id as inventario_id, i.producto_id, i.stock, i.stock_minimo,
             p.nombre, p.sku, p.codigo_barras, p.unidad_medida, p.precio_venta
      FROM inventario_sucursal i
      JOIN productos p ON p.id = i.producto_id
      WHERE ${condiciones.join(' AND ')}
      ORDER BY p.nombre ASC
    ''', args);
    return rows.map(ItemInventario.fromMap).toList();
  }
}

final inventarioRepositoryProvider = Provider<InventarioRepository>((ref) {
  return InventarioRepository(
    ref.watch(databaseProvider),
    ref.watch(inventarioSucursalDaoProvider),
    ref.watch(movimientoInventarioDaoProvider),
  );
});
