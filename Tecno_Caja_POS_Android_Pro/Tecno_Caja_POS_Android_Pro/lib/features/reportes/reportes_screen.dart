import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/constants/roles.dart';
import '../../core/providers/database_providers.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/sync/cloud_business_sync_repository.dart';
import '../../data/sync/sales_sync_service.dart';
import '../../domain/entities/venta.dart';

enum _Periodo { hoy, ayer, semana, mes, mesAnterior, ano, personalizado }

class ReportesScreen extends ConsumerStatefulWidget {
  const ReportesScreen({super.key});

  @override
  ConsumerState<ReportesScreen> createState() => _ReportesScreenState();
}

class _ReportesScreenState extends ConsumerState<ReportesScreen> {
  _Periodo _periodo = _Periodo.mes;
  DateTimeRange? _personalizado;
  String _estado = 'todos';
  String _pago = 'todos';
  String _busqueda = '';
  bool _filtrosAbiertos = false;
  bool _syncing = false;
  int _revision = 0;

  DateTimeRange get _rango {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return switch (_periodo) {
      _Periodo.hoy =>
        DateTimeRange(start: today, end: today.add(const Duration(days: 1))),
      _Periodo.ayer => DateTimeRange(
          start: today.subtract(const Duration(days: 1)), end: today),
      _Periodo.semana => DateTimeRange(
          start: today.subtract(Duration(days: today.weekday - 1)),
          end: today.add(const Duration(days: 1))),
      _Periodo.mes => DateTimeRange(
          start: DateTime(now.year, now.month),
          end: DateTime(now.year, now.month + 1)),
      _Periodo.mesAnterior => DateTimeRange(
          start: DateTime(now.year, now.month - 1),
          end: DateTime(now.year, now.month)),
      _Periodo.ano =>
        DateTimeRange(start: DateTime(now.year), end: DateTime(now.year + 1)),
      _Periodo.personalizado => _personalizado ??
          DateTimeRange(
              start: DateTime(now.year, now.month),
              end: DateTime(now.year, now.month + 1)),
    };
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    if (auth.empresaId == null || auth.usuario == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final rango = _rango;
    final request = _ReportRequest(
      businessId: auth.empresaId!,
      userId: auth.usuario!.id,
      branchId: auth.usuario!.sucursalId,
      role: auth.usuario!.rol,
      start: rango.start,
      end: rango.end,
      status: _estado,
      payment: _pago,
      search: _busqueda,
      revision: _revision,
    );
    return Scaffold(
      backgroundColor: const Color(0xfff5f7f8),
      body: FutureBuilder<_ReportData>(
        future: _load(request),
        builder: (context, snapshot) {
          return CustomScrollView(
            slivers: [
              SliverAppBar(
                pinned: true,
                backgroundColor: Colors.white,
                surfaceTintColor: Colors.white,
                title: const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Reportes de ventas'),
                    Text(
                      'Analiza el rendimiento y los movimientos de tu negocio.',
                      style:
                          TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
                    ),
                  ],
                ),
                actions: [
                  PopupMenuButton<String>(
                    tooltip: 'Exportar',
                    icon: const Icon(Icons.download_outlined),
                    enabled: snapshot.data != null,
                    onSelected: (value) {
                      if (value == 'ventas') _exportar(snapshot.data!);
                      if (value == '607') _exportar607(snapshot.data!);
                      if (value == '606') _exportar606();
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'ventas', child: Text('Ventas CSV')),
                      PopupMenuItem(value: '607', child: Text('DGII 607')),
                      PopupMenuItem(value: '606', child: Text('DGII 606')),
                    ],
                  ),
                  IconButton(
                    tooltip: 'Actualizar',
                    onPressed: _syncing ? null : _sincronizar,
                    icon: _syncing
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh),
                  ),
                  const SizedBox(width: 8),
                ],
              ),
              SliverPadding(
                padding: const EdgeInsets.all(16),
                sliver: SliverToBoxAdapter(
                  child: _periodAndFilters(),
                ),
              ),
              if (snapshot.connectionState != ConnectionState.done)
                const SliverFillRemaining(
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (snapshot.hasError)
                SliverFillRemaining(
                  child: _ErrorState(
                    error: snapshot.error,
                    onRetry: () => setState(() => _revision++),
                  ),
                )
              else
                _content(snapshot.data!),
            ],
          );
        },
      ),
    );
  }

  Widget _periodAndFilters() {
    return Column(
      children: [
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                const Icon(Icons.date_range_outlined, color: Color(0xff22c55e)),
                DropdownButton<_Periodo>(
                  value: _periodo,
                  underline: const SizedBox.shrink(),
                  items: _Periodo.values
                      .map((value) => DropdownMenuItem(
                            value: value,
                            child: Text(_periodLabel(value)),
                          ))
                      .toList(),
                  onChanged: (value) async {
                    if (value == _Periodo.personalizado) {
                      final selected = await showDateRangePicker(
                        context: context,
                        firstDate: DateTime(2020),
                        lastDate: DateTime.now().add(const Duration(days: 1)),
                        initialDateRange: _personalizado,
                      );
                      if (selected == null) return;
                      setState(() {
                        _personalizado = DateTimeRange(
                          start: selected.start,
                          end: selected.end.add(const Duration(days: 1)),
                        );
                        _periodo = value!;
                      });
                    } else if (value != null) {
                      setState(() => _periodo = value);
                    }
                  },
                ),
                OutlinedButton.icon(
                  onPressed: () =>
                      setState(() => _filtrosAbiertos = !_filtrosAbiertos),
                  icon: const Icon(Icons.tune),
                  label: const Text('Filtros avanzados'),
                ),
              ],
            ),
          ),
        ),
        AnimatedCrossFade(
          duration: const Duration(milliseconds: 180),
          crossFadeState: _filtrosAbiertos
              ? CrossFadeState.showSecond
              : CrossFadeState.showFirst,
          firstChild: const SizedBox(width: double.infinity),
          secondChild: Card(
            margin: const EdgeInsets.only(top: 12),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  SizedBox(
                    width: 280,
                    child: TextField(
                      decoration: const InputDecoration(
                        labelText: 'Buscar factura o cliente',
                        prefixIcon: Icon(Icons.search),
                      ),
                      onChanged: (value) => setState(() => _busqueda = value),
                    ),
                  ),
                  SizedBox(
                    width: 210,
                    child: DropdownButtonFormField<String>(
                      initialValue: _estado,
                      decoration:
                          const InputDecoration(labelText: 'Estado de factura'),
                      items: const [
                        DropdownMenuItem(value: 'todos', child: Text('Todos')),
                        DropdownMenuItem(
                            value: 'completada', child: Text('Completadas')),
                        DropdownMenuItem(
                            value: 'anulada', child: Text('Anuladas')),
                      ],
                      onChanged: (value) =>
                          setState(() => _estado = value ?? 'todos'),
                    ),
                  ),
                  SizedBox(
                    width: 210,
                    child: DropdownButtonFormField<String>(
                      initialValue: _pago,
                      decoration:
                          const InputDecoration(labelText: 'Método de pago'),
                      items: const [
                        DropdownMenuItem(value: 'todos', child: Text('Todos')),
                        DropdownMenuItem(
                            value: 'efectivo', child: Text('Efectivo')),
                        DropdownMenuItem(
                            value: 'tarjeta', child: Text('Tarjeta')),
                        DropdownMenuItem(
                            value: 'transferencia',
                            child: Text('Transferencia')),
                        DropdownMenuItem(
                            value: 'credito', child: Text('Crédito')),
                        DropdownMenuItem(
                            value: 'combinado', child: Text('Combinado')),
                      ],
                      onChanged: (value) =>
                          setState(() => _pago = value ?? 'todos'),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () => setState(() {
                      _estado = 'todos';
                      _pago = 'todos';
                      _busqueda = '';
                    }),
                    icon: const Icon(Icons.filter_alt_off_outlined),
                    label: const Text('Limpiar filtros'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _content(_ReportData data) {
    if (data.sales.isEmpty) {
      return const SliverFillRemaining(
        child: _EmptyState(),
      );
    }
    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      sliver: SliverList.list(
        children: [
          _KpiGrid(data: data),
          const SizedBox(height: 16),
          LayoutBuilder(builder: (context, constraints) {
            final wide = constraints.maxWidth >= 850;
            final trend = _Panel(
              title: 'Evolución de ventas',
              subtitle: 'Ventas netas por día',
              child: _SalesChart(points: data.daily),
            );
            final payment = _Panel(
              title: 'Métodos de pago',
              subtitle: 'Distribución del período',
              child: _PaymentChart(values: data.paymentTotals),
            );
            return wide
                ? Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 2, child: trend),
                      const SizedBox(width: 16),
                      Expanded(child: payment),
                    ],
                  )
                : Column(
                    children: [trend, const SizedBox(height: 16), payment]);
          }),
          const SizedBox(height: 16),
          _Panel(
            title: 'Productos más vendidos',
            subtitle: 'Ranking por cantidad e ingresos',
            child: _TopProducts(products: data.topProducts),
          ),
          const SizedBox(height: 16),
          _Panel(
            title: 'Detalle de ventas',
            subtitle: '${data.sales.length} facturas encontradas',
            child: _SalesList(
              sales: data.sales,
              onOpen: (sale) => _showDetail(sale),
            ),
          ),
        ],
      ),
    );
  }

  Future<_ReportData> _load(_ReportRequest request) async {
    final db = ref.read(databaseProvider);
    final where = <String>[
      'v.empresa_id = ?',
      'v.eliminado = 0',
      'v.creado_en >= ?',
      'v.creado_en < ?',
    ];
    final args = <Object?>[
      request.businessId,
      request.start.toIso8601String(),
      request.end.toIso8601String(),
    ];
    if (request.role == RolBase.cajero) {
      where.add('v.usuario_id = ?');
      args.add(request.userId);
    } else if (request.role == RolBase.administradorSucursal &&
        request.branchId != null) {
      where.add('v.sucursal_id = ?');
      args.add(request.branchId);
    }
    if (request.status != 'todos') {
      where.add('v.estado = ?');
      args.add(request.status);
    }
    if (request.payment != 'todos') {
      where.add('v.metodo_pago = ?');
      args.add(request.payment);
    }
    if (request.search.trim().isNotEmpty) {
      where.add(
          '(v.numero_factura LIKE ? OR c.nombre LIKE ? OR u.nombre LIKE ?)');
      final like = '%${request.search.trim()}%';
      args.addAll([like, like, like]);
    }
    final rows = await db.rawQuery('''
      SELECT v.*, c.nombre AS cliente_nombre, c.cedula_rnc AS cliente_rnc,
             trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) AS cajero_nombre,
             s.nombre AS sucursal_nombre, ca.nombre AS caja_nombre
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN sucursales s ON s.id = v.sucursal_id
      LEFT JOIN cajas ca ON ca.id = v.caja_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.creado_en DESC
      LIMIT 500
    ''', args);
    final sales = rows.map(_ReportSale.fromMap).toList();
    final ids = sales.map((e) => e.id).toList();
    final items = ids.isEmpty ? <Map<String, Object?>>[] : await db.rawQuery('''
            SELECT vi.*, p.precio_compra, p.sku, inv.stock
            FROM venta_items vi
            LEFT JOIN productos p ON p.id = vi.producto_id
            LEFT JOIN inventario_sucursal inv
              ON inv.producto_id = vi.producto_id
             AND inv.sucursal_id = vi.sucursal_id
            WHERE vi.venta_id IN (${List.filled(ids.length, '?').join(',')})
              AND vi.eliminado = 0
          ''', ids);
    final previousStart = request.start.subtract(
      request.end.difference(request.start),
    );
    final previous = await db.rawQuery('''
      SELECT coalesce(sum(total), 0) AS total
      FROM ventas
      WHERE empresa_id = ? AND eliminado = 0 AND estado = 'completada'
        AND creado_en >= ? AND creado_en < ?
    ''', [
      request.businessId,
      previousStart.toIso8601String(),
      request.start.toIso8601String(),
    ]);
    return _ReportData.from(sales, items,
        previousTotal: (previous.first['total'] as num?)?.toDouble() ?? 0);
  }

  Future<void> _sincronizar() async {
    final auth = ref.read(authControllerProvider);
    final user = auth.usuario;
    final businessId = auth.empresaId;
    if (user == null || businessId == null) return;
    setState(() => _syncing = true);
    try {
      final company =
          await ref.read(empresaRepositoryProvider).porId(businessId);
      final remoteBusinessId = company?.remotoId;
      await ref.read(salesSyncServiceProvider).syncPendingSales(businessId);
      if (remoteBusinessId?.isNotEmpty == true) {
        final deviceId = await ref
            .read(secureSessionServiceProvider)
            .obtenerOCrearDeviceId();
        await ref.read(cloudBusinessSyncRepositoryProvider).pullInitial(
              localBusinessId: businessId,
              remoteBusinessId: remoteBusinessId!,
              localUserId: user.id,
              deviceId: deviceId,
            );
      }
      if (mounted) setState(() => _revision++);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text('No se pudo completar la sincronización: $error')),
        );
      }
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  void _showDetail(_ReportSale sale) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: .88,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: ListView(
            children: [
              Text(
                'Factura ${sale.number}',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 12),
              _detail('Fecha', Formatters.dateTime(sale.createdAt)),
              _detail('Cliente', sale.customer),
              _detail('Cajero', sale.cashier),
              _detail('Sucursal', sale.branch),
              _detail('Caja', sale.register),
              _detail('Estado', sale.status),
              _detail('Forma de pago', sale.payment),
              const Divider(height: 28),
              _detail('Subtotal', Formatters.currency(sale.subtotal)),
              _detail('Descuento', Formatters.currency(sale.discount)),
              _detail('ITBIS', Formatters.currency(sale.tax)),
              _detail('Total', Formatters.currency(sale.total), bold: true),
              _detail('Sincronización', sale.syncStatus),
            ],
          ),
        ),
      ),
    );
  }

  Widget _detail(String label, String value, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(
          children: [
            Expanded(child: Text(label)),
            Text(value,
                style: TextStyle(
                    fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
          ],
        ),
      );

  Future<void> _exportar(_ReportData data) async {
    final buffer = StringBuffer(
        'Factura,Fecha,Cliente,Cajero,Estado,Pago,Subtotal,Descuento,ITBIS,Total\n');
    for (final sale in data.sales) {
      String csv(String value) => '"${value.replaceAll('"', '""')}"';
      buffer.writeln([
        csv(sale.number),
        csv(sale.createdAt.toIso8601String()),
        csv(sale.customer),
        csv(sale.cashier),
        csv(sale.status),
        csv(sale.payment),
        sale.subtotal.toStringAsFixed(2),
        sale.discount.toStringAsFixed(2),
        sale.tax.toStringAsFixed(2),
        sale.total.toStringAsFixed(2),
      ].join(','));
    }
    await Share.share(buffer.toString(), subject: 'Reporte de ventas');
  }

  Future<void> _exportar607(_ReportData data) async {
    final buffer = StringBuffer(
      'RNC_CEDULA,Tipo_ID,NCF,NCF_MODIFICADO,Tipo_Ingreso,Fecha_Comprobante,'
      'Fecha_Retencion,Monto_Facturado,ITBIS_Facturado,ITBIS_Retenido,'
      'ITBIS_Percibido,Retencion_Renta,ISR_Percibido,Impuesto_Selectivo,'
      'Otros_Impuestos,Propina_Legal,Efectivo,Cheque_Transferencia,'
      'Tarjeta,Credito,Bonos,Permuta,Otras_Formas\n',
    );
    String csv(String value) => '"${value.replaceAll('"', '""')}"';
    for (final sale in data.sales.where((s) =>
        s.status == EstadoVenta.completada &&
        (s.ncf?.trim().isNotEmpty ?? false))) {
      final efectivo = sale.payment == MetodoPago.efectivo ? sale.total : 0;
      final transferencia =
          sale.payment == MetodoPago.transferencia ? sale.total : 0;
      final tarjeta = sale.payment == MetodoPago.tarjeta ? sale.total : 0;
      final credito = sale.payment == MetodoPago.credito ? sale.total : 0;
      buffer.writeln([
        csv(sale.customerTaxId ?? ''),
        csv((sale.customerTaxId ?? '').length == 11 ? '2' : '1'),
        csv(sale.ncf ?? ''),
        csv(''),
        csv('01'),
        csv(_dgiiDate(sale.createdAt)),
        csv(''),
        sale.subtotal.toStringAsFixed(2),
        sale.tax.toStringAsFixed(2),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        efectivo.toStringAsFixed(2),
        transferencia.toStringAsFixed(2),
        tarjeta.toStringAsFixed(2),
        credito.toStringAsFixed(2),
        '0.00',
        '0.00',
        '0.00',
      ].join(','));
    }
    await Share.share(buffer.toString(), subject: 'Formato DGII 607');
  }

  Future<void> _exportar606() async {
    final auth = ref.read(authControllerProvider);
    final empresaId = auth.empresaId;
    if (empresaId == null) return;
    final db = ref.read(databaseProvider);
    final rows = await db.rawQuery(
      '''
      SELECT c.*, p.rnc, p.nombre AS proveedor_nombre
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.empresa_id = ?
        AND c.eliminado = 0
        AND c.fecha_emision >= ?
        AND c.fecha_emision < ?
      ORDER BY c.fecha_emision ASC
      ''',
      [empresaId, _rango.start.toIso8601String(), _rango.end.toIso8601String()],
    );
    final gastos = await db.rawQuery(
      '''
      SELECT g.*, p.rnc, p.nombre AS proveedor_nombre
      FROM gastos_operativos g
      LEFT JOIN proveedores p ON p.id = g.proveedor_id
      WHERE g.empresa_id = ?
        AND g.eliminado = 0
        AND g.estado != 'anulado'
        AND g.fecha_comprobante >= ?
        AND g.fecha_comprobante < ?
      ORDER BY g.fecha_comprobante ASC
      ''',
      [empresaId, _rango.start.toIso8601String(), _rango.end.toIso8601String()],
    );
    final buffer = StringBuffer(
      'RNC_CEDULA,Tipo_ID,Tipo_Bienes_Servicios,NCF,NCF_Modificado,'
      'Fecha_Comprobante,Fecha_Pago,Monto_Facturado,ITBIS_Facturado,'
      'ITBIS_Retenido,ITBIS_Sujeto_Proporcionalidad,ITBIS_Llevado_Costo,'
      'ITBIS_Adelantar,ITBIS_Percibido_Compras,Tipo_Retencion_ISR,'
      'Monto_Retencion_Renta,ISR_Percibido_Compras,Impuesto_Selectivo,'
      'Otros_Impuestos,Tasa,Forma_Pago\n',
    );
    String csv(String value) => '"${value.replaceAll('"', '""')}"';
    for (final row in rows) {
      final rnc = row['rnc']?.toString() ?? '';
      final fecha = DateTime.tryParse(row['fecha_emision']?.toString() ?? '');
      final total = (row['monto_total'] as num?)?.toDouble() ?? 0;
      buffer.writeln([
        csv(rnc),
        csv(rnc.length == 11 ? '2' : '1'),
        csv('09'),
        csv(row['numero_factura']?.toString() ?? ''),
        csv(''),
        csv(fecha == null ? '' : _dgiiDate(fecha)),
        csv(''),
        total.toStringAsFixed(2),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        csv(''),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        csv('04'),
      ].join(','));
    }
    for (final row in gastos) {
      final rnc = row['rnc']?.toString() ?? '';
      final fecha =
          DateTime.tryParse(row['fecha_comprobante']?.toString() ?? '');
      final total = (row['monto_total'] as num?)?.toDouble() ?? 0;
      final itbis = (row['itbis'] as num?)?.toDouble() ?? 0;
      buffer.writeln([
        csv(rnc),
        csv(rnc.length == 11 ? '2' : '1'),
        csv('09'),
        csv(row['ncf']?.toString() ?? ''),
        csv(''),
        csv(fecha == null ? '' : _dgiiDate(fecha)),
        csv(''),
        total.toStringAsFixed(2),
        itbis.toStringAsFixed(2),
        '0.00',
        '0.00',
        '0.00',
        itbis.toStringAsFixed(2),
        '0.00',
        csv(''),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        csv('04'),
      ].join(','));
    }
    await Share.share(buffer.toString(), subject: 'Formato DGII 606');
  }

  String _dgiiDate(DateTime date) {
    final local = date.toLocal();
    return '${local.year.toString().padLeft(4, '0')}'
        '${local.month.toString().padLeft(2, '0')}'
        '${local.day.toString().padLeft(2, '0')}';
  }

  String _periodLabel(_Periodo value) => switch (value) {
        _Periodo.hoy => 'Hoy',
        _Periodo.ayer => 'Ayer',
        _Periodo.semana => 'Esta semana',
        _Periodo.mes => 'Este mes',
        _Periodo.mesAnterior => 'Mes anterior',
        _Periodo.ano => 'Este año',
        _Periodo.personalizado => 'Personalizado',
      };
}

class _KpiGrid extends StatelessWidget {
  const _KpiGrid({required this.data});
  final _ReportData data;

  @override
  Widget build(BuildContext context) {
    final items = [
      _Kpi('Ventas totales', Formatters.currency(data.total), Icons.trending_up,
          '${data.growth >= 0 ? '+' : ''}${data.growth.toStringAsFixed(1)}%'),
      _Kpi('Facturas emitidas', '${data.invoices}', Icons.receipt_long,
          '${data.invoices} transacciones'),
      _Kpi('Ganancia estimada', Formatters.currency(data.profit),
          Icons.savings_outlined, 'Margen ${data.margin.toStringAsFixed(1)}%'),
      _Kpi('Ticket promedio', Formatters.currency(data.averageTicket),
          Icons.confirmation_number_outlined, 'Por factura'),
      _Kpi('Productos vendidos', data.units.toStringAsFixed(2),
          Icons.inventory_2_outlined, 'Unidades'),
      _Kpi('ITBIS recaudado', Formatters.currency(data.tax),
          Icons.account_balance_outlined, 'Impuestos'),
      _Kpi('Ventas anuladas', '${data.cancelledCount}', Icons.cancel_outlined,
          Formatters.currency(data.cancelledTotal),
          danger: true),
      _Kpi('Ventas a crédito', Formatters.currency(data.credit),
          Icons.credit_score_outlined, 'Saldo originado'),
    ];
    return LayoutBuilder(builder: (context, constraints) {
      final columns = constraints.maxWidth >= 1100
          ? 4
          : constraints.maxWidth >= 650
              ? 2
              : 1;
      const gap = 12.0;
      final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: items
            .map((item) => SizedBox(width: width, child: _KpiCard(item: item)))
            .toList(),
      );
    });
  }
}

class _Kpi {
  const _Kpi(this.label, this.value, this.icon, this.note,
      {this.danger = false});
  final String label;
  final String value;
  final IconData icon;
  final String note;
  final bool danger;
}

class _KpiCard extends StatelessWidget {
  const _KpiCard({required this.item});
  final _Kpi item;
  @override
  Widget build(BuildContext context) {
    final color = item.danger ? Colors.red : const Color(0xff16a34a);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: color.withValues(alpha: .1),
              foregroundColor: color,
              child: Icon(item.icon),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.label,
                      style: Theme.of(context).textTheme.bodySmall),
                  Text(item.value,
                      style: Theme.of(context)
                          .textTheme
                          .titleLarge
                          ?.copyWith(fontWeight: FontWeight.w800)),
                  Text(item.note, style: TextStyle(fontSize: 11, color: color)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel(
      {required this.title, required this.subtitle, required this.child});
  final String title;
  final String subtitle;
  final Widget child;
  @override
  Widget build(BuildContext context) => Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 16),
              child,
            ],
          ),
        ),
      );
}

class _SalesChart extends StatelessWidget {
  const _SalesChart({required this.points});
  final List<_DailyPoint> points;
  @override
  Widget build(BuildContext context) {
    final maxY = points.fold<double>(0, (v, e) => math.max(v, e.total));
    return SizedBox(
      height: 260,
      child: LineChart(LineChartData(
        minY: 0,
        maxY: maxY <= 0 ? 1 : maxY * 1.2,
        gridData: const FlGridData(show: true, drawVerticalLine: false),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles:
              const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          rightTitles:
              const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          leftTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: true, reservedSize: 45)),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 30,
              interval: math.max(1, (points.length / 6).ceilToDouble()),
              getTitlesWidget: (value, meta) {
                final index = value.toInt();
                if (index < 0 || index >= points.length) {
                  return const SizedBox.shrink();
                }
                return Text(
                    '${points[index].date.day}/${points[index].date.month}',
                    style: const TextStyle(fontSize: 10));
              },
            ),
          ),
        ),
        lineBarsData: [
          LineChartBarData(
            spots: [
              for (var i = 0; i < points.length; i++)
                FlSpot(i.toDouble(), points[i].total)
            ],
            color: const Color(0xff22c55e),
            barWidth: 3,
            isCurved: true,
            dotData: const FlDotData(show: false),
            belowBarData: BarAreaData(
              show: true,
              color: const Color(0xff22c55e).withValues(alpha: .12),
            ),
          ),
        ],
      )),
    );
  }
}

class _PaymentChart extends StatelessWidget {
  const _PaymentChart({required this.values});
  final Map<String, double> values;
  @override
  Widget build(BuildContext context) {
    const colors = [
      Color(0xff22c55e),
      Color(0xff3b82f6),
      Color(0xff8b5cf6),
      Color(0xfff59e0b),
      Color(0xff64748b),
    ];
    final entries = values.entries.where((e) => e.value > 0).toList();
    return SizedBox(
      height: 260,
      child: entries.isEmpty
          ? const Center(child: Text('Sin métodos de pago'))
          : Row(
              children: [
                Expanded(
                  child: PieChart(PieChartData(
                    centerSpaceRadius: 42,
                    sectionsSpace: 2,
                    sections: [
                      for (var i = 0; i < entries.length; i++)
                        PieChartSectionData(
                          value: entries[i].value,
                          color: colors[i % colors.length],
                          showTitle: false,
                          radius: 46,
                        )
                    ],
                  )),
                ),
                Expanded(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: entries.length,
                    itemBuilder: (_, i) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(children: [
                        Container(
                            width: 9,
                            height: 9,
                            color: colors[i % colors.length]),
                        const SizedBox(width: 7),
                        Expanded(child: Text(entries[i].key)),
                        Text(Formatters.currency(entries[i].value)),
                      ]),
                    ),
                  ),
                ),
              ],
            ),
    );
  }
}

class _TopProducts extends StatelessWidget {
  const _TopProducts({required this.products});
  final List<_TopProduct> products;
  @override
  Widget build(BuildContext context) => products.isEmpty
      ? const Text('No hay productos vendidos en el período.')
      : Column(
          children: [
            for (var i = 0; i < math.min(products.length, 10); i++)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(child: Text('${i + 1}')),
                title: Text(products[i].name),
                subtitle: Text(
                    '${products[i].quantity.toStringAsFixed(2)} unidades · Ganancia ${Formatters.currency(products[i].profit)}'),
                trailing: Text(Formatters.currency(products[i].revenue),
                    style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
          ],
        );
}

class _SalesList extends StatelessWidget {
  const _SalesList({required this.sales, required this.onOpen});
  final List<_ReportSale> sales;
  final ValueChanged<_ReportSale> onOpen;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth < 720) {
            return Column(
              children: sales
                  .map((sale) => ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          sale.status == EstadoVenta.anulada
                              ? Icons.cancel_outlined
                              : Icons.receipt_long_outlined,
                          color: sale.status == EstadoVenta.anulada
                              ? Colors.red
                              : Colors.green,
                        ),
                        title: Text(sale.number),
                        subtitle: Text(
                            '${Formatters.dateTime(sale.createdAt)} · ${sale.customer}'),
                        trailing: Text(Formatters.currency(sale.total)),
                        onTap: () => onOpen(sale),
                      ))
                  .toList(),
            );
          }
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(
              showCheckboxColumn: false,
              columns: const [
                DataColumn(label: Text('Factura')),
                DataColumn(label: Text('Fecha')),
                DataColumn(label: Text('Cliente')),
                DataColumn(label: Text('Cajero')),
                DataColumn(label: Text('Estado')),
                DataColumn(label: Text('Pago')),
                DataColumn(label: Text('ITBIS'), numeric: true),
                DataColumn(label: Text('Total'), numeric: true),
                DataColumn(label: Text('Sync')),
              ],
              rows: sales
                  .map((sale) => DataRow(
                        onSelectChanged: (_) => onOpen(sale),
                        cells: [
                          DataCell(Text(sale.number)),
                          DataCell(Text(Formatters.dateTime(sale.createdAt))),
                          DataCell(Text(sale.customer)),
                          DataCell(Text(sale.cashier)),
                          DataCell(_StatusChip(status: sale.status)),
                          DataCell(Text(sale.payment)),
                          DataCell(Text(Formatters.currency(sale.tax))),
                          DataCell(Text(Formatters.currency(sale.total))),
                          DataCell(Text(sale.syncStatus)),
                        ],
                      ))
                  .toList(),
            ),
          );
        },
      );
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final color = status == EstadoVenta.anulada
        ? Colors.red
        : status == EstadoVenta.completada
            ? Colors.green
            : Colors.amber;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
          color: color.withValues(alpha: .1),
          borderRadius: BorderRadius.circular(99)),
      child: Text(status, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) => const Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.query_stats, size: 56, color: Colors.grey),
          SizedBox(height: 12),
          Text('No se encontraron ventas para este período.'),
          Text('Prueba cambiando los filtros o seleccionando otra fecha.'),
        ]),
      );
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error, required this.onRetry});
  final Object? error;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.error_outline, size: 52, color: Colors.red),
          const SizedBox(height: 10),
          Text('No se pudo cargar el reporte: $error'),
          const SizedBox(height: 10),
          FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Reintentar')),
        ]),
      );
}

class _ReportRequest {
  const _ReportRequest({
    required this.businessId,
    required this.userId,
    required this.branchId,
    required this.role,
    required this.start,
    required this.end,
    required this.status,
    required this.payment,
    required this.search,
    required this.revision,
  });
  final String businessId;
  final String userId;
  final String? branchId;
  final RolBase role;
  final DateTime start;
  final DateTime end;
  final String status;
  final String payment;
  final String search;
  final int revision;
}

class _ReportSale {
  const _ReportSale({
    required this.id,
    required this.number,
    required this.createdAt,
    required this.customer,
    required this.cashier,
    required this.branch,
    required this.register,
    required this.status,
    required this.payment,
    required this.subtotal,
    required this.discount,
    required this.tax,
    required this.total,
    required this.syncStatus,
    this.ncf,
    this.customerTaxId,
  });
  final String id;
  final String number;
  final DateTime createdAt;
  final String customer;
  final String cashier;
  final String branch;
  final String register;
  final String status;
  final String payment;
  final double subtotal;
  final double discount;
  final double tax;
  final double total;
  final String syncStatus;
  final String? ncf;
  final String? customerTaxId;

  factory _ReportSale.fromMap(Map<String, Object?> map) => _ReportSale(
        id: map['id']!.toString(),
        number: map['numero_factura']?.toString() ??
            map['id']!.toString().substring(0, 8),
        createdAt: DateTime.parse(map['creado_en']!.toString()),
        customer: map['cliente_nombre']?.toString().trim().isNotEmpty == true
            ? map['cliente_nombre']!.toString()
            : 'Consumidor final',
        cashier: map['cajero_nombre']?.toString().trim().isNotEmpty == true
            ? map['cajero_nombre']!.toString()
            : 'Usuario',
        branch: map['sucursal_nombre']?.toString() ?? 'Principal',
        register: map['caja_nombre']?.toString() ?? 'Caja',
        status: map['estado']?.toString() ?? EstadoVenta.completada,
        payment: map['metodo_pago']?.toString() ?? MetodoPago.efectivo,
        subtotal: (map['subtotal'] as num?)?.toDouble() ?? 0,
        discount: (map['descuento_monto'] as num?)?.toDouble() ?? 0,
        tax: (map['itbis'] as num?)?.toDouble() ?? 0,
        total: (map['total'] as num?)?.toDouble() ?? 0,
        syncStatus: map['sync_estado']?.toString() ?? 'pendiente',
        ncf: map['encf']?.toString(),
        customerTaxId: map['cliente_rnc']?.toString(),
      );
}

class _ReportData {
  const _ReportData({
    required this.sales,
    required this.total,
    required this.invoices,
    required this.profit,
    required this.units,
    required this.tax,
    required this.cancelledCount,
    required this.cancelledTotal,
    required this.credit,
    required this.previousTotal,
    required this.paymentTotals,
    required this.daily,
    required this.topProducts,
  });
  final List<_ReportSale> sales;
  final double total;
  final int invoices;
  final double profit;
  final double units;
  final double tax;
  final int cancelledCount;
  final double cancelledTotal;
  final double credit;
  final double previousTotal;
  final Map<String, double> paymentTotals;
  final List<_DailyPoint> daily;
  final List<_TopProduct> topProducts;

  double get averageTicket => invoices == 0 ? 0 : total / invoices;
  double get margin => total == 0 ? 0 : (profit / total) * 100;
  double get growth => previousTotal == 0
      ? (total > 0 ? 100 : 0)
      : ((total - previousTotal) / previousTotal) * 100;

  factory _ReportData.from(
    List<_ReportSale> sales,
    List<Map<String, Object?>> items, {
    required double previousTotal,
  }) {
    final completed =
        sales.where((e) => e.status == EstadoVenta.completada).toList();
    final cancelled =
        sales.where((e) => e.status == EstadoVenta.anulada).toList();
    final paymentTotals = <String, double>{};
    final dailyMap = <DateTime, double>{};
    for (final sale in completed) {
      paymentTotals.update(sale.payment, (v) => v + sale.total,
          ifAbsent: () => sale.total);
      final day = DateTime(
          sale.createdAt.year, sale.createdAt.month, sale.createdAt.day);
      dailyMap.update(day, (v) => v + sale.total, ifAbsent: () => sale.total);
    }
    final products = <String, _TopProduct>{};
    var units = 0.0;
    var profit = 0.0;
    final completedIds = completed.map((e) => e.id).toSet();
    for (final row in items) {
      if (!completedIds.contains(row['venta_id']?.toString())) continue;
      final quantity = (row['cantidad'] as num?)?.toDouble() ?? 0;
      final revenue = (row['subtotal_linea'] as num?)?.toDouble() ?? 0;
      final cost = (row['precio_compra'] as num?)?.toDouble() ?? 0;
      final itemProfit = revenue - (cost * quantity);
      units += quantity;
      profit += itemProfit;
      final key = row['producto_id']?.toString() ??
          row['nombre_producto_snapshot'].toString();
      final existing = products[key];
      products[key] = _TopProduct(
        name: row['nombre_producto_snapshot']?.toString() ?? 'Producto',
        quantity: (existing?.quantity ?? 0) + quantity,
        revenue: (existing?.revenue ?? 0) + revenue,
        profit: (existing?.profit ?? 0) + itemProfit,
      );
    }
    final top = products.values.toList()
      ..sort((a, b) => b.quantity.compareTo(a.quantity));
    final daily = dailyMap.entries
        .map((e) => _DailyPoint(e.key, e.value))
        .toList()
      ..sort((a, b) => a.date.compareTo(b.date));
    return _ReportData(
      sales: sales,
      total: completed.fold(0, (v, e) => v + e.total),
      invoices: completed.length,
      profit: profit,
      units: units,
      tax: completed.fold(0, (v, e) => v + e.tax),
      cancelledCount: cancelled.length,
      cancelledTotal: cancelled.fold(0, (v, e) => v + e.total),
      credit: completed
          .where((e) => e.payment == MetodoPago.credito)
          .fold(0, (v, e) => v + e.total),
      previousTotal: previousTotal,
      paymentTotals: paymentTotals,
      daily: daily,
      topProducts: top,
    );
  }
}

class _DailyPoint {
  const _DailyPoint(this.date, this.total);
  final DateTime date;
  final double total;
}

class _TopProduct {
  const _TopProduct({
    required this.name,
    required this.quantity,
    required this.revenue,
    required this.profit,
  });
  final String name;
  final double quantity;
  final double revenue;
  final double profit;
}
