class DashboardSummary {
  final double todaySales;
  final double weeklySales;
  final double monthlySales;
  final double todayProfit;
  final int todayInvoices;
  final double avgTicket;
  final double cashBalance;
  final bool isCashOpen;
  final double totalReceivables;
  final double todayExpenses;
  final int lowStockCount;
  final int outOfStockCount;

  // Comparativas
  final double yesterdaySales;
  final double lastWeekSales;
  final double lastMonthSales;

  final List<TopProduct> topProducts;
  final List<TopCustomer> topCustomers;
  final List<SalesChartPoint> salesChartData;

  const DashboardSummary({
    required this.todaySales,
    required this.weeklySales,
    required this.monthlySales,
    required this.todayProfit,
    required this.todayInvoices,
    required this.avgTicket,
    required this.cashBalance,
    required this.isCashOpen,
    required this.totalReceivables,
    required this.todayExpenses,
    required this.lowStockCount,
    required this.outOfStockCount,
    required this.yesterdaySales,
    required this.lastWeekSales,
    required this.lastMonthSales,
    required this.topProducts,
    required this.topCustomers,
    required this.salesChartData,
  });

  double get todayVsYesterday => yesterdaySales > 0
      ? ((todaySales - yesterdaySales) / yesterdaySales) * 100
      : 0;

  double get weekVsLastWeek => lastWeekSales > 0
      ? ((weeklySales - lastWeekSales) / lastWeekSales) * 100
      : 0;

  double get monthVsLastMonth => lastMonthSales > 0
      ? ((monthlySales - lastMonthSales) / lastMonthSales) * 100
      : 0;

  static DashboardSummary empty() => DashboardSummary(
        todaySales: 0,
        weeklySales: 0,
        monthlySales: 0,
        todayProfit: 0,
        todayInvoices: 0,
        avgTicket: 0,
        cashBalance: 0,
        isCashOpen: false,
        totalReceivables: 0,
        todayExpenses: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        yesterdaySales: 0,
        lastWeekSales: 0,
        lastMonthSales: 0,
        topProducts: [],
        topCustomers: [],
        salesChartData: [],
      );
}

class TopProduct {
  final String productId;
  final String name;
  final String category;
  final double totalSold;
  final int quantity;

  const TopProduct({
    required this.productId,
    required this.name,
    required this.category,
    required this.totalSold,
    required this.quantity,
  });

  factory TopProduct.fromMap(Map<String, dynamic> m) => TopProduct(
        productId: m['productId'] ?? '',
        name: m['name'] ?? '',
        category: m['category'] ?? '',
        totalSold: (m['totalSold'] ?? 0).toDouble(),
        quantity: (m['quantity'] ?? 0).toInt(),
      );
}

class TopCustomer {
  final String customerId;
  final String name;
  final double totalSpent;
  final int visits;

  const TopCustomer({
    required this.customerId,
    required this.name,
    required this.totalSpent,
    required this.visits,
  });

  factory TopCustomer.fromMap(Map<String, dynamic> m) => TopCustomer(
        customerId: m['customerId'] ?? '',
        name: m['name'] ?? '',
        totalSpent: (m['totalSpent'] ?? 0).toDouble(),
        visits: (m['visits'] ?? 0).toInt(),
      );
}

class SalesChartPoint {
  final DateTime date;
  final double amount;

  const SalesChartPoint({required this.date, required this.amount});
}
