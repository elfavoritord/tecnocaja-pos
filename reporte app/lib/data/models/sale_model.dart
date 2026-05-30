import 'package:cloud_firestore/cloud_firestore.dart';

enum PaymentMethod { cash, card, credit, transfer, mixed }
enum SaleStatus { completed, cancelled, pending }

/// Estado de sincronización del documento con el POS.
enum SyncStatus { synced, pending, error }

extension PaymentMethodExt on PaymentMethod {
  String get label {
    switch (this) {
      case PaymentMethod.cash: return 'Efectivo';
      case PaymentMethod.card: return 'Tarjeta';
      case PaymentMethod.credit: return 'Crédito';
      case PaymentMethod.transfer: return 'Transferencia';
      case PaymentMethod.mixed: return 'Mixto';
    }
  }
}

class SaleItem {
  final String productId;
  final String productName;
  final String category;
  final double quantity;
  final double price;
  final double cost;
  final double discount;

  const SaleItem({
    required this.productId,
    required this.productName,
    required this.category,
    required this.quantity,
    required this.price,
    required this.cost,
    required this.discount,
  });

  double get subtotal => quantity * price;
  double get totalAfterDiscount => subtotal - discount;
  double get profit => (price - cost) * quantity;

  factory SaleItem.fromMap(Map<String, dynamic> map) => SaleItem(
        productId: map['productId'] ?? '',
        productName: map['productName'] ?? '',
        category: map['category'] ?? '',
        quantity: (map['quantity'] ?? 0).toDouble(),
        price: (map['price'] ?? 0).toDouble(),
        cost: (map['cost'] ?? 0).toDouble(),
        discount: (map['discount'] ?? 0).toDouble(),
      );
}

class SaleModel {
  final String id;
  final String branchId;
  final String branchName;
  final String cashRegisterId;
  final String cashierName;
  final String? customerId;
  final String? customerName;
  final List<SaleItem> items;
  final double subtotal;
  final double discount;
  final double tax;
  final double total;
  final PaymentMethod paymentMethod;
  final SaleStatus status;
  final String? invoiceNumber;
  final String? invoiceType;
  final DateTime createdAt;

  // Campos extendidos para filtrado correcto y cumplimiento de las reglas del sistema.
  final DateTime? accountingDate;   // Fecha contable (puede diferir de createdAt en turnos nocturnos).
  final String? sessionId;          // ID del turno/sesión de caja activa.
  final String? ncfType;            // Tipo de comprobante NCF: 01, 02, 14, 15, etc.
  final String source;              // Origen del registro: siempre 'POS' en este sistema.
  final SyncStatus syncStatus;      // Estado de sincronización con el POS.
  final DateTime? cancelledAt;      // Fecha/hora de anulación si aplica.
  final String? cancelReason;       // Motivo de anulación si aplica.

  const SaleModel({
    required this.id,
    required this.branchId,
    required this.branchName,
    required this.cashRegisterId,
    required this.cashierName,
    this.customerId,
    this.customerName,
    required this.items,
    required this.subtotal,
    required this.discount,
    required this.tax,
    required this.total,
    required this.paymentMethod,
    required this.status,
    this.invoiceNumber,
    this.invoiceType,
    required this.createdAt,
    this.accountingDate,
    this.sessionId,
    this.ncfType,
    this.source = 'POS',
    this.syncStatus = SyncStatus.synced,
    this.cancelledAt,
    this.cancelReason,
  });

  double get profit => items.fold(0, (acc, i) => acc + i.profit);

  /// Devuelve true si la venta no debe contarse en los totales activos.
  bool get isVoid =>
      status == SaleStatus.cancelled || status == SaleStatus.pending;

  /// Fecha efectiva para filtros de reportes diarios.
  DateTime get effectiveDate => accountingDate ?? createdAt;

  factory SaleModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return SaleModel(
      id: doc.id,
      branchId: d['branchId'] ?? '',
      branchName: d['branchName'] ?? '',
      cashRegisterId: d['cashRegisterId'] ?? '',
      cashierName: d['cashierName'] ?? '',
      customerId: d['customerId'],
      customerName: d['customerName'],
      items: (d['items'] as List<dynamic>? ?? [])
          .map((i) => SaleItem.fromMap(i as Map<String, dynamic>))
          .toList(),
      subtotal: (d['subtotal'] ?? 0).toDouble(),
      discount: (d['discount'] ?? 0).toDouble(),
      tax: (d['tax'] ?? 0).toDouble(),
      total: (d['total'] ?? 0).toDouble(),
      paymentMethod: _paymentFromString(d['paymentMethod'] ?? 'cash'),
      status: _statusFromString(d['status'] ?? 'completed'),
      invoiceNumber: d['invoiceNumber'],
      invoiceType: d['invoiceType'],
      createdAt: _toDateTime(d['createdAt']) ?? DateTime.now(),
      accountingDate: _toDateTime(d['accountingDate']),
      sessionId: d['sessionId']?.toString(),
      ncfType: d['ncfType']?.toString(),
      source: d['source']?.toString() ?? 'POS',
      syncStatus: _syncStatusFromString(d['syncStatus']),
      cancelledAt: _toDateTime(d['cancelledAt']),
      cancelReason: d['cancelReason']?.toString(),
    );
  }

  static DateTime? _toDateTime(dynamic value) {
    if (value == null) return null;
    if (value is Timestamp) return value.toDate();
    if (value is String) return DateTime.tryParse(value);
    return null;
  }

  static SyncStatus _syncStatusFromString(dynamic value) {
    switch (value?.toString()) {
      case 'pending': return SyncStatus.pending;
      case 'error': return SyncStatus.error;
      default: return SyncStatus.synced;
    }
  }

  static PaymentMethod _paymentFromString(String s) {
    switch (s) {
      case 'card': return PaymentMethod.card;
      case 'credit': return PaymentMethod.credit;
      case 'transfer': return PaymentMethod.transfer;
      case 'mixed': return PaymentMethod.mixed;
      default: return PaymentMethod.cash;
    }
  }

  static SaleStatus _statusFromString(String s) {
    switch (s) {
      case 'cancelled': return SaleStatus.cancelled;
      case 'pending': return SaleStatus.pending;
      default: return SaleStatus.completed;
    }
  }
}
