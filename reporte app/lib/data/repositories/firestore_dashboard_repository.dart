import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/reports_dashboard_model.dart';
import '../models/sale_model.dart';

/// Repositorio que obtiene los datos del dashboard directamente de Firestore,
/// sin depender del servidor HTTP de NovaPOS.
///
/// Lee ventas de:
///   businesses/{businessId}/sales
///
/// Y calcula KPIs, tendencia, métodos de pago y top productos en el cliente.
class FirestoreDashboardRepository {
  FirestoreDashboardRepository({FirebaseFirestore? db})
      : _db = db ?? FirebaseFirestore.instance;

  final FirebaseFirestore _db;

  Future<ReportsDashboardData> getDashboard({
    required ReportsRangePreset preset,
    required String businessId,
    List<String>? branchIds,
    String? cashRegisterId,
    String? cashierName,
  }) async {
    final range = preset.resolveRange(DateTime.now());

    // Consulta base por fecha
    final snapshot = await _db
        .collection('businesses')
        .doc(businessId)
        .collection('sales')
        .where(
          'createdAt',
          isGreaterThanOrEqualTo: Timestamp.fromDate(range.from),
        )
        .where(
          'createdAt',
          isLessThanOrEqualTo: Timestamp.fromDate(range.to),
        )
        .get();

    final allSales = snapshot.docs
        .map((doc) => SaleModel.fromFirestore(doc))
        .toList();

    // Filtros adicionales en memoria (Firestore no soporta múltiples
    // desigualdades en campos distintos a la vez)
    final sales = allSales.where((s) {
      if (branchIds != null &&
          branchIds.isNotEmpty &&
          !branchIds.contains(s.branchId)) {
        return false;
      }
      if (cashRegisterId != null &&
          cashRegisterId.isNotEmpty &&
          s.cashRegisterId != cashRegisterId) {
        return false;
      }
      if (cashierName != null &&
          cashierName.isNotEmpty &&
          s.cashierName != cashierName) {
        return false;
      }
      return true;
    }).toList();

    final completed =
        sales.where((s) => s.status != SaleStatus.cancelled).toList();

    // ── KPIs ─────────────────────────────────────────────────────────────────
    final totalRevenue =
        completed.fold<double>(0, (sum, s) => sum + s.total);
    final totalTax = completed.fold<double>(0, (sum, s) => sum + s.tax);
    final totalDiscount =
        completed.fold<double>(0, (sum, s) => sum + s.discount);
    final grossProfit =
        completed.fold<double>(0, (sum, s) => sum + s.profit);
    final totalInvoices = completed.length;
    final avgTicket =
        totalInvoices > 0 ? totalRevenue / totalInvoices : 0.0;
    final margin =
        totalRevenue > 0 ? (grossProfit / totalRevenue) * 100.0 : 0.0;

    // ── Métodos de pago ───────────────────────────────────────────────────────
    final Map<String, int> pmCount = {};
    final Map<String, double> pmTotal = {};
    for (final s in completed) {
      final key = s.paymentMethod.name; // 'cash','card','credit','transfer','mixed'
      pmCount[key] = (pmCount[key] ?? 0) + 1;
      pmTotal[key] = (pmTotal[key] ?? 0) + s.total;
    }

    final paymentMethods = pmTotal.entries.map((e) {
      return ReportsPaymentMethod(
        method: e.key,
        invoices: pmCount[e.key] ?? 0,
        total: e.value,
        percentage:
            totalRevenue > 0 ? (e.value / totalRevenue) * 100.0 : 0.0,
      );
    }).toList();

    // ── Tendencia diaria ──────────────────────────────────────────────────────
    final Map<String, ({int invoices, double total, double tax})> trendMap =
        {};
    for (final s in completed) {
      final key =
          '${s.createdAt.year}-${s.createdAt.month.toString().padLeft(2, '0')}-${s.createdAt.day.toString().padLeft(2, '0')}';
      final prev =
          trendMap[key] ?? (invoices: 0, total: 0.0, tax: 0.0);
      trendMap[key] = (
        invoices: prev.invoices + 1,
        total: prev.total + s.total,
        tax: prev.tax + s.tax,
      );
    }

    final trend = trendMap.entries
        .map(
          (e) => ReportsTrendPoint(
            date: DateTime.parse(e.key),
            invoices: e.value.invoices,
            total: e.value.total,
            tax: e.value.tax,
          ),
        )
        .toList()
      ..sort((a, b) => a.date.compareTo(b.date));

    // ── Top productos ─────────────────────────────────────────────────────────
    final Map<String, _ProductAgg> productMap = {};
    for (final s in completed) {
      for (final item in s.items) {
        if (item.productId.isEmpty) continue;
        final prev = productMap[item.productId];
        productMap[item.productId] = _ProductAgg(
          id: item.productId,
          name: item.productName,
          category: item.category,
          quantity: (prev?.quantity ?? 0) + item.quantity,
          revenue: (prev?.revenue ?? 0) + item.totalAfterDiscount,
        );
      }
    }
    final sortedProducts = productMap.values.toList()
      ..sort((a, b) => b.revenue.compareTo(a.revenue));

    final topProducts = sortedProducts.take(8).map((p) {
      return ReportsTopProduct(
        productId: p.id,
        name: p.name,
        code: '',
        category: p.category,
        quantity: p.quantity,
        totalSold: p.revenue,
        participation:
            totalRevenue > 0 ? (p.revenue / totalRevenue) * 100.0 : 0.0,
      );
    }).toList();

    // ── Filtros disponibles (derivados de los datos) ──────────────────────────
    final branchMap = <String, DashboardFilterOption>{};
    final cashRegMap = <String, DashboardFilterOption>{};
    final cashierMap = <String, DashboardFilterOption>{};
    for (final s in allSales) {
      if (s.branchId.isNotEmpty) {
        branchMap[s.branchId] = DashboardFilterOption(
          id: s.branchId,
          label: s.branchName.isNotEmpty ? s.branchName : s.branchId,
        );
      }
      if (s.cashRegisterId.isNotEmpty) {
        cashRegMap[s.cashRegisterId] = DashboardFilterOption(
          id: s.cashRegisterId,
          label: s.cashRegisterId,
          parentId: s.branchId,
        );
      }
      if (s.cashierName.isNotEmpty) {
        cashierMap[s.cashierName] = DashboardFilterOption(
          id: s.cashierName,
          label: s.cashierName,
        );
      }
    }

    return ReportsDashboardData(
      preset: preset,
      desde: _fmtDate(range.from),
      hasta: _fmtDate(range.to),
      kpis: ReportsDashboardKpis(
        totalInvoices: totalInvoices,
        totalSales: totalRevenue,
        totalTax: totalTax,
        grossProfit: grossProfit,
        margin: margin,
        avgTicket: avgTicket,
        cash: pmTotal['cash'] ?? 0,
        card: pmTotal['card'] ?? 0,
        transfer: pmTotal['transfer'] ?? 0,
        credit: pmTotal['credit'] ?? 0,
        cashOnDelivery: 0,
      ),
      trend: trend,
      paymentMethods: paymentMethods,
      topProducts: topProducts,
      branches: branchMap.values.toList(),
      cashRegisters: cashRegMap.values.toList(),
      cashiers: cashierMap.values.toList(),
    );
  }

  String _fmtDate(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

class _ProductAgg {
  final String id;
  final String name;
  final String category;
  final double quantity;
  final double revenue;

  const _ProductAgg({
    required this.id,
    required this.name,
    required this.category,
    required this.quantity,
    required this.revenue,
  });
}
