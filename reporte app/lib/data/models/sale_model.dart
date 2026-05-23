import 'package:cloud_firestore/cloud_firestore.dart';

enum PaymentMethod { cash, card, credit, transfer, mixed }
enum SaleStatus { completed, cancelled, pending }

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
  });

  double get profit => items.fold(0, (acc, i) => acc + i.profit);

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
      createdAt: (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
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
