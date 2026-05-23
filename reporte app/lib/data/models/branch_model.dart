import 'package:cloud_firestore/cloud_firestore.dart';

class BranchModel {
  final String id;
  final String name;
  final String? address;
  final String? phone;
  final double totalSales;
  final int totalInvoices;
  final double totalExpenses;
  final bool isActive;

  const BranchModel({
    required this.id,
    required this.name,
    this.address,
    this.phone,
    required this.totalSales,
    required this.totalInvoices,
    required this.totalExpenses,
    required this.isActive,
  });

  factory BranchModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return BranchModel(
      id: doc.id,
      name: d['name'] ?? '',
      address: d['address'],
      phone: d['phone'],
      totalSales: (d['totalSales'] ?? 0).toDouble(),
      totalInvoices: (d['totalInvoices'] ?? 0).toInt(),
      totalExpenses: (d['totalExpenses'] ?? 0).toDouble(),
      isActive: d['isActive'] ?? true,
    );
  }
}
