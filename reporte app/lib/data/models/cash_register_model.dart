import 'package:cloud_firestore/cloud_firestore.dart';

enum CashRegisterStatus { open, closed }

class CashRegisterModel {
  final String id;
  final String name;
  final String branchId;
  final String branchName;
  final CashRegisterStatus status;
  final DateTime? openedAt;
  final DateTime? closedAt;
  final String openedBy;
  final double openingAmount;
  final double closingAmount;
  final double expectedAmount;
  final double totalIncome;
  final double totalExpenses;
  final double totalWithdrawals;

  const CashRegisterModel({
    required this.id,
    required this.name,
    required this.branchId,
    required this.branchName,
    required this.status,
    this.openedAt,
    this.closedAt,
    required this.openedBy,
    required this.openingAmount,
    required this.closingAmount,
    required this.expectedAmount,
    required this.totalIncome,
    required this.totalExpenses,
    required this.totalWithdrawals,
  });

  double get difference => closingAmount - expectedAmount;
  bool get hasDiscrepancy => difference.abs() > 0.01;

  factory CashRegisterModel.fromFirestore(DocumentSnapshot doc) {
    final d = doc.data() as Map<String, dynamic>;

    // Helper: lee un campo numérico probando múltiples nombres de campo
    double readNumber(List<String> keys) {
      for (final k in keys) {
        final v = d[k];
        if (v != null) return (v as num).toDouble();
      }
      return 0.0;
    }

    // Helper: lee un string probando múltiples nombres de campo
    String str(List<String> keys, [String fallback = '']) {
      for (final k in keys) {
        final v = d[k];
        if (v != null && v.toString().isNotEmpty) return v.toString();
      }
      return fallback;
    }

    // Estado: admite 'open'/'abierta'/'abierto' y 'closed'/'cerrada'/'cerrado'
    final statusRaw = (d['status'] ?? d['estado'] ?? '').toString().toLowerCase();
    final isOpen = statusRaw == 'open' || statusRaw == 'abierta' || statusRaw == 'abierto';

    // Fecha de apertura / cierre
    Timestamp? ts(List<String> keys) {
      for (final k in keys) {
        final v = d[k];
        if (v is Timestamp) return v;
      }
      return null;
    }

    return CashRegisterModel(
      id: doc.id,
      name: str(['name', 'nombre', 'cashName', 'registerName'], 'Caja'),
      branchId: str(['branchId', 'sucursalId', 'branch_id']),
      branchName: str(['branchName', 'sucursal', 'branch_name', 'sucursalNombre'], 'Principal'),
      status: isOpen ? CashRegisterStatus.open : CashRegisterStatus.closed,
      openedAt: ts(['openedAt', 'abiertaEn', 'opened_at', 'fechaApertura', 'createdAt'])?.toDate(),
      closedAt: ts(['closedAt', 'cerradaEn', 'closed_at', 'fechaCierre'])?.toDate(),
      openedBy: str(['openedBy', 'abiertaPor', 'opened_by', 'usuario', 'userName']),
      openingAmount: readNumber(['openingAmount', 'openingBalance', 'opening_amount', 'apertura', 'montoApertura', 'initialAmount', 'opening']),
      closingAmount: readNumber(['closingAmount', 'closingBalance', 'closing_amount', 'cierre', 'montoCierre', 'finalAmount', 'closing']),
      expectedAmount: readNumber(['expectedAmount', 'expectedBalance', 'expected_amount', 'montoEsperado', 'expected']),
      totalIncome: readNumber(['totalIncome', 'income', 'total_income', 'ventas', 'totalVentas', 'sales', 'totalSales', 'ingresos']),
      totalExpenses: readNumber(['totalExpenses', 'expenses', 'total_expenses', 'gastos', 'totalGastos']),
      totalWithdrawals: readNumber(['totalWithdrawals', 'withdrawals', 'total_withdrawals', 'retiros', 'totalRetiros', 'cashOut']),
    );
  }
}
