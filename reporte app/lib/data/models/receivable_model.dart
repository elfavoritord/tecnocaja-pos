import 'package:cloud_firestore/cloud_firestore.dart';

enum ReceivableStatus { pending, partial, paid, overdue }

class ReceivablePayment {
  final double amount;
  final DateTime date;
  final String method;

  const ReceivablePayment({
    required this.amount,
    required this.date,
    required this.method,
  });

  factory ReceivablePayment.fromMap(Map<String, dynamic> m) => ReceivablePayment(
        amount: (m['amount'] ?? 0).toDouble(),
        date: (m['date'] as Timestamp?)?.toDate() ?? DateTime.now(),
        method: m['method'] ?? 'Efectivo',
      );
}

class ReceivableModel {
  final String id;
  final String customerId;
  final String customerName;
  final String? branchId;
  final String? branchName;
  final double total;
  final double paid;
  final DateTime? dueDate;
  final ReceivableStatus status;
  final List<ReceivablePayment> payments;
  final DateTime createdAt;

  const ReceivableModel({
    required this.id,
    required this.customerId,
    required this.customerName,
    this.branchId,
    this.branchName,
    required this.total,
    required this.paid,
    this.dueDate,
    required this.status,
    required this.payments,
    required this.createdAt,
  });

  double get balance => total - paid;
  bool get isOverdue =>
      dueDate != null && dueDate!.isBefore(DateTime.now()) && status != ReceivableStatus.paid;

  factory ReceivableModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return ReceivableModel(
      id: doc.id,
      customerId: d['customerId'] ?? '',
      customerName: d['customerName'] ?? '',
      branchId: d['branchId'],
      branchName: d['branchName'],
      total: (d['total'] ?? 0).toDouble(),
      paid: (d['paid'] ?? 0).toDouble(),
      dueDate: (d['dueDate'] as Timestamp?)?.toDate(),
      status: _statusFromString(d['status'] ?? 'pending'),
      payments: (d['payments'] as List<dynamic>? ?? [])
          .map((p) => ReceivablePayment.fromMap(p as Map<String, dynamic>))
          .toList(),
      createdAt: (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
  }

  static ReceivableStatus _statusFromString(String s) {
    switch (s) {
      case 'partial': return ReceivableStatus.partial;
      case 'paid': return ReceivableStatus.paid;
      case 'overdue': return ReceivableStatus.overdue;
      default: return ReceivableStatus.pending;
    }
  }
}
