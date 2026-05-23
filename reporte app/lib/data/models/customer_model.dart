import 'package:cloud_firestore/cloud_firestore.dart';

class CustomerModel {
  final String id;
  final String name;
  final String? email;
  final String? phone;
  final String? branchId;
  final String? branchName;
  final double totalPurchases;
  final int visitCount;
  final double totalDebt;
  final DateTime? lastPurchaseAt;
  final DateTime createdAt;

  const CustomerModel({
    required this.id,
    required this.name,
    this.email,
    this.phone,
    this.branchId,
    this.branchName,
    required this.totalPurchases,
    required this.visitCount,
    required this.totalDebt,
    this.lastPurchaseAt,
    required this.createdAt,
  });

  bool get hasDebt => totalDebt > 0;
  double get avgTicket => visitCount > 0 ? totalPurchases / visitCount : 0;

  factory CustomerModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return CustomerModel(
      id: doc.id,
      name: d['name'] ?? '',
      email: d['email'],
      phone: d['phone'],
      branchId: d['branchId'],
      branchName: d['branchName'],
      totalPurchases: (d['totalPurchases'] ?? 0).toDouble(),
      visitCount: (d['visitCount'] ?? 0).toInt(),
      totalDebt: (d['totalDebt'] ?? 0).toDouble(),
      lastPurchaseAt: (d['lastPurchaseAt'] as Timestamp?)?.toDate(),
      createdAt: (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
  }
}
