import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/calculo_venta.dart';
import '../../domain/entities/inventario.dart';
import '../../domain/entities/venta.dart';
import '../local/daos/ventas_dao.dart';
import 'inventario_repository.dart';

/// Una linea pedida por la UI del POS antes de persistir -- distinta de
/// [VentaItem] (que ya es el registro final con snapshot del nombre, etc.).
class LineaVentaSolicitada {
  const LineaVentaSolicitada({
    required this.productoId,
    required this.nombreProducto,
    required this.cantidad,
    required this.precioUnitario,
    this.precioOriginal,
    this.tasaItbis = 0.18,
    this.itbisIncluido = true,
    this.descuentoMonto = 0,
    this.descuentoPorcentaje = 0,
    this.ofertaId,
    this.nota,
  });

  final String productoId;
  final String nombreProducto;
  final double cantidad;
  final double precioUnitario;
  final double? precioOriginal;
  final double tasaItbis;
  final bool itbisIncluido;
  final double descuentoMonto;
  final double descuentoPorcentaje;
  final String? ofertaId;
  final String? nota;
}

class VentaRepository {
  VentaRepository(
      this._db, this._ventaDao, this._ventaItemDao, this._inventarioRepo);

  final Database _db;
  final VentaDao _ventaDao;
  final VentaItemDao _ventaItemDao;
  final InventarioRepository _inventarioRepo;

  /// Cobra el carrito: calcula totales, crea la venta + sus lineas, descuenta
  /// inventario linea por linea y (si es a credito) aumenta el balance del
  /// cliente -- todo en UNA transaccion. Si algo falla (ej. stock
  /// insuficiente de una linea a mitad de camino) no queda nada a medias.
  Future<Venta> registrarVenta({
    required String empresaId,
    required String sucursalId,
    required String cajaId,
    required String sesionCajaId,
    required String usuarioId,
    required List<LineaVentaSolicitada> lineas,
    String? clienteId,
    String tipoDocumento = TipoDocumentoVenta.ticket,
    String metodoPago = MetodoPago.efectivo,
    String moneda = 'DOP',
    double? tasaCambio,
    double descuentoGlobalMonto = 0,
    double descuentoGlobalPorcentaje = 0,
    bool redondeoActivo = false,
    double redondeoPaso = 1.0,
    double? montoRecibido,
    String? nota,
    String? dispositivoId,
    bool permitirStockNegativo = false,
  }) async {
    if (lineas.isEmpty) {
      throw const ValidationException(message: 'La venta no tiene productos.');
    }

    final calculo = CalculadoraVenta.calcular(
      items: lineas
          .map((l) => ItemCalculo(
                productoId: l.productoId,
                cantidad: l.cantidad,
                precioUnitario: l.precioUnitario,
                tasaItbis: l.tasaItbis,
                itbisIncluido: l.itbisIncluido,
                descuentoMonto: l.descuentoMonto,
                descuentoPorcentaje: l.descuentoPorcentaje,
              ))
          .toList(),
      descuentoGlobalMonto: descuentoGlobalMonto,
      descuentoGlobalPorcentaje: descuentoGlobalPorcentaje,
      redondeoActivo: redondeoActivo,
      redondeoPaso: redondeoPaso,
    );

    final cambio = montoRecibido != null
        ? CalculadoraVenta.calcularCambio(montoRecibido, calculo.total)
        : null;

    final now = DateTime.now();
    final numeroFactura = await _siguienteNumeroFactura(empresaId);
    final venta = Venta(
      id: IdGenerator.newId(),
      numeroFactura: numeroFactura,
      tipoDocumento: tipoDocumento,
      clienteId: clienteId,
      sesionCajaId: sesionCajaId,
      usuarioId: usuarioId,
      subtotal: calculo.subtotal,
      descuentoMonto: calculo.descuentoTotal,
      itbis: calculo.itbis,
      total: calculo.total,
      moneda: moneda,
      tasaCambio: tasaCambio,
      montoRecibido: montoRecibido,
      cambio: cambio,
      redondeoAplicado: calculo.redondeoAplicado,
      metodoPago: metodoPago,
      estado: EstadoVenta.completada,
      nota: nota,
      empresaId: empresaId,
      sucursalId: sucursalId,
      cajaId: cajaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );

    await _db.transaction((txn) async {
      await txn.insert('ventas', venta.toMap());

      for (final linea in lineas) {
        final itemCalculo = ItemCalculo(
          productoId: linea.productoId,
          cantidad: linea.cantidad,
          precioUnitario: linea.precioUnitario,
          tasaItbis: linea.tasaItbis,
          itbisIncluido: linea.itbisIncluido,
          descuentoMonto: linea.descuentoMonto,
          descuentoPorcentaje: linea.descuentoPorcentaje,
        );

        final ventaItem = VentaItem(
          id: IdGenerator.newId(),
          ventaId: venta.id,
          productoId: linea.productoId,
          nombreProductoSnapshot: linea.nombreProducto,
          cantidad: linea.cantidad,
          precioUnitario: linea.precioUnitario,
          precioOriginal: linea.precioOriginal,
          descuentoMonto: itemCalculo.descuentoTotal,
          tasaItbis: linea.tasaItbis,
          subtotalLinea: itemCalculo.totalLinea,
          ofertaId: linea.ofertaId,
          nota: linea.nota,
          empresaId: empresaId,
          sucursalId: sucursalId,
          cajaId: cajaId,
          dispositivoId: dispositivoId,
          creadoEn: now,
          actualizadoEn: now,
        );
        await txn.insert('venta_items', ventaItem.toMap());

        await _inventarioRepo.registrarMovimientoEnTransaccion(
          txn,
          productoId: linea.productoId,
          sucursalId: sucursalId,
          empresaId: empresaId,
          tipoMovimiento: TipoMovimientoInventario.venta,
          cantidad: -linea.cantidad,
          referenciaTipo: 'venta',
          referenciaId: venta.id,
          dispositivoId: dispositivoId,
          permitirNegativo: permitirStockNegativo,
        );
      }

      if (metodoPago == MetodoPago.credito && clienteId != null) {
        await txn.rawUpdate(
          'UPDATE clientes SET balance = balance + ?, actualizado_en = ?, sync_estado = ? WHERE id = ?',
          [calculo.total, now.toIso8601String(), 'pendiente', clienteId],
        );
      }
    });

    return venta;
  }

  Future<String> _siguienteNumeroFactura(String empresaId) async {
    final configRows = await _db.query(
      'configuracion',
      columns: ['prefijo_factura', 'secuencia_factura_actual'],
      where: 'id = 1',
      limit: 1,
    );
    final prefix =
        configRows.firstOrNull?['prefijo_factura']?.toString().trim();
    final safePrefix = prefix == null || prefix.isEmpty ? 'FAC-' : prefix;
    final configured =
        (configRows.firstOrNull?['secuencia_factura_actual'] as int?) ?? 1;
    final maxRows = await _db.rawQuery(
      '''
      SELECT MAX(CAST(SUBSTR(numero_factura, ?) AS INTEGER)) AS ultimo
      FROM ventas
      WHERE empresa_id = ? AND numero_factura LIKE ?
      ''',
      [safePrefix.length + 1, empresaId, '$safePrefix%'],
    );
    final current = (maxRows.first['ultimo'] as num?)?.toInt() ?? 0;
    final next = current >= configured ? current + 1 : configured;
    await _db.update(
      'configuracion',
      {
        'secuencia_factura_actual': next + 1,
        'actualizado_en': DateTime.now().toIso8601String(),
      },
      where: 'id = 1',
    );
    return '$safePrefix${next.toString().padLeft(8, '0')}';
  }

  Future<Venta> suspender({
    required String empresaId,
    required String sucursalId,
    required String cajaId,
    required String sesionCajaId,
    required String usuarioId,
    required List<LineaVentaSolicitada> lineas,
    String? clienteId,
    String? nota,
    String? dispositivoId,
  }) async {
    final calculo = CalculadoraVenta.calcular(
      items: lineas
          .map((l) => ItemCalculo(
                productoId: l.productoId,
                cantidad: l.cantidad,
                precioUnitario: l.precioUnitario,
                tasaItbis: l.tasaItbis,
                itbisIncluido: l.itbisIncluido,
                descuentoMonto: l.descuentoMonto,
                descuentoPorcentaje: l.descuentoPorcentaje,
              ))
          .toList(),
    );
    final now = DateTime.now();
    final venta = Venta(
      id: IdGenerator.newId(),
      clienteId: clienteId,
      sesionCajaId: sesionCajaId,
      usuarioId: usuarioId,
      subtotal: calculo.subtotal,
      itbis: calculo.itbis,
      total: calculo.total,
      estado: EstadoVenta.suspendida,
      nota: nota,
      empresaId: empresaId,
      sucursalId: sucursalId,
      cajaId: cajaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );

    await _db.transaction((txn) async {
      await txn.insert('ventas', venta.toMap());
      for (final linea in lineas) {
        final itemCalculo = ItemCalculo(
          productoId: linea.productoId,
          cantidad: linea.cantidad,
          precioUnitario: linea.precioUnitario,
          tasaItbis: linea.tasaItbis,
          itbisIncluido: linea.itbisIncluido,
          descuentoMonto: linea.descuentoMonto,
          descuentoPorcentaje: linea.descuentoPorcentaje,
        );
        final ventaItem = VentaItem(
          id: IdGenerator.newId(),
          ventaId: venta.id,
          productoId: linea.productoId,
          nombreProductoSnapshot: linea.nombreProducto,
          cantidad: linea.cantidad,
          precioUnitario: linea.precioUnitario,
          subtotalLinea: itemCalculo.totalLinea,
          tasaItbis: linea.tasaItbis,
          empresaId: empresaId,
          sucursalId: sucursalId,
          cajaId: cajaId,
          dispositivoId: dispositivoId,
          creadoEn: now,
          actualizadoEn: now,
        );
        await txn.insert('venta_items', ventaItem.toMap());
      }
    });

    return venta;
  }

  Future<List<Venta>> ventasSuspendidas(String empresaId) =>
      _ventaDao.suspendidas(empresaId);

  /// Consume una venta suspendida: sus lineas ya se cargaron de vuelta al
  /// carrito (ver CarritoController.cargarLineas), asi que el borrador queda
  /// eliminado logicamente -- igual que cualquier otra fila sincronizable,
  /// nunca se borra fisicamente (ver BaseDao.softDelete).
  Future<void> recuperar(Venta venta) async {
    final now = DateTime.now().toIso8601String();
    await _db.transaction((txn) async {
      await txn.update(
        'venta_items',
        {'eliminado': 1, 'actualizado_en': now, 'sync_estado': 'pendiente'},
        where: 'venta_id = ?',
        whereArgs: [venta.id],
      );
      await txn.update(
        'ventas',
        {'eliminado': 1, 'actualizado_en': now, 'sync_estado': 'pendiente'},
        where: 'id = ?',
        whereArgs: [venta.id],
      );
    });
  }

  Future<List<VentaItem>> itemsDe(String ventaId) =>
      _ventaItemDao.deVenta(ventaId);

  /// Revierte el stock de cada linea (entra de vuelta) y marca la venta como
  /// anulada. No borra la venta -- queda en el historial con estado
  /// 'anulada' para auditoria.
  Future<void> anular({
    required Venta venta,
    required String motivo,
    String? dispositivoId,
  }) async {
    if (venta.estado == EstadoVenta.anulada) return;

    await _db.transaction((txn) async {
      final items = await txn
          .query('venta_items', where: 'venta_id = ?', whereArgs: [venta.id]);
      for (final row in items) {
        final item = VentaItem.fromMap(row);
        if (venta.estado == EstadoVenta.completada &&
            venta.sucursalId != null) {
          await _inventarioRepo.registrarMovimientoEnTransaccion(
            txn,
            productoId: item.productoId,
            sucursalId: venta.sucursalId!,
            empresaId: venta.empresaId,
            tipoMovimiento: TipoMovimientoInventario.devolucion,
            cantidad: item.cantidad,
            referenciaTipo: 'anulacion_venta',
            referenciaId: venta.id,
            dispositivoId: dispositivoId,
            permitirNegativo: true,
          );
        }
      }

      if (venta.metodoPago == MetodoPago.credito &&
          venta.clienteId != null &&
          venta.estado == EstadoVenta.completada) {
        await txn.rawUpdate(
          'UPDATE clientes SET balance = balance - ?, actualizado_en = ?, sync_estado = ? WHERE id = ?',
          [
            venta.total,
            DateTime.now().toIso8601String(),
            'pendiente',
            venta.clienteId
          ],
        );
      }

      final actualizada =
          venta.copyWith(estado: EstadoVenta.anulada, motivoAnulacion: motivo);
      await txn.update('ventas', actualizada.toMap(),
          where: 'id = ?', whereArgs: [venta.id]);
    });
  }

  /// Guarda el resultado de `requestNcf` en la venta local. No toca
  /// `sync_estado`/`version`: `requestNcf` ya escribió el NCF directo en el
  /// documento remoto de la venta dentro de su propia transacción, así que
  /// no hace falta un re-sync para propagarlo.
  Future<void> actualizarFiscal(
    String ventaId, {
    required String encf,
    required String ecfEstado,
  }) {
    return _db.update(
      'ventas',
      {'encf': encf, 'ecf_estado': ecfEstado},
      where: 'id = ?',
      whereArgs: [ventaId],
    );
  }

  Future<Venta?> porId(String id) => _ventaDao.findById(id);

  Future<List<Venta>> deSesion(String sesionCajaId) =>
      _ventaDao.deSesion(sesionCajaId);

  Future<List<Venta>> deEmpresa(String empresaId, {int limit = 500}) =>
      _ventaDao.deEmpresa(empresaId, limit: limit);

  Future<List<Venta>> deRango(
          String empresaId, DateTime desde, DateTime hasta) =>
      _ventaDao.deRango(empresaId, desde, hasta);

  Future<List<Venta>> deCliente(String clienteId) =>
      _ventaDao.deCliente(clienteId);
}

final ventaRepositoryProvider = Provider<VentaRepository>((ref) {
  return VentaRepository(
    ref.watch(databaseProvider),
    ref.watch(ventaDaoProvider),
    ref.watch(ventaItemDaoProvider),
    ref.watch(inventarioRepositoryProvider),
  );
});
