import 'package:cloud_firestore/cloud_firestore.dart';

class CashClosingModel {
  final String id;
  final String cashRegisterId;
  final String branchId;
  final String branchName;
  final String openedBy;
  final String closedBy;
  final DateTime? openedAt;
  final DateTime? closedAt;
  final double openingAmount;
  final double closingAmount;
  final double expectedAmount;
  final double difference;
  final double totalSales;
  final double totalIncome;
  final double totalExpenses;
  final double totalWithdrawals;
  final String? notes;

  const CashClosingModel({
    required this.id,
    required this.cashRegisterId,
    required this.branchId,
    required this.branchName,
    required this.openedBy,
    required this.closedBy,
    this.openedAt,
    this.closedAt,
    required this.openingAmount,
    required this.closingAmount,
    required this.expectedAmount,
    required this.difference,
    required this.totalSales,
    required this.totalIncome,
    required this.totalExpenses,
    required this.totalWithdrawals,
    this.notes,
  });

  bool get hasDiscrepancy => difference.abs() > 0.01;

  factory CashClosingModel.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>;

    double readNumber(List<String> keys) {
      for (final key in keys) {
        final value = data[key];
        if (value is num) return value.toDouble();
        if (value != null) {
          final parsed = double.tryParse(value.toString());
          if (parsed != null) return parsed;
        }
      }
      return 0;
    }

    double? readNullableNumber(List<String> keys) {
      for (final key in keys) {
        final value = data[key];
        if (value is num) return value.toDouble();
        if (value != null) return double.tryParse(value.toString());
      }
      return null;
    }

    String readString(List<String> keys, [String fallback = '']) {
      for (final key in keys) {
        final value = data[key];
        if (value != null) {
          final normalized = value.toString().trim();
          if (normalized.isNotEmpty) return normalized;
        }
      }
      return fallback;
    }

    Timestamp? readTimestamp(List<String> keys) {
      for (final key in keys) {
        final value = data[key];
        if (value is Timestamp) return value;
      }
      return null;
    }

    final openingAmount = readNumber([
      'openingAmount',
      'openingBalance',
      'opening_amount',
      'apertura',
      'montoApertura',
    ]);
    final closingAmount = readNumber([
      'closingAmount',
      'closingBalance',
      'closing_amount',
      'cierre',
      'montoCierre',
      'countedAmount',
    ]);
    final expectedAmount = readNumber([
      'expectedAmount',
      'expectedBalance',
      'expected_amount',
      'montoEsperado',
    ]);
    final storedDifference = readNullableNumber([
      'difference',
      'differenceAmount',
      'difference_amount',
      'diferencia',
    ]);

    return CashClosingModel(
      id: doc.id,
      cashRegisterId: readString([
        'cashRegisterId',
        'cash_register_id',
        'cajaId',
      ]),
      branchId: readString(['branchId', 'branch_id', 'sucursalId']),
      branchName: readString([
        'branchName',
        'branch_name',
        'sucursal',
        'sucursalNombre',
      ], 'Principal'),
      openedBy: readString(['openedBy', 'opened_by', 'abiertaPor']),
      closedBy: readString(['closedBy', 'closed_by', 'cerradaPor']),
      openedAt: readTimestamp(['openedAt', 'opened_at', 'abiertaEn'])?.toDate(),
      closedAt: readTimestamp([
        'closedAt',
        'closed_at',
        'cerradaEn',
        'createdAt',
      ])?.toDate(),
      openingAmount: openingAmount,
      closingAmount: closingAmount,
      expectedAmount: expectedAmount,
      difference: storedDifference ?? (closingAmount - expectedAmount),
      totalSales: readNumber(['totalSales', 'sales', 'ventas']),
      totalIncome: readNumber(['totalIncome', 'income', 'ingresos']),
      totalExpenses: readNumber(['totalExpenses', 'expenses', 'gastos']),
      totalWithdrawals: readNumber([
        'totalWithdrawals',
        'withdrawals',
        'retiros',
      ]),
      notes: data['notes']?.toString(),
    );
  }
}
