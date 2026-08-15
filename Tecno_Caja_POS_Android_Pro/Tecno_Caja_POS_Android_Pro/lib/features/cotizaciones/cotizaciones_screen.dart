import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/cotizacion_repository.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/venta.dart';
import '../pos/widgets/selector_cliente.dart';

class CotizacionesScreen extends ConsumerStatefulWidget {
  const CotizacionesScreen({super.key});

  @override
  ConsumerState<CotizacionesScreen> createState() => _CotizacionesScreenState();
}

class _CotizacionesScreenState extends ConsumerState<CotizacionesScreen> {
  List<CotizacionResumen> _cotizaciones = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargando = true);
    final cotizaciones =
        await ref.read(cotizacionRepositoryProvider).deEmpresa(empresaId);
    if (mounted) {
      setState(() {
        _cotizaciones = cotizaciones;
        _cargando = false;
      });
    }
  }

  Future<void> _nueva() async {
    final guardada = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const CotizacionFormScreen()),
    );
    if (guardada == true) await _cargar();
  }

  Future<void> _abrir(CotizacionResumen cotizacion) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => CotizacionDetalleScreen(cotizacion: cotizacion),
      ),
    );
    if (changed == true) await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final pendientes = _cotizaciones
        .where((c) => c.estado == 'pendiente' || c.estado == 'borrador')
        .toList();
    final totalPendiente =
        pendientes.fold<double>(0, (sum, c) => sum + c.total);

    return Scaffold(
      appBar: AppBar(title: const Text('Cotizaciones')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _nueva,
        icon: const Icon(Icons.request_quote),
        label: const Text('Cotizar'),
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: _cargando
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: _MetricCard(
                          label: 'Pendientes',
                          value: '${pendientes.length}',
                          icon: Icons.pending_actions,
                          color: AppColors.info,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _MetricCard(
                          label: 'Valor abierto',
                          value: Formatters.currency(totalPendiente),
                          icon: Icons.price_check,
                          color: AppColors.primary,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (_cotizaciones.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(top: 72),
                      child: Center(child: Text('No hay cotizaciones todavía')),
                    )
                  else
                    for (final cotizacion in _cotizaciones) ...[
                      _CotizacionTile(
                        cotizacion: cotizacion,
                        onTap: () => _abrir(cotizacion),
                      ),
                      const SizedBox(height: 8),
                    ],
                ],
              ),
      ),
    );
  }
}

class CotizacionFormScreen extends ConsumerStatefulWidget {
  const CotizacionFormScreen({super.key});

  @override
  ConsumerState<CotizacionFormScreen> createState() =>
      _CotizacionFormScreenState();
}

class _CotizacionFormScreenState extends ConsumerState<CotizacionFormScreen> {
  final _busquedaCtrl = TextEditingController();
  final _notaCtrl = TextEditingController();
  List<Producto> _productos = [];
  final Map<String, _LineaCotizacionUi> _lineas = {};
  String? _clienteId;
  String? _clienteNombre;
  bool _cargandoProductos = true;
  bool _guardando = false;

  @override
  void initState() {
    super.initState();
    _cargarProductos('');
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    _notaCtrl.dispose();
    super.dispose();
  }

  Future<void> _cargarProductos(String termino) async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargandoProductos = true);
    final repo = ref.read(productoRepositoryProvider);
    final productos = termino.trim().isEmpty
        ? await repo.deEmpresa(empresaId)
        : await repo.buscar(empresaId, termino);
    if (mounted) {
      setState(() {
        _productos = productos;
        _cargandoProductos = false;
      });
    }
  }

  void _agregar(Producto producto) {
    setState(() {
      final actual = _lineas[producto.id];
      if (actual == null) {
        _lineas[producto.id] = _LineaCotizacionUi(producto: producto);
      } else {
        actual.cantidad += 1;
      }
    });
  }

  double get _total {
    return _lineas.values.fold<double>(
      0,
      (sum, linea) =>
          sum +
          ((linea.producto.precioVenta * linea.cantidad) - linea.descuento),
    );
  }

  Future<void> _seleccionarCliente() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    final cliente = await mostrarSelectorCliente(context, empresaId);
    if (cliente == null) return;
    setState(() {
      _clienteId = cliente.id;
      _clienteNombre = cliente.nombre;
    });
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    if (auth.empresaId == null || usuario == null || _lineas.isEmpty) return;

    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(cotizacionRepositoryProvider).crear(
            empresaId: auth.empresaId!,
            usuarioId: usuario.id,
            clienteId: _clienteId,
            sucursalId: sucursal?.id,
            cajaId: caja?.id,
            nota: _notaCtrl.text.trim().isEmpty ? null : _notaCtrl.text.trim(),
            dispositivoId: deviceId,
            lineas: _lineas.values
                .map(
                  (linea) => LineaCotizacionSolicitada(
                    producto: linea.producto,
                    cantidad: linea.cantidad,
                    descuento: linea.descuento,
                  ),
                )
                .toList(),
          );
      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nueva cotización')),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final esTablet = constraints.maxWidth >= 780;
          final catalogo = _CatalogoCotizacion(
            busquedaCtrl: _busquedaCtrl,
            productos: _productos,
            cargando: _cargandoProductos,
            onBuscar: _cargarProductos,
            onAgregar: _agregar,
          );
          final resumen = _ResumenCotizacion(
            clienteNombre: _clienteNombre,
            lineas: _lineas.values.toList(),
            notaCtrl: _notaCtrl,
            total: _total,
            guardando: _guardando,
            onCliente: _seleccionarCliente,
            onGuardar: _guardar,
            onChanged: () => setState(() {}),
            onRemove: (id) => setState(() => _lineas.remove(id)),
          );
          if (esTablet) {
            return Row(
              children: [
                Expanded(child: catalogo),
                SizedBox(width: 390, child: resumen),
              ],
            );
          }
          return Stack(
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 86),
                child: catalogo,
              ),
              Align(
                alignment: Alignment.bottomCenter,
                child: Material(
                  elevation: 8,
                  child: ListTile(
                    title: Text('${_lineas.length} producto(s)'),
                    subtitle: Text(Formatters.currency(_total)),
                    trailing: FilledButton(
                      onPressed: () => showModalBottomSheet<void>(
                        context: context,
                        isScrollControlled: true,
                        builder: (_) => SizedBox(
                          height: MediaQuery.of(context).size.height * 0.82,
                          child: resumen,
                        ),
                      ),
                      child: const Text('Revisar'),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class CotizacionDetalleScreen extends ConsumerWidget {
  const CotizacionDetalleScreen({super.key, required this.cotizacion});

  final CotizacionResumen cotizacion;

  Future<void> _convertir(BuildContext context, WidgetRef ref) async {
    final sesion = await ref.read(sesionCajaActivaProvider.future);
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    if (sesion == null || usuario == null) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Abre la caja para convertir a venta.')),
      );
      return;
    }
    final items =
        await ref.read(cotizacionRepositoryProvider).itemsDe(cotizacion.id);
    final deviceId =
        await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    final venta = await ref.read(ventaRepositoryProvider).registrarVenta(
          empresaId: cotizacion.empresaId,
          sucursalId: sesion.sucursalId,
          cajaId: sesion.cajaId,
          sesionCajaId: sesion.id,
          usuarioId: usuario.id,
          clienteId: cotizacion.clienteId,
          metodoPago: MetodoPago.efectivo,
          nota: 'Generada desde ${cotizacion.numero ?? cotizacion.id}',
          dispositivoId: deviceId,
          permitirStockNegativo: true,
          lineas: items
              .map(
                (item) => LineaVentaSolicitada(
                  productoId: item.productoId,
                  nombreProducto: item.nombreProducto,
                  cantidad: item.cantidad,
                  precioUnitario: item.precioUnitario,
                  descuentoMonto: item.descuento,
                ),
              )
              .toList(),
        );
    await ref.read(cotizacionRepositoryProvider).marcarConvertida(
          cotizacion: cotizacion,
          ventaId: venta.id,
        );
    if (context.mounted) Navigator.of(context).pop(true);
  }

  Future<void> _anular(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Anular cotización'),
        content: const Text('La cotización quedará marcada como anulada.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Anular'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(cotizacionRepositoryProvider).anular(cotizacion);
    if (context.mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final editable =
        cotizacion.estado == 'pendiente' || cotizacion.estado == 'borrador';
    return Scaffold(
      appBar: AppBar(title: Text(cotizacion.numero ?? 'Cotización')),
      body: FutureBuilder<List<CotizacionItemResumen>>(
        future: ref.read(cotizacionRepositoryProvider).itemsDe(cotizacion.id),
        builder: (context, snapshot) {
          final items = snapshot.data ?? const <CotizacionItemResumen>[];
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _EstadoChip(estado: cotizacion.estado),
                      const SizedBox(height: 12),
                      Text(
                        cotizacion.clienteNombre ?? 'Cliente no asignado',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                          'Emitida ${Formatters.date(cotizacion.fechaEmision)}'),
                      if (cotizacion.nota?.isNotEmpty == true) ...[
                        const SizedBox(height: 8),
                        Text(cotizacion.nota!),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              for (final item in items)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(item.nombreProducto),
                  subtitle: Text(
                    '${item.cantidad.toStringAsFixed(2)} x '
                    '${Formatters.currency(item.precioUnitario)}',
                  ),
                  trailing: Text(Formatters.currency(item.subtotalLinea)),
                ),
              const Divider(height: 28),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('Total', style: Theme.of(context).textTheme.titleLarge),
                  Text(
                    Formatters.currency(cotizacion.total),
                    style: Theme.of(context)
                        .textTheme
                        .titleLarge
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                ],
              ),
              if (editable) ...[
                const SizedBox(height: 24),
                FilledButton.icon(
                  onPressed: () => _convertir(context, ref),
                  icon: const Icon(Icons.point_of_sale),
                  label: const Text('Convertir en venta'),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () => _anular(context, ref),
                  icon: const Icon(Icons.cancel_outlined),
                  label: const Text('Anular'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _CatalogoCotizacion extends StatelessWidget {
  const _CatalogoCotizacion({
    required this.busquedaCtrl,
    required this.productos,
    required this.cargando,
    required this.onBuscar,
    required this.onAgregar,
  });

  final TextEditingController busquedaCtrl;
  final List<Producto> productos;
  final bool cargando;
  final ValueChanged<String> onBuscar;
  final ValueChanged<Producto> onAgregar;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: busquedaCtrl,
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Buscar producto',
            ),
            onChanged: onBuscar,
          ),
        ),
        Expanded(
          child: cargando
              ? const Center(child: CircularProgressIndicator())
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  itemCount: productos.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final producto = productos[index];
                    return ListTile(
                      leading: const CircleAvatar(
                        child: Icon(Icons.inventory_2_outlined),
                      ),
                      title: Text(producto.nombre),
                      subtitle: Text(Formatters.currency(producto.precioVenta)),
                      trailing: IconButton(
                        icon: const Icon(Icons.add_circle_outline),
                        onPressed: () => onAgregar(producto),
                      ),
                      onTap: () => onAgregar(producto),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

class _ResumenCotizacion extends StatelessWidget {
  const _ResumenCotizacion({
    required this.clienteNombre,
    required this.lineas,
    required this.notaCtrl,
    required this.total,
    required this.guardando,
    required this.onCliente,
    required this.onGuardar,
    required this.onChanged,
    required this.onRemove,
  });

  final String? clienteNombre;
  final List<_LineaCotizacionUi> lineas;
  final TextEditingController notaCtrl;
  final double total;
  final bool guardando;
  final VoidCallback onCliente;
  final VoidCallback onGuardar;
  final VoidCallback onChanged;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return Material(
      child: Column(
        children: [
          ListTile(
            title: Text(clienteNombre ?? 'Cliente no asignado'),
            leading: const Icon(Icons.person_outline),
            trailing: const Icon(Icons.chevron_right),
            onTap: onCliente,
          ),
          const Divider(height: 1),
          Expanded(
            child: lineas.isEmpty
                ? const Center(child: Text('Agrega productos a la cotización'))
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: lineas.length,
                    itemBuilder: (context, index) {
                      final linea = lineas[index];
                      return Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        child: Padding(
                          padding: const EdgeInsets.all(10),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Expanded(child: Text(linea.producto.nombre)),
                                  IconButton(
                                    icon: const Icon(Icons.close),
                                    onPressed: () =>
                                        onRemove(linea.producto.id),
                                  ),
                                ],
                              ),
                              Row(
                                children: [
                                  IconButton(
                                    icon:
                                        const Icon(Icons.remove_circle_outline),
                                    onPressed: () {
                                      if (linea.cantidad > 1) {
                                        linea.cantidad -= 1;
                                        onChanged();
                                      }
                                    },
                                  ),
                                  Text(linea.cantidad.toStringAsFixed(0)),
                                  IconButton(
                                    icon: const Icon(Icons.add_circle_outline),
                                    onPressed: () {
                                      linea.cantidad += 1;
                                      onChanged();
                                    },
                                  ),
                                  const Spacer(),
                                  Text(
                                    Formatters.currency(
                                      linea.producto.precioVenta *
                                          linea.cantidad,
                                    ),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                TextField(
                  controller: notaCtrl,
                  minLines: 1,
                  maxLines: 2,
                  decoration: const InputDecoration(labelText: 'Nota'),
                ),
                const SizedBox(height: 12),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Total',
                        style: Theme.of(context).textTheme.titleLarge),
                    Text(
                      Formatters.currency(total),
                      style: Theme.of(context)
                          .textTheme
                          .titleLarge
                          ?.copyWith(fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: lineas.isEmpty || guardando ? null : onGuardar,
                    icon: guardando
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.save_outlined),
                    label: Text(guardando ? 'Guardando...' : 'Guardar'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CotizacionTile extends StatelessWidget {
  const _CotizacionTile({required this.cotizacion, required this.onTap});

  final CotizacionResumen cotizacion;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: const CircleAvatar(child: Icon(Icons.request_quote)),
        title: Text(cotizacion.numero ?? 'Cotización'),
        subtitle: Text(
          [
            cotizacion.clienteNombre ?? 'Sin cliente',
            Formatters.date(cotizacion.fechaEmision),
          ].join(' · '),
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              Formatters.currency(cotizacion.total),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            _EstadoChip(estado: cotizacion.estado),
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String label;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: color),
            const SizedBox(height: 8),
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class _EstadoChip extends StatelessWidget {
  const _EstadoChip({required this.estado});

  final String estado;

  @override
  Widget build(BuildContext context) {
    final color = switch (estado) {
      'convertida' => AppColors.success,
      'anulada' => AppColors.danger,
      _ => AppColors.warning,
    };
    return Text(
      estado,
      style: TextStyle(
        color: color,
        fontSize: 12,
        fontWeight: FontWeight.w700,
      ),
    );
  }
}

class _LineaCotizacionUi {
  _LineaCotizacionUi({required this.producto});

  final Producto producto;
  double cantidad = 1;
  double descuento = 0;
}
