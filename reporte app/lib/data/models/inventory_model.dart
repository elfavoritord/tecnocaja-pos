import 'package:cloud_firestore/cloud_firestore.dart';

enum StockStatus { ok, low, critical, outOfStock }

class ProductModel {
  final String id;
  final String name;
  final String category;
  final double price;
  final double cost;
  final int stock;
  final int minStock;
  final bool isActive;
  final String? barcode;
  final String? imageUrl;
  final String? branchId;

  const ProductModel({
    required this.id,
    required this.name,
    required this.category,
    required this.price,
    required this.cost,
    required this.stock,
    required this.minStock,
    required this.isActive,
    this.barcode,
    this.imageUrl,
    this.branchId,
  });

  double get margin =>
      price > 0 && cost > 0 ? ((price - cost) / price) * 100 : 0;

  StockStatus get stockStatus {
    if (stock <= 0) return StockStatus.outOfStock;
    if (stock <= minStock ~/ 2) return StockStatus.critical;
    if (stock <= minStock) return StockStatus.low;
    return StockStatus.ok;
  }

  factory ProductModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return ProductModel(
      id: doc.id,
      name: d['name'] ?? d['nombre'] ?? '',
      category: d['category'] ?? d['categoria'] ?? '',
      price: _toDouble(d['price'] ?? d['precio'] ?? d['precioVenta']),
      cost: _toDouble(d['cost'] ?? d['costo'] ?? d['precioCompra']),
      stock: _toInt(d['stock']),
      minStock: _toInt(
        d['minStock'] ?? d['stockMin'] ?? d['stock_min'],
        fallback: 5,
      ),
      isActive: _toBool(d['isActive'], fallbackFromStatus: d['estado']),
      barcode: d['barcode'],
      imageUrl: d['imageUrl'],
      branchId: d['branchId']?.toString(),
    );
  }

  static double _toDouble(dynamic value) {
    if (value is num) return value.toDouble();
    return double.tryParse(value?.toString() ?? '') ?? 0;
  }

  static int _toInt(dynamic value, {int fallback = 0}) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '') ?? fallback;
  }

  static bool _toBool(dynamic value, {dynamic fallbackFromStatus}) {
    if (value is bool) return value;
    if (value != null) {
      final normalized = value.toString().trim().toLowerCase();
      if (['true', '1', 'activo', 'active'].contains(normalized)) {
        return true;
      }
      if ([
        'false',
        '0',
        'inactivo',
        'inactive',
        'eliminado',
      ].contains(normalized)) {
        return false;
      }
    }

    final status = fallbackFromStatus?.toString().trim().toLowerCase() ?? '';
    if (status.isEmpty) return true;
    return status == 'activo' || status == 'active';
  }
}

enum InventoryMovementType { in_, out, adjustment }

class InventoryMovement {
  final String id;
  final String productId;
  final String productName;
  final InventoryMovementType type;
  final int quantity;
  final String? reason;
  final String? branchId;
  final String createdBy;
  final DateTime createdAt;

  const InventoryMovement({
    required this.id,
    required this.productId,
    required this.productName,
    required this.type,
    required this.quantity,
    this.reason,
    this.branchId,
    required this.createdBy,
    required this.createdAt,
  });

  factory InventoryMovement.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return InventoryMovement(
      id: doc.id,
      productId: d['productId'] ?? '',
      productName: d['productName'] ?? '',
      type: _typeFromString(d['type'] ?? 'in'),
      quantity: (d['quantity'] ?? 0).toInt(),
      reason: d['reason'],
      branchId: d['branchId'],
      createdBy: d['createdBy'] ?? '',
      createdAt: (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
  }

  static InventoryMovementType _typeFromString(String s) {
    switch (s) {
      case 'out':
        return InventoryMovementType.out;
      case 'adjustment':
        return InventoryMovementType.adjustment;
      default:
        return InventoryMovementType.in_;
    }
  }
}
