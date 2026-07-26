import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart' hide Transaction;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';

class CloudBusinessSyncResult {
  const CloudBusinessSyncResult({
    required this.products,
    required this.customers,
    required this.sales,
    required this.users,
    required this.conflicts,
  });

  final int products;
  final int customers;
  final int sales;
  final int users;
  final int conflicts;
}

/// Descarga el negocio canónico de Firestore al SQLite offline de Flutter.
/// Solo reemplaza filas previamente sincronizadas. Una fila local pendiente
/// se conserva y genera una entrada de auditoría para resolución posterior.
class CloudBusinessSyncRepository {
  CloudBusinessSyncRepository(this._db, this._firestore);

  final Database _db;
  final FirebaseFirestore _firestore;

  Future<int> pushLocalCustomers({
    required String localBusinessId,
    required String remoteBusinessId,
  }) async {
    final rows = await _db.query(
      'clientes',
      where: "empresa_id = ? AND eliminado = 0 AND sync_estado = 'pendiente'",
      whereArgs: [localBusinessId],
    );
    if (rows.isEmpty) return 0;
    final collection = _firestore
        .collection('businesses')
        .doc(remoteBusinessId)
        .collection('customers');
    var written = 0;
    for (var start = 0; start < rows.length; start += 400) {
      final batch = _firestore.batch();
      final end = (start + 400 < rows.length) ? start + 400 : rows.length;
      for (final row in rows.sublist(start, end)) {
        final remoteId = row['remoto_id']?.toString() ?? row['id']!.toString();
        batch.set(
          collection.doc(remoteId),
          {
            'businessId': remoteBusinessId,
            'name': row['nombre']?.toString() ?? '',
            'phone': row['telefono']?.toString(),
            'email': row['email']?.toString(),
            'address': row['direccion']?.toString(),
            'taxId': row['cedula_rnc']?.toString(),
            'creditLimit': row['limite_credito'] ?? 0,
            'totalDebt': row['balance'] ?? 0,
            'origin': 'app_movil',
            'origen': 'app_movil',
            'synced': false,
            'sincronizado': false,
            'syncStatus': 'pending',
            'mobileCustomerId': row['id']!.toString(),
            'updatedAt': FieldValue.serverTimestamp(),
          },
          SetOptions(merge: true),
        );
        written++;
      }
      await batch.commit();
    }
    return written;
  }

  /// Publica el catálogo offline en la nube para que otras cuentas y equipos
  /// de la empresa reciban los mismos productos. Firestore conserva los
  /// permisos: solo dueño/administrador puede escribir; un cajero únicamente
  /// ejecutará el pull posterior.
  Future<int> pushLocalProducts({
    required String localBusinessId,
    required String remoteBusinessId,
  }) async {
    try {
      final rows = await _db.query(
        'productos',
        where: 'empresa_id = ? AND eliminado = 0',
        whereArgs: [localBusinessId],
      );
      if (rows.isEmpty) return 0;
      final branches = await _db.query(
        'sucursales',
        columns: ['id', 'remoto_id'],
        where: 'empresa_id = ? AND remoto_id IS NOT NULL',
        whereArgs: [localBusinessId],
      );
      final branchRemoteIds = {
        for (final branch in branches)
          branch['id']!.toString(): branch['remoto_id']!.toString(),
      };
      final inventoryRows = await _db.query(
        'inventario_sucursal',
        columns: ['producto_id', 'sucursal_id', 'stock'],
        where: 'empresa_id = ? AND eliminado = 0',
        whereArgs: [localBusinessId],
      );
      final stockByProductAndBranch = {
        for (final inventory in inventoryRows)
          '${inventory['producto_id']}:${inventory['sucursal_id']}':
              inventory['stock'] ?? 0,
      };
      final categories = await _db.query(
        'categorias',
        columns: ['id', 'nombre'],
        where: 'empresa_id = ?',
        whereArgs: [localBusinessId],
      );
      final categoryNames = {
        for (final category in categories)
          category['id']!.toString():
              category['nombre']?.toString() ?? 'General',
      };
      final collection = _firestore
          .collection('businesses')
          .doc(remoteBusinessId)
          .collection('products');
      var written = 0;
      for (var start = 0; start < rows.length; start += 400) {
        final batch = _firestore.batch();
        final end = (start + 400 < rows.length) ? start + 400 : rows.length;
        for (final row in rows.sublist(start, end)) {
          final existingRemoteId = row['remoto_id']?.toString();
          final shouldPublishToPos =
              row['sync_estado']?.toString() == 'pendiente';
          final remoteId = existingRemoteId ?? row['id']!.toString();
          final payload = <String, Object?>{
            'businessId': remoteBusinessId,
            'name': row['nombre']?.toString() ?? '',
            'category':
                categoryNames[row['categoria_id']?.toString()] ?? 'General',
            'sku': row['sku']?.toString(),
            'barcode': row['codigo_barras']?.toString(),
            'brand': row['marca']?.toString(),
            'unit': row['unidad_medida']?.toString() ?? 'unidad',
            'cost': row['precio_compra'] ?? 0,
            'price': row['precio_venta'] ?? 0,
            'taxRate': row['tasa_itbis'] ?? 0.18,
            'taxIncluded': (row['itbis_incluido'] as int? ?? 1) == 1,
            'imageUrl': row['imagen_path']?.toString(),
            'stock':
                stockByProductAndBranch['${row['id']}:${row['sucursal_id']}'] ??
                    0,
            'minStock': row['stock_minimo'] ?? 0,
            'isActive': (row['activo'] as int? ?? 1) == 1,
            'branchId': branchRemoteIds[row['sucursal_id']?.toString()],
            'updatedAt': FieldValue.serverTimestamp(),
          };
          if (shouldPublishToPos) {
            payload.addAll({
              'origin': 'app_movil',
              'origen': 'app_movil',
              'synced': false,
              'sincronizado': false,
              'syncStatus': 'pending',
              'mobileProductId': row['id']!.toString(),
            });
          }
          batch.set(
            collection.doc(remoteId),
            payload,
            SetOptions(merge: true),
          );
          written++;
        }
        await batch.commit();
      }
      return written;
    } on FirebaseException {
      // Los cajeros no tienen permiso de escritura. Eso es esperado: siguen
      // con el pull y reciben el catálogo publicado por un administrador.
      return 0;
    }
  }

  Future<CloudBusinessSyncResult> pullInitial({
    required String localBusinessId,
    required String remoteBusinessId,
    required String localUserId,
    required String deviceId,
  }) async {
    final business = _firestore.collection('businesses').doc(remoteBusinessId);
    // Cada consulta conserva su propio error. Un módulo todavía no
    // autorizado o no creado nunca debe dejar vacíos todos los demás.
    final categories = await _safeGet(business.collection('categories'));
    final productsSnapshot = await _safeGet(business.collection('products'));
    final customersSnapshot = await _safeGet(business.collection('customers'));
    final salesSnapshot = await _safeGet(business.collection('sales'));
    final localBranches = await _db.query(
      'sucursales',
      columns: ['remoto_id'],
      where: 'empresa_id = ? AND remoto_id IS NOT NULL',
      whereArgs: [localBusinessId],
    );
    final allowedBranchIds = localBranches
        .map((row) => row['remoto_id']!.toString())
        .take(10)
        .toList();
    final usersQuery = allowedBranchIds.isEmpty
        ? business.collection('users').limit(0)
        : business
            .collection('users')
            .where('branchIds', arrayContainsAny: allowedBranchIds);
    final usersSnapshot = await usersQuery.get();

    var products = 0;
    var customers = 0;
    var sales = 0;
    var conflicts = 0;
    var users = 0;

    await _db.transaction((txn) async {
      final categoryIds = await _syncCategories(
        txn,
        categories,
        localBusinessId,
        deviceId,
      );
      final productResult = await _syncProducts(
        txn,
        productsSnapshot,
        localBusinessId,
        deviceId,
        categoryIds,
      );
      products = productResult.applied;
      conflicts += productResult.conflicts;

      final customerResult = await _syncCustomers(
        txn,
        customersSnapshot,
        localBusinessId,
        deviceId,
      );
      customers = customerResult.applied;
      conflicts += customerResult.conflicts;

      final saleResult = await _syncSales(
        txn,
        salesSnapshot,
        localBusinessId,
        localUserId,
        deviceId,
      );
      sales = saleResult.applied;
      conflicts += saleResult.conflicts;
      users = await _syncUsers(
        txn,
        usersSnapshot,
        localBusinessId,
        deviceId,
      );
    });

    return CloudBusinessSyncResult(
      products: products,
      customers: customers,
      sales: sales,
      users: users,
      conflicts: conflicts,
    );
  }

  Future<int> _syncUsers(
    Transaction txn,
    QuerySnapshot<Map<String, dynamic>> snapshot,
    String businessId,
    String deviceId,
  ) async {
    final branches = await _remoteToLocalIds(txn, 'sucursales');
    final now = DateTime.now().toIso8601String();
    var applied = 0;
    final visibleUids = snapshot.docs.map((doc) => doc.id).toSet();
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final existingRows = await txn.query(
        'usuarios',
        where: 'firebase_uid = ? OR remoto_id = ?',
        whereArgs: [doc.id, data['posUserId']?.toString() ?? doc.id],
        limit: 1,
      );
      final existing = existingRows.firstOrNull;
      if (existing != null && !_canApply(existing)) continue;
      final displayName =
          (data['displayName'] ?? data['email'] ?? 'Usuario').toString().trim();
      final parts = displayName.split(RegExp(r'\s+'));
      final branchIds = data['branchIds'] as List? ?? const [];
      await txn.insert(
        'usuarios',
        {
          'id': existing?['id'] ?? IdGenerator.newId(),
          'empresa_id': businessId,
          'sucursal_id':
              branchIds.isEmpty ? null : branches[branchIds.first.toString()],
          'nombre': parts.first,
          'apellido': parts.length > 1 ? parts.skip(1).join(' ') : null,
          'usuario':
              (data['email']?.toString() ?? displayName).split('@').first,
          'email': data['email']?.toString(),
          'rol': _role(data['role']?.toString()),
          'firebase_uid': doc.id,
          'activo': data['isActive'] == false ? 0 : 1,
          'dispositivo_id': deviceId,
          'creado_en': existing?['creado_en'] ?? now,
          'actualizado_en': now,
          'version': (existing?['version'] as int? ?? 0) + 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': data['posUserId']?.toString() ?? doc.id,
          'eliminado': 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      applied++;
    }
    final localUsers = await txn.query(
      'usuarios',
      columns: ['id', 'firebase_uid', 'sync_estado'],
      where: 'empresa_id = ?',
      whereArgs: [businessId],
    );
    for (final local in localUsers) {
      final uid = local['firebase_uid']?.toString();
      if (uid != null &&
          !visibleUids.contains(uid) &&
          local['sync_estado'] == 'sincronizado') {
        await txn.delete('usuarios', where: 'id = ?', whereArgs: [local['id']]);
      }
    }
    return applied;
  }

  String _role(String? value) {
    return switch (value?.toLowerCase()) {
      'owner' || 'businessowner' || 'admin' => 'administradorGeneral',
      'branch_admin' || 'administradorsucursal' => 'administradorSucursal',
      'supervisor' => 'supervisor',
      'accountant' || 'contador' => 'contador',
      'delivery' => 'delivery',
      _ => 'cajero',
    };
  }

  Future<QuerySnapshot<Map<String, dynamic>>> _safeGet(
    CollectionReference<Map<String, dynamic>> collection,
  ) async {
    try {
      return await collection.get();
    } catch (error) {
      // Se relanza con el nombre exacto del módulo para que Ajustes pueda
      // mostrar un diagnóstico útil, pero las consultas anteriores ya
      // descargadas no se pierden.
      throw StateError('No se pudo descargar ${collection.id}: $error');
    }
  }

  Future<Map<String, String>> _syncCategories(
    Transaction txn,
    QuerySnapshot<Map<String, dynamic>> snapshot,
    String businessId,
    String deviceId,
  ) async {
    final result = <String, String>{};
    final now = DateTime.now().toIso8601String();
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final name = (data['name'] ?? data['nombre'] ?? '').toString().trim();
      if (name.isEmpty) continue;
      final existing = await txn.query(
        'categorias',
        where: 'empresa_id = ? AND (remoto_id = ? OR lower(nombre) = ?)',
        whereArgs: [businessId, doc.id, name.toLowerCase()],
        limit: 1,
      );
      final id = existing.isEmpty
          ? IdGenerator.newId()
          : existing.first['id']! as String;
      result[name.toLowerCase()] = id;
      if (existing.isNotEmpty && !_canApply(existing.first)) continue;
      await txn.insert(
        'categorias',
        {
          'id': id,
          'nombre': name,
          'orden': data['order'] as int? ?? 0,
          'activa': data['isActive'] == false ? 0 : 1,
          'empresa_id': businessId,
          'dispositivo_id': deviceId,
          'creado_en': existing.isEmpty ? now : existing.first['creado_en'],
          'actualizado_en': now,
          'version':
              ((existing.isEmpty ? null : existing.first['version']) as int? ??
                      0) +
                  1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': doc.id,
          'eliminado': 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    return result;
  }

  Future<_ApplyResult> _syncProducts(
    Transaction txn,
    QuerySnapshot<Map<String, dynamic>> snapshot,
    String businessId,
    String deviceId,
    Map<String, String> categoryIds,
  ) async {
    var applied = 0;
    var conflicts = 0;
    final now = DateTime.now().toIso8601String();
    final branches = await _remoteToLocalIds(txn, 'sucursales');
    final defaultBranchId = branches.values.firstOrNull;

    for (final doc in snapshot.docs) {
      final data = doc.data();
      final name = (data['name'] ?? '').toString().trim();
      final matches = await txn.query(
        'productos',
        where: '''
          empresa_id = ? AND eliminado = 0 AND (
            remoto_id = ? OR
            (codigo_barras IS NOT NULL AND codigo_barras != '' AND codigo_barras = ?) OR
            (sku IS NOT NULL AND sku != '' AND sku = ?) OR
            (lower(trim(nombre)) = ? AND abs(precio_venta - ?) < 0.001)
          )
        ''',
        whereArgs: [
          businessId,
          doc.id,
          (data['barcode'] ?? data['sku'])?.toString(),
          data['sku']?.toString(),
          name.toLowerCase(),
          _number(data['price']),
        ],
        orderBy: 'actualizado_en DESC',
        limit: 1,
      );
      final existing = matches.firstOrNull;
      if (existing != null && !_canApply(existing)) {
        await _recordConflict(
            txn, businessId, 'producto', existing['id']! as String, data);
        conflicts++;
        continue;
      }
      final id = existing?['id'] as String? ?? IdGenerator.newId();
      final category = data['category']?.toString().trim().toLowerCase();
      await txn.insert(
        'productos',
        {
          'id': id,
          'nombre': name,
          'sku': data['sku']?.toString(),
          'codigo_barras': (data['barcode'] ?? data['sku'])?.toString(),
          'categoria_id': category == null ? null : categoryIds[category],
          'marca': data['brand']?.toString(),
          'unidad_medida': data['unit']?.toString() ?? 'unidad',
          'precio_compra': _number(data['cost']),
          'precio_venta': _number(data['price']),
          'tasa_itbis': _number(data['taxRate'], fallback: 0.18),
          'itbis_incluido': data['taxIncluded'] == false ? 0 : 1,
          'imagen_path': data['imageUrl']?.toString(),
          'stock_minimo': _number(data['minStock']),
          'activo': data['isActive'] == false ? 0 : 1,
          'empresa_id': businessId,
          'sucursal_id':
              _localId(branches, data['branchId']) ?? defaultBranchId,
          'dispositivo_id': deviceId,
          'creado_en': existing?['creado_en'] ?? now,
          'actualizado_en': now,
          'version': (existing?['version'] as int? ?? 0) + 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': doc.id,
          'eliminado': 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      final branchId = _localId(branches, data['branchId']) ?? defaultBranchId;
      if (branchId != null) {
        final inventory = await txn.query(
          'inventario_sucursal',
          where: 'producto_id = ? AND sucursal_id = ?',
          whereArgs: [id, branchId],
          limit: 1,
        );
        await txn.insert(
          'inventario_sucursal',
          {
            'id':
                inventory.isEmpty ? IdGenerator.newId() : inventory.first['id'],
            'producto_id': id,
            'stock': _number(data['stock']),
            'stock_minimo': _number(data['minStock']),
            'empresa_id': businessId,
            'sucursal_id': branchId,
            'dispositivo_id': deviceId,
            'creado_en': inventory.isEmpty ? now : inventory.first['creado_en'],
            'actualizado_en': now,
            'version': ((inventory.isEmpty ? null : inventory.first['version'])
                        as int? ??
                    0) +
                1,
            'sync_estado': 'sincronizado',
            'sincronizado_en': now,
            'remoto_id': '${doc.id}:$branchId',
            'eliminado': 0,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
      applied++;
    }
    return _ApplyResult(applied, conflicts);
  }

  Future<_ApplyResult> _syncCustomers(
    Transaction txn,
    QuerySnapshot<Map<String, dynamic>> snapshot,
    String businessId,
    String deviceId,
  ) async {
    var applied = 0;
    var conflicts = 0;
    final now = DateTime.now().toIso8601String();
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final existing = await _byRemoteId(txn, 'clientes', doc.id);
      if (existing != null && !_canApply(existing)) {
        await _recordConflict(
            txn, businessId, 'cliente', existing['id']! as String, data);
        conflicts++;
        continue;
      }
      await txn.insert(
        'clientes',
        {
          'id': existing?['id'] ?? IdGenerator.newId(),
          'nombre': (data['name'] ?? '').toString(),
          'telefono': data['phone']?.toString(),
          'whatsapp': data['phone']?.toString(),
          'email': data['email']?.toString(),
          'direccion': data['address']?.toString(),
          'cedula_rnc': data['taxId']?.toString(),
          'limite_credito': _number(data['creditLimit']),
          'balance': _number(data['totalDebt']),
          'activo': 1,
          'empresa_id': businessId,
          'dispositivo_id': deviceId,
          'creado_en': existing?['creado_en'] ?? now,
          'actualizado_en': now,
          'version': (existing?['version'] as int? ?? 0) + 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': doc.id,
          'eliminado': 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      applied++;
    }
    return _ApplyResult(applied, conflicts);
  }

  Future<_ApplyResult> _syncSales(
    Transaction txn,
    QuerySnapshot<Map<String, dynamic>> snapshot,
    String businessId,
    String userId,
    String deviceId,
  ) async {
    var applied = 0;
    var conflicts = 0;
    final branches = await _remoteToLocalIds(txn, 'sucursales');
    final registers = await _remoteToLocalIds(txn, 'cajas');
    final products = await _remoteToLocalIds(txn, 'productos');
    final customers = await _remoteToLocalIds(txn, 'clientes');
    final users = await _remoteToLocalIds(txn, 'usuarios');

    for (final doc in snapshot.docs) {
      final data = doc.data();
      final existing = await _byRemoteId(txn, 'ventas', doc.id);
      if (existing != null && !_canApply(existing)) {
        await _recordConflict(
            txn, businessId, 'venta', existing['id']! as String, data);
        conflicts++;
        continue;
      }
      final id = existing?['id'] as String? ?? IdGenerator.newId();
      final createdAt = _date(data['createdAt']);
      final now = DateTime.now().toIso8601String();
      await txn.insert(
        'ventas',
        {
          'id': id,
          'numero_factura': data['invoiceNumber']?.toString().isEmpty == true
              ? doc.id
              : data['invoiceNumber']?.toString(),
          'tipo_documento': data['invoiceType']?.toString() ?? 'ticket',
          'cliente_id': _localId(customers, data['customerId']),
          'usuario_id': _localId(users, data['cashierId']) ?? userId,
          'subtotal': _number(data['subtotal']),
          'descuento_monto': _number(data['discount']),
          'itbis': _number(data['tax']),
          'total': _number(data['total']),
          'moneda': 'DOP',
          'metodo_pago': _paymentMethod(data['paymentMethod']),
          'estado': data['status'] == 'cancelled' ? 'anulada' : 'completada',
          'motivo_anulacion': data['cancelReason']?.toString(),
          'empresa_id': businessId,
          'sucursal_id': _localId(branches, data['branchId']),
          'caja_id': _localId(registers, data['cashRegisterId']),
          'dispositivo_id': deviceId,
          'creado_en': createdAt.toIso8601String(),
          'actualizado_en': now,
          'version': (existing?['version'] as int? ?? 0) + 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': doc.id,
          'eliminado': 0,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

      await txn.delete('venta_items', where: 'venta_id = ?', whereArgs: [id]);
      final items = data['items'] as List? ?? const [];
      for (var index = 0; index < items.length; index++) {
        final item =
            Map<String, dynamic>.from(items[index] as Map? ?? const {});
        final quantity = _number(item['quantity']);
        final price = _number(item['price']);
        final discount = _number(item['discount']);
        await txn.insert('venta_items', {
          'id': IdGenerator.newId(),
          'venta_id': id,
          'producto_id': _localId(products, item['productId']) ??
              'remote:${item['productId']}',
          'nombre_producto_snapshot':
              (item['productName'] ?? 'Producto').toString(),
          'cantidad': quantity,
          'precio_unitario': price,
          'precio_original': price,
          'descuento_monto': discount,
          'tasa_itbis': 0,
          'subtotal_linea': (quantity * price) - discount,
          'empresa_id': businessId,
          'sucursal_id': _localId(branches, data['branchId']),
          'caja_id': _localId(registers, data['cashRegisterId']),
          'dispositivo_id': deviceId,
          'creado_en': createdAt.toIso8601String(),
          'actualizado_en': now,
          'version': 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now,
          'remoto_id': '${doc.id}:$index',
          'eliminado': 0,
        });
      }
      applied++;
    }
    return _ApplyResult(applied, conflicts);
  }

  Future<Map<String, Object?>?> _byRemoteId(
    Transaction txn,
    String table,
    String remoteId,
  ) async {
    final rows = await txn.query(
      table,
      where: 'remoto_id = ?',
      whereArgs: [remoteId],
      limit: 1,
    );
    return rows.firstOrNull;
  }

  Future<Map<String, String>> _remoteToLocalIds(
      Transaction txn, String table) async {
    final rows = await txn.query(
      table,
      columns: ['id', 'remoto_id'],
      where: 'remoto_id IS NOT NULL',
    );
    return {
      for (final row in rows)
        if (row['remoto_id'] != null)
          row['remoto_id']!.toString(): row['id']!.toString(),
    };
  }

  String? _localId(Map<String, String> ids, Object? remoteId) {
    if (remoteId == null) return null;
    return ids[remoteId.toString()];
  }

  bool _canApply(Map<String, Object?> row) {
    return row['sync_estado'] == null || row['sync_estado'] == 'sincronizado';
  }

  Future<void> _recordConflict(
    Transaction txn,
    String businessId,
    String type,
    String entityId,
    Map<String, dynamic> remote,
  ) {
    final now = DateTime.now().toIso8601String();
    return txn.insert('registro_auditoria', {
      'id': IdGenerator.newId(),
      'empresa_id': businessId,
      'accion': 'conflicto_sincronizacion',
      'entidad_tipo': type,
      'entidad_id': entityId,
      'detalle_json':
          jsonEncode({'origen': 'cloud', 'remote': _jsonSafe(remote)}),
      'ocurrido_en': now,
      'sincronizado': 0,
    });
  }

  Map<String, dynamic> _jsonSafe(Map<String, dynamic> value) {
    return value.map((key, item) {
      if (item is Timestamp) {
        return MapEntry(key, item.toDate().toIso8601String());
      }
      if (item is Map) {
        return MapEntry(key, _jsonSafe(Map<String, dynamic>.from(item)));
      }
      if (item is List) {
        return MapEntry(
          key,
          item.map((entry) {
            if (entry is Timestamp) return entry.toDate().toIso8601String();
            if (entry is Map) {
              return _jsonSafe(Map<String, dynamic>.from(entry));
            }
            return entry;
          }).toList(),
        );
      }
      return MapEntry(key, item);
    });
  }

  double _number(Object? value, {double fallback = 0}) {
    if (value is num) return value.toDouble();
    return double.tryParse(value?.toString() ?? '') ?? fallback;
  }

  DateTime _date(Object? value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    return DateTime.tryParse(value?.toString() ?? '') ?? DateTime.now();
  }

  String _paymentMethod(Object? value) {
    return switch (value?.toString().toLowerCase()) {
      'card' || 'tarjeta' => 'tarjeta',
      'transfer' || 'transferencia' => 'transferencia',
      'credit' || 'credito' => 'credito',
      'mixed' || 'combinado' => 'combinado',
      _ => 'efectivo',
    };
  }
}

class _ApplyResult {
  const _ApplyResult(this.applied, this.conflicts);
  final int applied;
  final int conflicts;
}

final cloudBusinessSyncRepositoryProvider =
    Provider<CloudBusinessSyncRepository>((ref) {
  return CloudBusinessSyncRepository(
    ref.watch(databaseProvider),
    FirebaseFirestore.instance,
  );
});
