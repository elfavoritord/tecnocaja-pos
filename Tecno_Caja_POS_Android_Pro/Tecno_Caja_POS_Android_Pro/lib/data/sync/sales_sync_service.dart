import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../cloud/cloud_functions_service.dart';

class SalesSyncService {
  const SalesSyncService(this._db, this._cloud);

  final Database _db;
  final CloudFunctionsService _cloud;

  /// Publica ventas pendientes de cualquier cajero de la empresa. El ID local
  /// de la venta también es el ID del documento remoto, por lo que reintentar
  /// nunca crea facturas duplicadas.
  Future<int> syncPendingSales(String businessId, {int limit = 50}) async {
    final sales = await _db.query(
      'ventas',
      where: '''
        empresa_id = ? AND eliminado = 0 AND (
          sync_estado IN ('pendiente', 'error') OR
          numero_factura IS NULL OR numero_factura = '' OR numero_factura = id
        )
      ''',
      whereArgs: [businessId],
      orderBy: 'creado_en ASC',
      limit: limit,
    );
    if (sales.isEmpty) return 0;
    return _sincronizar(sales);
  }

  /// Sincroniza una única venta y espera la confirmación del servidor --
  /// usado antes de pedir un NCF (`requestNcf` exige que el documento ya
  /// exista en Firestore). Sincroniza aunque la venta ya estuviera marcada
  /// como sincronizada, para no depender de una carrera con
  /// `syncPendingSales`.
  Future<bool> syncSale(String businessId, String saleId) async {
    final sales = await _db.query(
      'ventas',
      where: 'id = ? AND empresa_id = ? AND eliminado = 0',
      whereArgs: [saleId, businessId],
      limit: 1,
    );
    if (sales.isEmpty) return false;
    final synced = await _sincronizar(sales);
    return synced > 0;
  }

  Future<int> _sincronizar(List<Map<String, Object?>> sales) async {
    final payload = <Map<String, dynamic>>[];
    for (final sale in sales) {
      final items = await _db.query(
        'venta_items',
        where: 'venta_id = ? AND eliminado = 0',
        whereArgs: [sale['id']],
        orderBy: 'creado_en ASC',
      );
      final branch = await _remoteId('sucursales', sale['sucursal_id']);
      final register = await _remoteId('cajas', sale['caja_id']);
      final customer = await _remoteId('clientes', sale['cliente_id']);
      final cashier = await _rowById('usuarios', sale['usuario_id']);
      payload.add({
        'id': sale['id'],
        'invoiceNumber': sale['numero_factura'] ?? sale['id'],
        'invoiceType': sale['tipo_documento'],
        'customerId': customer,
        'cashierId': cashier?['remoto_id'] ?? cashier?['firebase_uid'],
        'cashierName': [
          cashier?['nombre'],
          cashier?['apellido'],
        ]
            .whereType<String>()
            .where((value) => value.trim().isNotEmpty)
            .join(' '),
        'branchId': branch,
        'cashRegisterId': register,
        'cashSessionId': sale['sesion_caja_id'],
        'subtotal': sale['subtotal'],
        'discount': sale['descuento_monto'],
        'tax': sale['itbis'],
        'total': sale['total'],
        'currency': sale['moneda'],
        'paymentMethod': sale['metodo_pago'],
        'status': sale['estado'],
        'cancelReason': sale['motivo_anulacion'],
        'createdAt': sale['creado_en'],
        'updatedAt': sale['actualizado_en'],
        'items': [
          for (final item in items)
            {
              'productId': await _remoteId('productos', item['producto_id']) ??
                  item['producto_id'],
              'productName': item['nombre_producto_snapshot'],
              'quantity': item['cantidad'],
              'price': item['precio_unitario'],
              'discount': item['descuento_monto'],
              'taxRate': item['tasa_itbis'],
              'total': item['subtotal_linea'],
            },
        ],
      });
    }

    try {
      final result = await _cloud.syncSales(payload);
      final syncedIds =
          (result['saleIds'] as List? ?? const []).map((id) => id.toString());
      final invoiceNumbers = Map<String, dynamic>.from(
          result['invoiceNumbers'] as Map? ?? const {});
      final now = DateTime.now().toIso8601String();
      await _db.transaction((txn) async {
        for (final id in syncedIds) {
          await txn.update(
            'ventas',
            {
              'sync_estado': 'sincronizado',
              'sincronizado_en': now,
              'remoto_id': id,
              if (invoiceNumbers[id]?.toString().isNotEmpty == true)
                'numero_factura': invoiceNumbers[id].toString(),
            },
            where: 'id = ?',
            whereArgs: [id],
          );
          await txn.update(
            'venta_items',
            {
              'sync_estado': 'sincronizado',
              'sincronizado_en': now,
            },
            where: 'venta_id = ?',
            whereArgs: [id],
          );
        }
      });
      return syncedIds.length;
    } catch (error, stackTrace) {
      // Offline-first: las filas siguen pendientes y se reintentan en el
      // próximo login, venta o sincronización manual.
      debugPrint('No se pudieron sincronizar las ventas: $error');
      debugPrintStack(stackTrace: stackTrace);
      final now = DateTime.now().toIso8601String();
      await _db.transaction((txn) async {
        for (final sale in sales) {
          await txn.update(
            'ventas',
            {
              'sync_estado': 'error',
              'actualizado_en': now,
            },
            where: 'id = ?',
            whereArgs: [sale['id']],
          );
        }
      });
      return 0;
    }
  }

  Future<String?> _remoteId(String table, Object? id) async {
    if (id == null) return null;
    final row = await _rowById(table, id);
    return row?['remoto_id']?.toString() ?? id.toString();
  }

  Future<Map<String, Object?>?> _rowById(String table, Object? id) async {
    if (id == null) return null;
    final rows =
        await _db.query(table, where: 'id = ?', whereArgs: [id], limit: 1);
    return rows.firstOrNull;
  }
}

final salesSyncServiceProvider = Provider<SalesSyncService>((ref) {
  return SalesSyncService(
    ref.watch(databaseProvider),
    ref.watch(cloudFunctionsServiceProvider),
  );
});
