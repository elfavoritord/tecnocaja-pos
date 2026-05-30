import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/cash_register_model.dart';
import '../models/expense_model.dart';
import '../models/inventory_model.dart';
import '../models/receivable_model.dart';
import '../models/sale_model.dart';

/// Repositorio unificado que obtiene datos de reportes directamente de Firestore,
/// sin depender del servidor HTTP de NovaPOS.
///
/// Colecciones que lee:
///   businesses/{businessId}/sales
///   businesses/{businessId}/cashRegisters
///   businesses/{businessId}/products
///   businesses/{businessId}/expenses
///   businesses/{businessId}/inventoryMovements
class FirestoreReportsRepository {
  FirestoreReportsRepository({FirebaseFirestore? db})
    : _db = db ?? FirebaseFirestore.instance;

  final FirebaseFirestore _db;
  static const _queryTimeout = Duration(seconds: 12);

  // ── Sales ─────────────────────────────────────────────────────────────────

  Future<List<SaleModel>> getSales({
    required String businessId,
    required DateTime from,
    required DateTime to,
    List<String>? branchIds,
    String? cashRegisterId,
    String? cashierName,
    SaleStatus? status,
    String? paymentMethod,
    int limit = 200,
  }) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(businessId)
        .collection('sales')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThanOrEqualTo: Timestamp.fromDate(to))
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get()
        .timeout(_queryTimeout);

    var sales = snapshot.docs
        .map((doc) => SaleModel.fromFirestore(doc))
        .toList();

    // Filtros adicionales en memoria
    if (branchIds != null && branchIds.isNotEmpty) {
      sales = sales.where((s) => branchIds.contains(s.branchId)).toList();
    }
    if (cashRegisterId != null && cashRegisterId.isNotEmpty) {
      sales = sales.where((s) => s.cashRegisterId == cashRegisterId).toList();
    }
    if (cashierName != null && cashierName.isNotEmpty) {
      sales = sales.where((s) => s.cashierName == cashierName).toList();
    }
    if (status != null) {
      sales = sales.where((s) => s.status == status).toList();
    }
    if (paymentMethod != null && paymentMethod.isNotEmpty) {
      sales = sales
          .where((s) => s.paymentMethod.name == paymentMethod)
          .toList();
    }

    return sales;
  }

  /// Stream en tiempo real de las ventas de hoy.
  Stream<List<SaleModel>> watchTodaySales(String businessId) {
    final now = DateTime.now();
    final todayStart = DateTime(now.year, now.month, now.day);
    return _db
        .collection('businesses')
        .doc(businessId)
        .collection('sales')
        .where(
          'createdAt',
          isGreaterThanOrEqualTo: Timestamp.fromDate(todayStart),
        )
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snap) =>
              snap.docs.map((doc) => SaleModel.fromFirestore(doc)).toList(),
        );
  }

  // ── Cash Registers ────────────────────────────────────────────────────────

  Future<List<CashRegisterModel>> getCashRegisters({
    required String businessId,
    List<String>? branchIds,
  }) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(businessId)
        .collection('cashRegisters')
        .get()
        .timeout(_queryTimeout);

    var registers = snapshot.docs
        .map((doc) => CashRegisterModel.fromFirestore(doc))
        .toList();

    if (branchIds != null && branchIds.isNotEmpty) {
      registers = registers
          .where((r) => branchIds.contains(r.branchId))
          .toList();
    }

    return registers;
  }

  Stream<List<CashRegisterModel>> watchCashRegisters(String businessId) {
    return _db
        .collection('businesses')
        .doc(businessId)
        .collection('cashRegisters')
        .snapshots()
        .map(
          (snap) => snap.docs
              .map((doc) => CashRegisterModel.fromFirestore(doc))
              .toList(),
        );
  }

  // ── Inventory / Products ──────────────────────────────────────────────────

  Future<List<ProductModel>> getProducts({
    required String businessId,
    bool onlyLowStock = false,
    String? branchId,
  }) async {
    var query = _db
        .collection('businesses')
        .doc(businessId)
        .collection('products')
        .orderBy('name');

    final snapshot = await query.get().timeout(_queryTimeout);
    var products = snapshot.docs
        .map((doc) => ProductModel.fromFirestore(doc))
        .toList();

    if (branchId != null && branchId.isNotEmpty) {
      products = products
          .where((p) => p.branchId == null || p.branchId == branchId)
          .toList();
    }
    if (onlyLowStock) {
      products = products
          .where((p) => p.stockStatus != StockStatus.ok)
          .toList();
    }

    return products;
  }

  Stream<List<ProductModel>> watchProducts(String businessId) {
    return _db
        .collection('businesses')
        .doc(businessId)
        .collection('products')
        .orderBy('name')
        .snapshots()
        .map(
          (snap) =>
              snap.docs.map((doc) => ProductModel.fromFirestore(doc)).toList(),
        );
  }

  Future<List<InventoryMovement>> getInventoryMovements({
    required String businessId,
    required DateTime from,
    required DateTime to,
    String? productId,
    String? branchId,
    int limit = 200,
  }) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(businessId)
        .collection('inventoryMovements')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThanOrEqualTo: Timestamp.fromDate(to))
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get()
        .timeout(_queryTimeout);

    var movements = snapshot.docs
        .map((doc) => InventoryMovement.fromFirestore(doc))
        .toList();

    if (productId != null && productId.isNotEmpty) {
      movements = movements.where((m) => m.productId == productId).toList();
    }
    if (branchId != null && branchId.isNotEmpty) {
      movements = movements.where((m) => m.branchId == branchId).toList();
    }

    return movements;
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  Future<List<ExpenseModel>> getExpenses({
    required String businessId,
    required DateTime from,
    required DateTime to,
    List<String>? branchIds,
    int limit = 200,
  }) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(businessId)
        .collection('expenses')
        .where('createdAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('createdAt', isLessThanOrEqualTo: Timestamp.fromDate(to))
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .get()
        .timeout(_queryTimeout);

    var expenses = snapshot.docs
        .map((doc) => ExpenseModel.fromFirestore(doc))
        .toList();

    if (branchIds != null && branchIds.isNotEmpty) {
      expenses = expenses.where((e) => branchIds.contains(e.branchId)).toList();
    }

    return expenses;
  }

  // ── Receivables (cuentas por cobrar) ─────────────────────────────────────

  Future<List<ReceivableModel>> getReceivables({
    required String businessId,
    List<String>? branchIds,
    bool onlyPending = true,
  }) async {
    var query = _db
        .collection('businesses')
        .doc(businessId)
        .collection('receivables')
        .orderBy('createdAt', descending: true)
        .limit(300);

    final snapshot = await query.get().timeout(_queryTimeout);
    var receivables = snapshot.docs
        .map((doc) => ReceivableModel.fromFirestore(doc))
        .toList();

    if (onlyPending) {
      receivables = receivables
          .where((r) => r.status != ReceivableStatus.paid)
          .toList();
    }
    if (branchIds != null && branchIds.isNotEmpty) {
      receivables = receivables
          .where((r) => r.branchId == null || branchIds.contains(r.branchId!))
          .toList();
    }
    return receivables;
  }

  // ── Resumen de ventas (para SalesSummary en sales_report_screen) ──────────

  Future<SalesSummaryResult> getSalesSummary({
    required String businessId,
    required DateTime from,
    required DateTime to,
    List<String>? branchIds,
  }) async {
    final all = await getSales(
      businessId: businessId,
      from: from,
      to: to,
      branchIds: branchIds,
      limit: 500,
    );

    // Solo contar ventas completadas: excluye canceladas Y pendientes.
    final completed = all
        .where((s) => s.status == SaleStatus.completed)
        .toList();
    final cancelled = all
        .where((s) => s.status == SaleStatus.cancelled)
        .toList();

    final totalGross = completed.fold<double>(0, (acc, s) => acc + s.total);
    final totalDiscount = completed.fold<double>(
      0,
      (acc, s) => acc + s.discount,
    );
    final totalTax = completed.fold<double>(0, (acc, s) => acc + s.tax);
    final totalProfit = completed.fold<double>(0, (acc, s) => acc + s.profit);
    final totalNet = totalGross - totalDiscount;
    final avgTicket = completed.isNotEmpty
        ? totalGross / completed.length
        : 0.0;

    // Desglose por método de pago
    final Map<String, double> byPayment = {};
    for (final s in completed) {
      final label = s.paymentMethod.label;
      byPayment[label] = (byPayment[label] ?? 0) + s.total;
    }

    // Desglose por sucursal
    final Map<String, double> byBranch = {};
    for (final s in completed) {
      final label = s.branchName.isNotEmpty ? s.branchName : s.branchId;
      byBranch[label] = (byBranch[label] ?? 0) + s.total;
    }

    return SalesSummaryResult(
      totalGross: totalGross,
      totalDiscount: totalDiscount,
      totalTax: totalTax,
      totalNet: totalNet,
      totalProfit: totalProfit,
      totalInvoices: completed.length,
      cancelledCount: cancelled.length,
      avgTicket: avgTicket,
      byPaymentMethod: byPayment,
      byBranch: byBranch,
      sales: completed,
    );
  }
}

// ── Modelo auxiliar para el resumen de ventas ─────────────────────────────

class SalesSummaryResult {
  final double totalGross;
  final double totalDiscount;
  final double totalTax;
  final double totalNet;
  final double totalProfit;
  final int totalInvoices;
  final int cancelledCount;
  final double avgTicket;
  final Map<String, double> byPaymentMethod;
  final Map<String, double> byBranch;
  final List<SaleModel> sales;

  const SalesSummaryResult({
    required this.totalGross,
    required this.totalDiscount,
    required this.totalTax,
    required this.totalNet,
    required this.totalProfit,
    required this.totalInvoices,
    required this.cancelledCount,
    required this.avgTicket,
    required this.byPaymentMethod,
    required this.byBranch,
    required this.sales,
  });
}
