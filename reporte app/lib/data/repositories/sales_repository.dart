import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/sale_model.dart';

class DateRange {
  final DateTime from;
  final DateTime to;
  const DateRange({required this.from, required this.to});
}

class SalesFilter {
  final DateRange dateRange;
  final String? branchId;
  final List<String>? branchIds;
  final String? cashRegisterId;
  final String? cashierName;
  final String? paymentMethod;
  final String? category;
  final SaleStatus? status;

  const SalesFilter({
    required this.dateRange,
    this.branchId,
    this.branchIds,
    this.cashRegisterId,
    this.cashierName,
    this.paymentMethod,
    this.category,
    this.status,
  });
}

class SalesRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  /// Stream en tiempo real del número de ventas completadas HOY.
  /// Emite un nuevo valor cada vez que se agrega o cambia una venta.
  Stream<int> watchTodaySalesCount(String businessId) {
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
        .where('status', isEqualTo: 'completed')
        .snapshots()
        .map((snap) => snap.docs.length);
  }

  /// Stream en tiempo real del total de ventas (monto) de HOY.
  Stream<double> watchTodayRevenue(String businessId) {
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
        .where('status', isEqualTo: 'completed')
        .snapshots()
        .map(
          (snap) => snap.docs.fold<double>(0, (runningTotal, doc) {
            final data = doc.data();
            final total = (data['total'] as num?)?.toDouble() ?? 0;
            return runningTotal + total;
          }),
        );
  }

  Future<List<SaleModel>> getSales({
    required String businessId,
    required SalesFilter filter,
    int limit = 100,
  }) async {
    Query ref = _db
        .collection('businesses')
        .doc(businessId)
        .collection('sales')
        .where(
          'createdAt',
          isGreaterThanOrEqualTo: Timestamp.fromDate(filter.dateRange.from),
        )
        .where('createdAt', isLessThan: Timestamp.fromDate(filter.dateRange.to))
        .orderBy('createdAt', descending: true)
        .limit(limit);

    if (filter.branchId != null) {
      ref = ref.where('branchId', isEqualTo: filter.branchId);
    } else if (filter.branchIds != null && filter.branchIds!.isNotEmpty) {
      ref = ref.where('branchId', whereIn: filter.branchIds);
    }
    if (filter.status != null) {
      final statusStr = filter.status == SaleStatus.completed
          ? 'completed'
          : filter.status == SaleStatus.cancelled
          ? 'cancelled'
          : 'pending';
      ref = ref.where('status', isEqualTo: statusStr);
    }
    if (filter.paymentMethod != null) {
      ref = ref.where('paymentMethod', isEqualTo: filter.paymentMethod);
    }

    final snap = await ref.get();
    return snap.docs.map(SaleModel.fromFirestore).toList();
  }

  Future<SalesSummary> getSalesSummary({
    required String businessId,
    required SalesFilter filter,
  }) async {
    final sales = await getSales(
      businessId: businessId,
      filter: filter,
      limit: 500,
    );

    final completed = sales.where((s) => s.status == SaleStatus.completed);
    final cancelled = sales.where((s) => s.status == SaleStatus.cancelled);

    double totalGross = 0;
    double totalDiscount = 0;
    double totalTax = 0;
    double totalProfit = 0;
    final Map<String, double> byPayment = {};
    final Map<String, double> byBranch = {};

    for (final sale in completed) {
      totalGross += sale.total;
      totalDiscount += sale.discount;
      totalTax += sale.tax;
      totalProfit += sale.profit;
      byPayment[sale.paymentMethod.label] =
          (byPayment[sale.paymentMethod.label] ?? 0) + sale.total;
      byBranch[sale.branchName] = (byBranch[sale.branchName] ?? 0) + sale.total;
    }

    return SalesSummary(
      totalGross: totalGross,
      totalDiscount: totalDiscount,
      totalTax: totalTax,
      totalNet: totalGross - totalDiscount,
      totalProfit: totalProfit,
      totalInvoices: completed.length,
      cancelledCount: cancelled.length,
      avgTicket: completed.isEmpty ? 0 : totalGross / completed.length,
      byPaymentMethod: byPayment,
      byBranch: byBranch,
      sales: sales,
    );
  }
}

class SalesSummary {
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

  const SalesSummary({
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
