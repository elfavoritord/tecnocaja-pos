import 'package:cloud_firestore/cloud_firestore.dart';

class ExpenseModel {
  final String id;
  final String category;
  final String description;
  final double amount;
  final String branchId;
  final String branchName;
  final String createdBy;
  final DateTime createdAt;

  const ExpenseModel({
    required this.id,
    required this.category,
    required this.description,
    required this.amount,
    required this.branchId,
    required this.branchName,
    required this.createdBy,
    required this.createdAt,
  });

  factory ExpenseModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;
    return ExpenseModel(
      id: doc.id,
      category: d['category'] ?? 'General',
      description: d['description'] ?? '',
      amount: (d['amount'] ?? 0).toDouble(),
      branchId: d['branchId'] ?? '',
      branchName: d['branchName'] ?? '',
      createdBy: d['createdBy'] ?? '',
      createdAt: (d['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
    );
  }
}
