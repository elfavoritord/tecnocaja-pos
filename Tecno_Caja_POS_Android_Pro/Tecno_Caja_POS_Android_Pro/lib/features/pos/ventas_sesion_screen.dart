import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/permisos.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/printing/bluetooth_printer_service.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/venta.dart';
import 'carrito_controller.dart';

final ventasSuspendidasProvider = FutureProvider.family<List<Venta>, String>((ref, empresaId) {
  return ref.watch(ventaRepositoryProvider).ventasSuspendidas(empresaId);
});

/// `deSesion` trae todo lo que paso por esta sesion de caja, incluidas las
/// suspendidas -- se filtran aqui porque ya tienen su propia pestaña.
final historialVentasSesionProvider = FutureProvider.family<List<Venta>, String>((ref, sesionCajaId) async {
  final todas = await ref.watch(ventaRepositoryProvider).deSesion(sesionCajaId);
  return todas.where((v) => v.estado != EstadoVenta.suspendida).toList();
});

class VentasSesionScreen extends ConsumerStatefulWidget {
  const VentasSesionScreen({super.key, required this.sesion});

  final SesionCaja sesion;

  @override
  ConsumerState<VentasSesionScreen> createState() => _VentasSesionScreenState();
}

class _VentasSesionScreenState extends ConsumerState<VentasSesionScreen> with SingleTickerProviderStateMixin {
  late final _tabController = TabController(length: 2, vsync: this);

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final empresaId = ref.watch(authControllerProvider).empresaId;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ventas del turno'),
        bottom: TabBar(controller: _tabController, tabs: const [Tab(text: 'En espera'), Tab(text: 'Historial')]),
      ),
      body: empresaId == null
          ? const SizedBox.shrink()
          : TabBarView(
              controller: _tabController,
              children: [
                _ListaSuspendidas(empresaId: empresaId),
                _ListaHistorial(sesion: widget.sesion),
              ],
            ),
    );
  }
}

class _ListaSuspendidas extends ConsumerWidget {
  const _ListaSuspendidas({required this.empresaId});
  final String empresaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ventasAsync = ref.watch(ventasSuspendidasProvider(empresaId));
    return ventasAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Error: $e')),
      data: (ventas) {
        if (ventas.isEmpty) {
          return const Center(child: Text('No hay ventas en espera.'));
        }
        return ListView.separated(
          padding: const EdgeInsets.all(12),
          itemCount: ventas.length,
          separatorBuilder: (_, __) => const SizedBox(height: 8),
          itemBuilder: (context, index) {
            final venta = ventas[index];
            return Card(
              child: ListTile(
                leading: const Icon(Icons.pause_circle_outlined),
                title: Text(Formatters.currency(venta.total)),
                subtitle: Text(Formatters.dateTime(venta.creadoEn)),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'Descartar',
                  onPressed: () => _descartar(context, ref, venta),
                ),
                onTap: () => _recuperar(context, ref, venta),
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _recuperar(BuildContext context, WidgetRef ref, Venta venta) async {
    final items = await ref.read(ventaRepositoryProvider).itemsDe(venta.id);
    final productoRepo = ref.read(productoRepositoryProvider);
    final lineas = <LineaCarrito>[];
    for (final item in items) {
      final producto = await productoRepo.porId(item.productoId);
      if (producto == null) continue;
      lineas.add(LineaCarrito(
        producto: producto,
        cantidad: item.cantidad,
        descuentoMonto: item.descuentoMonto,
        descuentoPorcentaje: item.descuentoPorcentaje,
        precioOverride: item.precioUnitario == producto.precioVenta ? null : item.precioUnitario,
        nota: item.nota,
      ));
    }
    if (lineas.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Los productos de esta venta ya no existen.')),
        );
      }
      return;
    }
    ref.read(carritoControllerProvider.notifier).cargarLineas(lineas, clienteId: venta.clienteId);
    await ref.read(ventaRepositoryProvider).recuperar(venta);
    ref.invalidate(ventasSuspendidasProvider(venta.empresaId));
    if (context.mounted) Navigator.of(context).pop();
  }

  Future<void> _descartar(BuildContext context, WidgetRef ref, Venta venta) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Descartar venta'),
        content: const Text('Esta venta en espera se eliminará. ¿Continuar?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Descartar')),
        ],
      ),
    );
    if (confirmado != true) return;
    await ref.read(ventaRepositoryProvider).recuperar(venta);
    ref.invalidate(ventasSuspendidasProvider(venta.empresaId));
  }
}

class _ListaHistorial extends ConsumerWidget {
  const _ListaHistorial({required this.sesion});
  final SesionCaja sesion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ventasAsync = ref.watch(historialVentasSesionProvider(sesion.id));
    return ventasAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Error: $e')),
      data: (ventas) {
        if (ventas.isEmpty) {
          return const Center(child: Text('Aún no hay ventas en este turno.'));
        }
        return ListView.separated(
          padding: const EdgeInsets.all(12),
          itemCount: ventas.length,
          separatorBuilder: (_, __) => const SizedBox(height: 8),
          itemBuilder: (context, index) {
            final venta = ventas[index];
            final anulada = venta.estado == EstadoVenta.anulada;
            return Card(
              child: ListTile(
                leading: Icon(
                  anulada ? Icons.cancel_outlined : Icons.receipt_outlined,
                  color: anulada ? Colors.red : null,
                ),
                title: Text(
                  Formatters.currency(venta.total),
                  style: anulada ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
                ),
                subtitle: Text('${Formatters.time(venta.creadoEn)} · ${anulada ? "Anulada" : "Completada"}'),
                onTap: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  builder: (context) => _DetalleVentaSheet(venta: venta),
                ),
              ),
            );
          },
        );
      },
    );
  }
}

class _DetalleVentaSheet extends ConsumerStatefulWidget {
  const _DetalleVentaSheet({required this.venta});
  final Venta venta;

  @override
  ConsumerState<_DetalleVentaSheet> createState() => _DetalleVentaSheetState();
}

class _DetalleVentaSheetState extends ConsumerState<_DetalleVentaSheet> {
  bool _procesando = false;

  @override
  Widget build(BuildContext context) {
    final permisos = ref.watch(permisosUsuarioActualProvider).valueOrNull ?? <Permiso>{};
    final venta = widget.venta;

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      maxChildSize: 0.9,
      expand: false,
      builder: (context, scrollController) {
        return FutureBuilder<List<VentaItem>>(
          future: ref.read(ventaRepositoryProvider).itemsDe(venta.id),
          builder: (context, snapshot) {
            final items = snapshot.data ?? const <VentaItem>[];
            return Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Venta · ${Formatters.dateTime(venta.creadoEn)}', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 12),
                  Expanded(
                    child: ListView.builder(
                      controller: scrollController,
                      itemCount: items.length,
                      itemBuilder: (context, index) {
                        final item = items[index];
                        return ListTile(
                          dense: true,
                          title: Text(item.nombreProductoSnapshot),
                          trailing: Text(Formatters.currency(item.subtotalLinea, currency: venta.moneda)),
                          subtitle: Text('${item.cantidad} x ${Formatters.currency(item.precioUnitario, currency: venta.moneda)}'),
                        );
                      },
                    ),
                  ),
                  const Divider(),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Total'),
                      Text(
                        Formatters.currency(venta.total, currency: venta.moneda),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      if (permisos.contains(Permiso.reimprimir))
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.print_outlined),
                            label: const Text('Reimprimir'),
                            onPressed: _procesando ? null : () => _reimprimir(items),
                          ),
                        ),
                      if (permisos.contains(Permiso.anularVentas) && venta.estado == EstadoVenta.completada) ...[
                        const SizedBox(width: 8),
                        Expanded(
                          child: FilledButton.icon(
                            icon: const Icon(Icons.cancel_outlined),
                            label: const Text('Anular'),
                            style: FilledButton.styleFrom(backgroundColor: Colors.red),
                            onPressed: _procesando ? null : _anular,
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _reimprimir(List<VentaItem> items) async {
    setState(() => _procesando = true);
    try {
      final empresa = await ref.read(empresaRepositoryProvider).actual();
      final usuario = ref.read(authControllerProvider).usuario;
      if (empresa == null || usuario == null) return;
      await ref.read(bluetoothPrinterServiceProvider).imprimirVenta(
            venta: widget.venta,
            items: items,
            empresa: empresa,
            nombreCajero: usuario.nombreCompleto,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Recibo reimpreso.')));
      }
    } on AppException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  Future<void> _anular() async {
    final motivoCtrl = TextEditingController();
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Anular venta'),
        content: TextField(
          controller: motivoCtrl,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Motivo de la anulación'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Anular venta')),
        ],
      ),
    );
    if (confirmado != true || !mounted) return;
    if (motivoCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Escribe un motivo para anular.')));
      return;
    }

    setState(() => _procesando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(ventaRepositoryProvider).anular(
            venta: widget.venta,
            motivo: motivoCtrl.text.trim(),
            dispositivoId: deviceId,
          );
      ref.invalidate(historialVentasSesionProvider(widget.venta.sesionCajaId ?? ''));
      ref.invalidate(sesionCajaActivaProvider);
      if (mounted) Navigator.of(context).pop();
    } on AppException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }
}
