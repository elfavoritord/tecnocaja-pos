import '../../core/utils/format_helpers.dart';

enum ReportsRangePreset { today, week, month, year }

extension ReportsRangePresetExt on ReportsRangePreset {
  String get label {
    switch (this) {
      case ReportsRangePreset.today:
        return 'Hoy';
      case ReportsRangePreset.week:
        return 'Esta semana';
      case ReportsRangePreset.month:
        return 'Este mes';
      case ReportsRangePreset.year:
        return 'Este año';
    }
  }

  ({DateTime from, DateTime to}) resolveRange(DateTime now) {
    final today = DateTime(now.year, now.month, now.day);
    switch (this) {
      case ReportsRangePreset.today:
        return (from: today, to: now);
      case ReportsRangePreset.week:
        return (
          from: today.subtract(Duration(days: now.weekday - 1)),
          to: now,
        );
      case ReportsRangePreset.month:
        return (from: DateTime(now.year, now.month, 1), to: now);
      case ReportsRangePreset.year:
        return (from: DateTime(now.year, 1, 1), to: now);
    }
  }
}

class DashboardFilterOption {
  final String id;
  final String label;
  final String? parentId;

  const DashboardFilterOption({
    required this.id,
    required this.label,
    this.parentId,
  });
}

class ReportsDashboardKpis {
  final int totalInvoices;
  final double totalSales;
  final double totalTax;
  final double grossProfit;
  final double margin;
  final double avgTicket;
  final double cash;
  final double card;
  final double transfer;
  final double credit;
  final double cashOnDelivery;

  const ReportsDashboardKpis({
    required this.totalInvoices,
    required this.totalSales,
    required this.totalTax,
    required this.grossProfit,
    required this.margin,
    required this.avgTicket,
    required this.cash,
    required this.card,
    required this.transfer,
    required this.credit,
    required this.cashOnDelivery,
  });

  factory ReportsDashboardKpis.fromJson(Map<String, dynamic> json) {
    return ReportsDashboardKpis(
      totalInvoices: _toInt(json['total_facturas']),
      totalSales: _toDouble(json['total_ventas']),
      totalTax: _toDouble(json['total_itbis']),
      grossProfit: _toDouble(json['ganancia']),
      margin: _toDouble(json['margen']),
      avgTicket: _toDouble(json['ticket_promedio']),
      cash: _toDouble(json['efectivo']),
      card: _toDouble(json['tarjeta']),
      transfer: _toDouble(json['transferencia']),
      credit: _toDouble(json['credito']),
      cashOnDelivery: _toDouble(json['contra_entrega']),
    );
  }
}

class ReportsTrendPoint {
  final DateTime date;
  final int invoices;
  final double total;
  final double tax;

  const ReportsTrendPoint({
    required this.date,
    required this.invoices,
    required this.total,
    required this.tax,
  });

  factory ReportsTrendPoint.fromJson(Map<String, dynamic> json) {
    return ReportsTrendPoint(
      date: DateTime.tryParse(json['dia']?.toString() ?? '') ?? DateTime.now(),
      invoices: _toInt(json['facturas']),
      total: _toDouble(json['total']),
      tax: _toDouble(json['itbis']),
    );
  }
}

class ReportsPaymentMethod {
  final String method;
  final int invoices;
  final double total;
  final double percentage;

  const ReportsPaymentMethod({
    required this.method,
    required this.invoices,
    required this.total,
    required this.percentage,
  });

  String get label {
    switch (method) {
      case 'efectivo':
        return 'Efectivo';
      case 'tarjeta':
        return 'Tarjeta';
      case 'transferencia':
        return 'Transferencia';
      case 'credito':
        return 'Crédito';
      case 'contra_entrega':
        return 'Contra entrega';
      default:
        return method.isEmpty ? 'Otro' : method;
    }
  }

  factory ReportsPaymentMethod.fromJson(Map<String, dynamic> json) {
    return ReportsPaymentMethod(
      method: json['metodo']?.toString() ?? '',
      invoices: _toInt(json['facturas']),
      total: _toDouble(json['total']),
      percentage: _toDouble(json['porcentaje']),
    );
  }
}

class ReportsTopProduct {
  final String productId;
  final String name;
  final String code;
  final String category;
  final double quantity;
  final double totalSold;
  final double participation;

  const ReportsTopProduct({
    required this.productId,
    required this.name,
    required this.code,
    required this.category,
    required this.quantity,
    required this.totalSold,
    required this.participation,
  });

  String get quantityLabel {
    final value = quantity;
    if (value == value.roundToDouble()) {
      return '${value.toInt()} uds.';
    }
    return '${FormatHelpers.number(value)} uds.';
  }

  factory ReportsTopProduct.fromJson(Map<String, dynamic> json) {
    return ReportsTopProduct(
      productId: json['productoId']?.toString() ?? '',
      name: json['nombre']?.toString() ?? 'Producto',
      code: json['codigo']?.toString() ?? '',
      category: json['categoria']?.toString() ?? '',
      quantity: _toDouble(json['cantidad']),
      totalSold: _toDouble(json['totalVendido']),
      participation: _toDouble(json['participacion']),
    );
  }
}

class ReportsDashboardData {
  final ReportsRangePreset preset;
  final String desde;
  final String hasta;
  final ReportsDashboardKpis kpis;
  final List<ReportsTrendPoint> trend;
  final List<ReportsPaymentMethod> paymentMethods;
  final List<ReportsTopProduct> topProducts;
  final List<DashboardFilterOption> branches;
  final List<DashboardFilterOption> cashRegisters;
  final List<DashboardFilterOption> cashiers;

  const ReportsDashboardData({
    required this.preset,
    required this.desde,
    required this.hasta,
    required this.kpis,
    required this.trend,
    required this.paymentMethods,
    required this.topProducts,
    required this.branches,
    required this.cashRegisters,
    required this.cashiers,
  });

  double get trendTotal => trend.fold<double>(
    0,
    (runningTotal, item) => runningTotal + item.total,
  );
}

double _toDouble(dynamic value) {
  if (value == null) return 0;
  if (value is num) return value.toDouble();
  return double.tryParse(value.toString()) ?? 0;
}

int _toInt(dynamic value) {
  if (value == null) return 0;
  if (value is num) return value.toInt();
  return int.tryParse(value.toString()) ?? 0;
}
