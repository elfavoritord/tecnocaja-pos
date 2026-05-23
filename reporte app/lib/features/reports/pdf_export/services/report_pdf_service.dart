import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../../../../../core/utils/format_helpers.dart';
import '../../../../../data/models/cash_closing_model.dart';
import '../../../../../data/models/cash_register_model.dart';
import '../../../../../data/models/customer_model.dart';
import '../../../../../data/models/expense_model.dart';
import '../../../../../data/models/inventory_model.dart';
import '../../../../../data/models/sale_model.dart';
import '../../../../../data/repositories/reports_api_parsing.dart';
import '../../../../../data/repositories/reports_api_repository.dart';
import '../../../../../data/repositories/sales_repository.dart';
import 'pdf_file_saver.dart';

class ReportPdfRequest {
  final String title;
  final String route;
  final String businessId;
  final String generatedBy;
  final List<String>? branchIds;
  final List<String> cashRegisterIds;
  final bool restrictCashToCurrentUser;

  const ReportPdfRequest({
    required this.title,
    required this.route,
    required this.businessId,
    required this.generatedBy,
    required this.branchIds,
    required this.cashRegisterIds,
    required this.restrictCashToCurrentUser,
  });
}

class ReportPdfExportResult {
  final String fileName;
  final String filePath;

  const ReportPdfExportResult({required this.fileName, required this.filePath});
}

class ReportPdfService {
  ReportPdfService({
    FirebaseFirestore? db,
    SalesRepository? salesRepository,
    ReportsApiRepository? reportsApiRepository,
  }) : _db = db ?? FirebaseFirestore.instance,
       _salesRepository = salesRepository ?? SalesRepository(),
       _reportsApiRepository = reportsApiRepository ?? ReportsApiRepository();

  final FirebaseFirestore _db;
  final SalesRepository _salesRepository;
  final ReportsApiRepository _reportsApiRepository;

  Future<ReportPdfExportResult> exportReport(ReportPdfRequest request) async {
    final generatedAt = DateTime.now();
    final document = pw.Document();

    switch (request.route) {
      case '/reports/sales':
        await _buildSalesPdf(document, request, generatedAt);
        break;
      case '/reports/profits':
        await _buildProfitsPdf(document, request, generatedAt);
        break;
      case '/reports/inventory':
        await _buildInventoryPdf(document, request, generatedAt);
        break;
      case '/reports/cash':
        await _buildCashPdf(document, request, generatedAt);
        break;
      case '/reports/receivables':
        await _buildReceivablesPdf(document, request, generatedAt);
        break;
      case '/reports/expenses':
        await _buildExpensesPdf(document, request, generatedAt);
        break;
      case '/reports/customers':
        await _buildCustomersPdf(document, request, generatedAt);
        break;
      case '/reports/branches':
        await _buildBranchesPdf(document, request, generatedAt);
        break;
      case '/reports/fiscal':
        await _buildFiscalPdf(document, request, generatedAt);
        break;
      default:
        _buildGenericPdf(document, request, generatedAt);
        break;
    }

    final bytes = await document.save();
    final fileName = _buildFileName(request.title, generatedAt);
    final filePath = await savePdfFile(bytes, fileName);

    return ReportPdfExportResult(fileName: fileName, filePath: filePath);
  }

  Future<void> _buildSalesPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final summary = await _salesRepository.getSalesSummary(
      businessId: request.businessId,
      filter: SalesFilter(
        dateRange: DateRange(
          from: DateHelpers.monthStart,
          to: DateTime.now().add(const Duration(minutes: 1)),
        ),
        branchIds: request.branchIds,
      ),
    );

    final recentSales = summary.sales.take(20).toList();
    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Resumen de ventas del mes actual',
          ),
          _metricGrid([
            _PdfMetric(
              'Total bruto',
              FormatHelpers.currency(summary.totalGross),
            ),
            _PdfMetric('Total neto', FormatHelpers.currency(summary.totalNet)),
            _PdfMetric('Ganancia', FormatHelpers.currency(summary.totalProfit)),
            _PdfMetric('Facturas', '${summary.totalInvoices}'),
            _PdfMetric(
              'Ticket promedio',
              FormatHelpers.currency(summary.avgTicket),
            ),
            _PdfMetric('Ventas anuladas', '${summary.cancelledCount}'),
          ]),
          if (summary.byPaymentMethod.isNotEmpty)
            _tableSection(
              title: 'Ventas por metodo de pago',
              headers: const ['Metodo', 'Monto'],
              rows: summary.byPaymentMethod.entries
                  .map(
                    (entry) => [entry.key, FormatHelpers.currency(entry.value)],
                  )
                  .toList(),
            ),
          if (recentSales.isNotEmpty)
            _tableSection(
              title: 'Ultimas ventas del periodo',
              headers: const ['Fecha', 'Sucursal', 'Caja', 'Cliente', 'Total'],
              rows: recentSales
                  .map(
                    (sale) => [
                      DateHelpers.dateTime(sale.createdAt),
                      _fallback(sale.branchName, sale.branchId),
                      sale.cashRegisterId,
                      sale.customerName ?? 'Consumidor final',
                      FormatHelpers.currency(sale.total),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildProfitsPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final summary = await _salesRepository.getSalesSummary(
      businessId: request.businessId,
      filter: SalesFilter(
        dateRange: DateRange(
          from: DateHelpers.monthStart,
          to: DateTime.now().add(const Duration(minutes: 1)),
        ),
        branchIds: request.branchIds,
      ),
    );

    final topProducts = <String, double>{};
    for (final sale in summary.sales.where(
      (sale) => sale.status == SaleStatus.completed,
    )) {
      for (final item in sale.items) {
        final name = item.productName.isNotEmpty
            ? item.productName
            : 'Producto';
        topProducts[name] = (topProducts[name] ?? 0) + item.profit;
      }
    }

    final averageMargin = summary.totalNet > 0
        ? (summary.totalProfit / summary.totalNet) * 100
        : 0.0;
    final rankedProducts = topProducts.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Rentabilidad consolidada del mes actual',
          ),
          _metricGrid([
            _PdfMetric(
              'Ganancia bruta',
              FormatHelpers.currency(summary.totalProfit),
            ),
            _PdfMetric(
              'Ventas netas',
              FormatHelpers.currency(summary.totalNet),
            ),
            _PdfMetric(
              'Margen promedio',
              '${averageMargin.toStringAsFixed(1)}%',
            ),
            _PdfMetric('Facturas completadas', '${summary.totalInvoices}'),
          ]),
          if (rankedProducts.isNotEmpty)
            _tableSection(
              title: 'Productos con mayor ganancia',
              headers: const ['Producto', 'Ganancia estimada'],
              rows: rankedProducts
                  .take(20)
                  .map(
                    (entry) => [entry.key, FormatHelpers.currency(entry.value)],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildInventoryPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(request.businessId)
        .collection('products')
        .orderBy('name')
        .limit(500)
        .get();

    final products = _filterProductsForPdf(
      snapshot.docs.map((doc) => ProductModel.fromFirestore(doc)).toList(),
      request.branchIds,
    );
    final outOfStock = products.where((product) => product.stock <= 0).length;
    final lowStock = products
        .where(
          (product) => product.stock > 0 && product.stock <= product.minStock,
        )
        .length;
    final totalValue = products.fold<double>(
      0,
      (runningTotal, product) => runningTotal + (product.price * product.stock),
    );

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Inventario activo sincronizado',
          ),
          _metricGrid([
            _PdfMetric('Productos visibles', '${products.length}'),
            _PdfMetric('Agotados', '$outOfStock'),
            _PdfMetric('Stock bajo', '$lowStock'),
            _PdfMetric('Valor retail', FormatHelpers.currency(totalValue)),
          ]),
          if (products.isNotEmpty)
            _tableSection(
              title: 'Listado principal',
              headers: const [
                'Producto',
                'Categoria',
                'Stock',
                'Costo',
                'Precio',
              ],
              rows: products
                  .take(30)
                  .map(
                    (product) => [
                      product.name,
                      product.category.isEmpty
                          ? 'Sin categoria'
                          : product.category,
                      '${product.stock}',
                      FormatHelpers.currency(product.cost),
                      FormatHelpers.currency(product.price),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildCashPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final registersSnapshot = await _db
        .collection('businesses')
        .doc(request.businessId)
        .collection('cashRegisters')
        .get();

    final registers = _filterCashRegistersForPdf(
      registersSnapshot.docs
          .map((doc) => CashRegisterModel.fromFirestore(doc))
          .toList(),
      request: request,
    );
    final registerNames = {
      for (final register in registersSnapshot.docs.map(
        (doc) => CashRegisterModel.fromFirestore(doc),
      ))
        register.id: register.name,
    };
    final closings = await _loadCashClosingsForPdf(db: _db, request: request);

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Aperturas y cierres sincronizados',
          ),
          _metricGrid([
            _PdfMetric(
              'Cajas abiertas',
              '${registers.where((register) => register.status == CashRegisterStatus.open).length}',
            ),
            _PdfMetric('Cierres visibles', '${closings.length}'),
            _PdfMetric(
              'Cierres con diferencia',
              '${closings.where((closing) => closing.hasDiscrepancy).length}',
            ),
            _PdfMetric('Filtros activos', _describeCashScope(request)),
          ]),
          if (closings.isNotEmpty)
            _tableSection(
              title: 'Ultimos cierres',
              headers: const [
                'Sucursal',
                'Caja',
                'Apertura',
                'Cierre',
                'Diferencia',
              ],
              rows: closings
                  .take(20)
                  .map(
                    (closing) => [
                      _fallback(closing.branchName, closing.branchId),
                      registerNames[closing.cashRegisterId] ??
                          'Caja ${closing.cashRegisterId}',
                      FormatHelpers.currency(closing.openingAmount),
                      FormatHelpers.currency(closing.closingAmount),
                      FormatHelpers.currency(closing.difference),
                    ],
                  )
                  .toList(),
            ),
          if (registers.isNotEmpty)
            _tableSection(
              title: 'Estado actual de cajas',
              headers: const ['Caja', 'Estado', 'Abierta por', 'Esperado'],
              rows: registers
                  .map(
                    (register) => [
                      '${_fallback(register.branchName, register.branchId)} · ${register.name}',
                      register.status == CashRegisterStatus.open
                          ? 'Abierta'
                          : 'Cerrada',
                      register.openedBy.isEmpty
                          ? 'Sin dato'
                          : register.openedBy,
                      FormatHelpers.currency(register.expectedAmount),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildReceivablesPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final payload = reportsApiAsMap(
      await _reportsApiRepository.getJson(
        '/api/reports/advanced/cuentas-pagar-cobrar',
      ),
    );
    final receivablesPayload = reportsApiAsMap(payload['receivables']);
    final payablesPayload = reportsApiAsMap(payload['payables']);

    final receivables = reportsApiAsList(receivablesPayload['rows'])
        .map((item) => reportsApiAsMap(item))
        .where((row) {
          return _matchesBranchFilter(
            reportsApiToString(row['branchId']),
            request.branchIds,
          );
        })
        .toList();
    final payables = reportsApiAsList(
      payablesPayload['rows'],
    ).map((item) => reportsApiAsMap(item)).toList();

    final totalDebt = receivables.fold<double>(0, (runningTotal, row) {
      final balance = reportsApiToDouble(row['balance']);
      return runningTotal + balance;
    });
    final totalPayable = payables.fold<double>(0, (runningTotal, row) {
      return runningTotal + reportsApiToDouble(row['montoPendiente']);
    });

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Clientes y suplidores con facturas pendientes',
          ),
          _metricGrid([
            _PdfMetric('Por cobrar', FormatHelpers.currency(totalDebt)),
            _PdfMetric('Por pagar', FormatHelpers.currency(totalPayable)),
            _PdfMetric(
              'Balance neto',
              FormatHelpers.currency(totalDebt - totalPayable),
            ),
          ]),
          if (receivables.isNotEmpty)
            _tableSection(
              title: 'Clientes pendientes',
              headers: const ['Cliente', 'Sucursal', 'Pendiente', 'Factura'],
              rows: receivables
                  .take(25)
                  .map(
                    (receivable) => [
                      _fallback(receivable['customerName'], 'Cliente'),
                      _fallback(
                        receivable['branchName'],
                        receivable['branchId'],
                      ),
                      FormatHelpers.currency(
                        reportsApiToDouble(receivable['balance']),
                      ),
                      _fallback(receivable['invoiceNumber'], 'Sin numero'),
                    ],
                  )
                  .toList(),
            ),
          if (payables.isNotEmpty)
            _tableSection(
              title: 'Facturas de suplidores',
              headers: const ['Suplidor', 'Factura', 'Pendiente', 'Estado'],
              rows: payables
                  .take(25)
                  .map(
                    (payable) => [
                      _fallback(payable['proveedor'], 'Suplidor'),
                      _fallback(payable['numeroFactura'], 'Sin numero'),
                      FormatHelpers.currency(
                        reportsApiToDouble(payable['montoPendiente']),
                      ),
                      _fallback(payable['estado'], 'Pendiente'),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildExpensesPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final snapshot = await _db
        .collection('businesses')
        .doc(request.businessId)
        .collection('expenses')
        .where(
          'createdAt',
          isGreaterThanOrEqualTo: Timestamp.fromDate(DateHelpers.monthStart),
        )
        .where(
          'createdAt',
          isLessThan: Timestamp.fromDate(
            DateTime.now().add(const Duration(minutes: 1)),
          ),
        )
        .orderBy('createdAt', descending: true)
        .limit(400)
        .get();

    final expenses = snapshot.docs
        .map((doc) => ExpenseModel.fromFirestore(doc))
        .where(
          (expense) =>
              _matchesBranchFilter(expense.branchId, request.branchIds),
        )
        .toList();
    final total = expenses.fold<double>(
      0,
      (runningTotal, expense) => runningTotal + expense.amount,
    );

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Gastos registrados del mes actual',
          ),
          _metricGrid([
            _PdfMetric('Total de gastos', FormatHelpers.currency(total)),
            _PdfMetric('Registros', '${expenses.length}'),
            _PdfMetric(
              'Promedio',
              expenses.isEmpty
                  ? FormatHelpers.currency(0)
                  : FormatHelpers.currency(total / expenses.length),
            ),
          ]),
          if (expenses.isNotEmpty)
            _tableSection(
              title: 'Ultimos gastos',
              headers: const ['Fecha', 'Categoria', 'Sucursal', 'Monto'],
              rows: expenses
                  .take(25)
                  .map(
                    (expense) => [
                      DateHelpers.date(expense.createdAt),
                      expense.category,
                      _fallback(expense.branchName, expense.branchId),
                      FormatHelpers.currency(expense.amount),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildCustomersPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    List<CustomerModel> customers;
    try {
      final snapshot = await _db
          .collection('businesses')
          .doc(request.businessId)
          .collection('customers')
          .orderBy('totalPurchases', descending: true)
          .limit(200)
          .get();
      customers = snapshot.docs
          .map((doc) => CustomerModel.fromFirestore(doc))
          .toList();
    } catch (_) {
      customers = const [];
    }

    customers = customers.where((customer) {
      return _matchesBranchFilter(customer.branchId, request.branchIds);
    }).toList();

    final totalRevenue = customers.fold<double>(
      0,
      (runningTotal, customer) => runningTotal + customer.totalPurchases,
    );

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Clientes sincronizados y su actividad',
          ),
          _metricGrid([
            _PdfMetric('Clientes visibles', '${customers.length}'),
            _PdfMetric(
              'Ingresos acumulados',
              FormatHelpers.currency(totalRevenue),
            ),
            _PdfMetric(
              'Con deuda',
              '${customers.where((customer) => customer.hasDebt).length}',
            ),
          ]),
          if (customers.isNotEmpty)
            _tableSection(
              title: 'Top clientes',
              headers: const ['Cliente', 'Compras', 'Visitas', 'Deuda'],
              rows: customers
                  .take(25)
                  .map(
                    (customer) => [
                      customer.name,
                      FormatHelpers.currency(customer.totalPurchases),
                      '${customer.visitCount}',
                      FormatHelpers.currency(customer.totalDebt),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildBranchesPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final sales = await _salesRepository.getSales(
      businessId: request.businessId,
      filter: SalesFilter(
        dateRange: DateRange(
          from: DateHelpers.monthStart,
          to: DateTime.now().add(const Duration(minutes: 1)),
        ),
        branchIds: request.branchIds,
      ),
      limit: 1000,
    );

    final branchTotals = <String, _BranchAggregate>{};
    for (final sale in sales.where(
      (sale) => sale.status == SaleStatus.completed,
    )) {
      final key = sale.branchId.isNotEmpty ? sale.branchId : 'principal';
      final previous = branchTotals[key];
      branchTotals[key] = _BranchAggregate(
        name: sale.branchName.isNotEmpty ? sale.branchName : 'Principal',
        totalSales: (previous?.totalSales ?? 0) + sale.total,
        totalInvoices: (previous?.totalInvoices ?? 0) + 1,
      );
    }

    final rankedBranches = branchTotals.entries.toList()
      ..sort((a, b) => b.value.totalSales.compareTo(a.value.totalSales));

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Comparativa del mes actual por sucursal',
          ),
          _metricGrid([
            _PdfMetric('Sucursales con ventas', '${rankedBranches.length}'),
            _PdfMetric(
              'Facturas',
              '${rankedBranches.fold<int>(0, (total, entry) => total + entry.value.totalInvoices)}',
            ),
            _PdfMetric(
              'Ventas totales',
              FormatHelpers.currency(
                rankedBranches.fold<double>(
                  0,
                  (total, entry) => total + entry.value.totalSales,
                ),
              ),
            ),
          ]),
          if (rankedBranches.isNotEmpty)
            _tableSection(
              title: 'Ranking de sucursales',
              headers: const ['Sucursal', 'Ventas', 'Facturas'],
              rows: rankedBranches
                  .map(
                    (entry) => [
                      entry.value.name,
                      FormatHelpers.currency(entry.value.totalSales),
                      '${entry.value.totalInvoices}',
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  Future<void> _buildFiscalPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) async {
    final sales = await _salesRepository.getSales(
      businessId: request.businessId,
      filter: SalesFilter(
        dateRange: DateRange(
          from: DateHelpers.monthStart,
          to: DateTime.now().add(const Duration(minutes: 1)),
        ),
        branchIds: request.branchIds,
      ),
      limit: 700,
    );

    final fiscalSales = sales
        .where(
          (sale) =>
              sale.invoiceType == 'fiscal' &&
              sale.status == SaleStatus.completed,
        )
        .toList();
    final totalAmount = fiscalSales.fold<double>(
      0,
      (runningTotal, sale) => runningTotal + sale.total,
    );

    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Comprobantes fiscales del mes actual',
          ),
          _metricGrid([
            _PdfMetric('Comprobantes', '${fiscalSales.length}'),
            _PdfMetric('Monto facturado', FormatHelpers.currency(totalAmount)),
          ]),
          if (fiscalSales.isNotEmpty)
            _tableSection(
              title: 'Listado fiscal',
              headers: const ['Fecha', 'NCF', 'Sucursal', 'Monto'],
              rows: fiscalSales
                  .take(30)
                  .map(
                    (sale) => [
                      DateHelpers.date(sale.createdAt),
                      sale.invoiceNumber ?? sale.id,
                      _fallback(sale.branchName, sale.branchId),
                      FormatHelpers.currency(sale.total),
                    ],
                  )
                  .toList(),
            ),
        ],
      ),
    );
  }

  void _buildGenericPdf(
    pw.Document document,
    ReportPdfRequest request,
    DateTime generatedAt,
  ) {
    document.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        build: (_) => [
          ..._header(
            request: request,
            generatedAt: generatedAt,
            subtitle: 'Resumen exportado desde Tecno Reporte',
          ),
          pw.SizedBox(height: 12),
          pw.Text(
            'Este reporte fue exportado directamente desde el modulo de PDF.',
            style: const pw.TextStyle(fontSize: 11),
          ),
        ],
      ),
    );
  }

  List<pw.Widget> _header({
    required ReportPdfRequest request,
    required DateTime generatedAt,
    required String subtitle,
  }) {
    return [
      pw.Text(
        request.title,
        style: pw.TextStyle(
          fontSize: 22,
          fontWeight: pw.FontWeight.bold,
          color: PdfColors.blueGrey900,
        ),
      ),
      pw.SizedBox(height: 4),
      pw.Text(
        subtitle,
        style: const pw.TextStyle(fontSize: 11, color: PdfColors.blueGrey700),
      ),
      pw.SizedBox(height: 10),
      pw.Container(
        padding: const pw.EdgeInsets.all(12),
        decoration: pw.BoxDecoration(
          color: PdfColors.blue50,
          borderRadius: pw.BorderRadius.circular(8),
        ),
        child: pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Text('Negocio: ${request.businessId}'),
            pw.Text('Generado por: ${request.generatedBy}'),
            pw.Text('Fecha: ${DateHelpers.dateTime(generatedAt)}'),
            if ((request.branchIds ?? []).isNotEmpty)
              pw.Text(
                'Sucursales filtradas: ${(request.branchIds ?? []).join(', ')}',
              ),
          ],
        ),
      ),
      pw.SizedBox(height: 14),
    ];
  }

  pw.Widget _metricGrid(List<_PdfMetric> metrics) {
    return pw.Wrap(
      spacing: 10,
      runSpacing: 10,
      children: metrics
          .map(
            (metric) => pw.Container(
              width: 240,
              padding: const pw.EdgeInsets.all(10),
              decoration: pw.BoxDecoration(
                border: pw.Border.all(color: PdfColors.blueGrey200),
                borderRadius: pw.BorderRadius.circular(8),
              ),
              child: pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text(
                    metric.label,
                    style: const pw.TextStyle(
                      fontSize: 10,
                      color: PdfColors.blueGrey700,
                    ),
                  ),
                  pw.SizedBox(height: 4),
                  pw.Text(
                    metric.value,
                    style: pw.TextStyle(
                      fontSize: 13,
                      fontWeight: pw.FontWeight.bold,
                    ),
                  ),
                ],
              ),
            ),
          )
          .toList(),
    );
  }

  pw.Widget _tableSection({
    required String title,
    required List<String> headers,
    required List<List<String>> rows,
  }) {
    return pw.Column(
      crossAxisAlignment: pw.CrossAxisAlignment.start,
      children: [
        pw.SizedBox(height: 18),
        pw.Text(
          title,
          style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold),
        ),
        pw.SizedBox(height: 8),
        pw.TableHelper.fromTextArray(
          headers: headers,
          data: rows,
          headerDecoration: const pw.BoxDecoration(color: PdfColors.blueGrey50),
          headerStyle: pw.TextStyle(
            fontSize: 10,
            fontWeight: pw.FontWeight.bold,
          ),
          cellStyle: const pw.TextStyle(fontSize: 9),
          cellAlignment: pw.Alignment.centerLeft,
          headerAlignment: pw.Alignment.centerLeft,
          border: pw.TableBorder.all(color: PdfColors.blueGrey100),
        ),
      ],
    );
  }

  String _buildFileName(String title, DateTime generatedAt) {
    final normalizedTitle = title
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^_|_$'), '');
    final stamp =
        '${generatedAt.year}${generatedAt.month.toString().padLeft(2, '0')}${generatedAt.day.toString().padLeft(2, '0')}_${generatedAt.hour.toString().padLeft(2, '0')}${generatedAt.minute.toString().padLeft(2, '0')}';
    return '${normalizedTitle.isEmpty ? 'reporte' : normalizedTitle}_$stamp.pdf';
  }

  String _describeCashScope(ReportPdfRequest request) {
    if (request.cashRegisterIds.isNotEmpty) {
      return 'Caja ${request.cashRegisterIds.join(', ')}';
    }
    if (request.restrictCashToCurrentUser) {
      return 'Usuario actual';
    }
    if ((request.branchIds ?? []).isNotEmpty) {
      return 'Sucursal';
    }
    return 'General';
  }
}

class _PdfMetric {
  final String label;
  final String value;

  const _PdfMetric(this.label, this.value);
}

class _BranchAggregate {
  final String name;
  final double totalSales;
  final int totalInvoices;

  const _BranchAggregate({
    required this.name,
    required this.totalSales,
    required this.totalInvoices,
  });
}

List<ProductModel> _filterProductsForPdf(
  List<ProductModel> products,
  List<String>? branchIds,
) {
  final activeProducts = products.where((product) => product.isActive).toList();
  final normalizedBranchIds = _normalizedSet(branchIds);

  if (normalizedBranchIds.isEmpty) {
    return activeProducts;
  }

  final branchScopedProducts = activeProducts
      .where((product) => (product.branchId ?? '').trim().isNotEmpty)
      .toList();

  if (branchScopedProducts.isEmpty) {
    return activeProducts;
  }

  return branchScopedProducts
      .where(
        (product) => normalizedBranchIds.contains(
          (product.branchId ?? '').trim().toLowerCase(),
        ),
      )
      .toList();
}

List<CashRegisterModel> _filterCashRegistersForPdf(
  List<CashRegisterModel> registers, {
  required ReportPdfRequest request,
}) {
  final normalizedBranchIds = _normalizedSet(request.branchIds);
  final normalizedCashRegisterIds = _normalizedSet(request.cashRegisterIds);

  return registers.where((register) {
    if (normalizedBranchIds.isNotEmpty &&
        !normalizedBranchIds.contains(register.branchId.trim().toLowerCase())) {
      return false;
    }

    if (normalizedCashRegisterIds.isNotEmpty) {
      return normalizedCashRegisterIds.contains(
        register.id.trim().toLowerCase(),
      );
    }

    if (request.restrictCashToCurrentUser) {
      return register.openedBy.trim().toLowerCase() ==
          request.generatedBy.trim().toLowerCase();
    }

    return true;
  }).toList();
}

List<CashClosingModel> _filterCashClosingsForPdf(
  List<CashClosingModel> closings, {
  required ReportPdfRequest request,
}) {
  final normalizedBranchIds = _normalizedSet(request.branchIds);
  final normalizedCashRegisterIds = _normalizedSet(request.cashRegisterIds);
  final normalizedUserName = request.generatedBy.trim().toLowerCase();

  return closings.where((closing) {
    if (normalizedBranchIds.isNotEmpty &&
        !normalizedBranchIds.contains(closing.branchId.trim().toLowerCase())) {
      return false;
    }

    if (normalizedCashRegisterIds.isNotEmpty) {
      return normalizedCashRegisterIds.contains(
        closing.cashRegisterId.trim().toLowerCase(),
      );
    }

    if (request.restrictCashToCurrentUser) {
      return closing.openedBy.trim().toLowerCase() == normalizedUserName ||
          closing.closedBy.trim().toLowerCase() == normalizedUserName;
    }

    return true;
  }).toList();
}

Future<List<CashClosingModel>> _loadCashClosingsForPdf({
  required FirebaseFirestore db,
  required ReportPdfRequest request,
}) async {
  try {
    final snapshot = await db
        .collection('businesses')
        .doc(request.businessId)
        .collection('cashClosings')
        .orderBy('createdAt', descending: true)
        .limit(200)
        .get();

    return _filterCashClosingsForPdf(
      snapshot.docs.map((doc) => CashClosingModel.fromFirestore(doc)).toList(),
      request: request,
    );
  } on FirebaseException catch (error) {
    if (error.code != 'permission-denied') rethrow;
  }

  final branchIds = await _resolveBranchIdsForPdf(
    db: db,
    businessId: request.businessId,
    scopedBranchIds: request.branchIds,
  );

  final closings = <CashClosingModel>[];
  for (final branchId in branchIds) {
    try {
      final snapshot = await db
          .collection('businesses')
          .doc(request.businessId)
          .collection('branches')
          .doc(branchId)
          .collection('cash_closings')
          .get();
      closings.addAll(
        snapshot.docs.map((doc) => CashClosingModel.fromFirestore(doc)),
      );
    } on FirebaseException catch (error) {
      if (error.code != 'permission-denied') {
        rethrow;
      }
    }
  }

  closings.sort((a, b) {
    final left =
        a.closedAt ?? a.openedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
    final right =
        b.closedAt ?? b.openedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
    return right.compareTo(left);
  });

  return _filterCashClosingsForPdf(
    closings.take(200).toList(),
    request: request,
  );
}

Future<List<String>> _resolveBranchIdsForPdf({
  required FirebaseFirestore db,
  required String businessId,
  required List<String>? scopedBranchIds,
}) async {
  final branchIds = (scopedBranchIds ?? [])
      .map((value) => value.trim())
      .where((value) => value.isNotEmpty)
      .toList();
  if (branchIds.isNotEmpty) return branchIds;

  try {
    final snapshot = await db
        .collection('businesses')
        .doc(businessId)
        .collection('branches')
        .get();
    return snapshot.docs
        .map((doc) => doc.id.trim())
        .where((value) => value.isNotEmpty)
        .toList();
  } catch (_) {
    return const [];
  }
}

bool _matchesBranchFilter(String? branchId, List<String>? branchIds) {
  final normalizedBranchIds = _normalizedSet(branchIds);
  if (normalizedBranchIds.isEmpty) return true;

  final normalizedBranchId = (branchId ?? '').trim().toLowerCase();
  if (normalizedBranchId.isEmpty) return true;
  return normalizedBranchIds.contains(normalizedBranchId);
}

Set<String> _normalizedSet(List<String>? values) {
  return (values ?? const <String>[])
      .map((value) => value.trim().toLowerCase())
      .where((value) => value.isNotEmpty)
      .toSet();
}

String _fallback(String? preferred, String? fallback) {
  final primary = preferred?.trim() ?? '';
  if (primary.isNotEmpty) return primary;
  final secondary = fallback?.trim() ?? '';
  return secondary.isNotEmpty ? secondary : 'Sin dato';
}
