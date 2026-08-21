import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/ncf.dart';
import '../../core/constants/permisos.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/printing/unified_printer_service.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/fiscal_repository.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../data/sync/sales_sync_service.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/venta.dart';
import 'carrito_controller.dart';

final ventasSuspendidasProvider =
    FutureProvider.family<List<Venta>, String>((ref, empresaId) {
  return ref.watch(ventaRepositoryProvider).ventasSuspendidas(empresaId);
});

/// Historial permanente de facturas de la empresa. No depende del turno que
/// esté abierto al entrar a esta pantalla.
final historialVentasEmpresaProvider =
    FutureProvider.family<List<Venta>, String>((ref, empresaId) async {
  return ref.watch(ventaRepositoryProvider).deEmpresa(empresaId);
});

class VentasSesionScreen extends ConsumerStatefulWidget {
  const VentasSesionScreen({super.key, required this.sesion});

  final SesionCaja sesion;

  @override
  ConsumerState<VentasSesionScreen> createState() => _VentasSesionScreenState();
}

class _VentasSesionScreenState extends ConsumerState<VentasSesionScreen>
    with SingleTickerProviderStateMixin {
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
        title: const Text('Ventas y facturas'),
        bottom: TabBar(
            controller: _tabController,
            tabs: const [Tab(text: 'En espera'), Tab(text: 'Historial')]),
      ),
      body: empresaId == null
          ? const SizedBox.shrink()
          : TabBarView(
              controller: _tabController,
              children: [
                _ListaSuspendidas(empresaId: empresaId),
                _ListaHistorial(empresaId: empresaId),
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

  Future<void> _recuperar(
      BuildContext context, WidgetRef ref, Venta venta) async {
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
        precioOverride: item.precioUnitario == producto.precioVenta
            ? null
            : item.precioUnitario,
        nota: item.nota,
      ));
    }
    if (lineas.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Los productos de esta venta ya no existen.')),
        );
      }
      return;
    }
    ref
        .read(carritoControllerProvider.notifier)
        .cargarLineas(lineas, clienteId: venta.clienteId);
    await ref.read(ventaRepositoryProvider).recuperar(venta);
    ref.invalidate(ventasSuspendidasProvider(venta.empresaId));
    if (context.mounted) Navigator.of(context).pop();
  }

  Future<void> _descartar(
      BuildContext context, WidgetRef ref, Venta venta) async {
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Descartar venta'),
        content: const Text('Esta venta en espera se eliminará. ¿Continuar?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancelar')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Descartar')),
        ],
      ),
    );
    if (confirmado != true) return;
    await ref.read(ventaRepositoryProvider).recuperar(venta);
    ref.invalidate(ventasSuspendidasProvider(venta.empresaId));
  }
}

class _ListaHistorial extends ConsumerWidget {
  const _ListaHistorial({required this.empresaId});
  final String empresaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ventasAsync = ref.watch(historialVentasEmpresaProvider(empresaId));
    return ventasAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Error: $e')),
      data: (ventas) {
        if (ventas.isEmpty) {
          return const Center(child: Text('Aún no hay facturas guardadas.'));
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
                  style: anulada
                      ? const TextStyle(decoration: TextDecoration.lineThrough)
                      : null,
                ),
                subtitle: Text(
                    '${Formatters.time(venta.creadoEn)} · ${anulada ? "Anulada" : "Completada"}'),
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
  late Venta _venta = widget.venta;

  @override
  Widget build(BuildContext context) {
    final permisos =
        ref.watch(permisosUsuarioActualProvider).valueOrNull ?? <Permiso>{};
    final venta = _venta;
    final necesitaFirma = (venta.encf?.isNotEmpty ?? false) &&
        ['PENDIENTE_FIRMA', 'FIRMA_FALLIDA', 'ENVIO_FALLIDO']
            .contains(venta.ecfEstado);
    final requiereNcf = (venta.tipoDocumento == TipoDocumentoVenta.facturaCreditoFiscal ||
            venta.tipoDocumento == TipoDocumentoVenta.facturaConsumo) &&
        ((venta.encf == null || venta.encf!.isEmpty) || necesitaFirma);

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
                  Text('Venta · ${Formatters.dateTime(venta.creadoEn)}',
                      style: Theme.of(context).textTheme.titleMedium),
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
                          trailing: Text(Formatters.currency(item.subtotalLinea,
                              currency: venta.moneda)),
                          subtitle: Text(
                              '${item.cantidad} x ${Formatters.currency(item.precioUnitario, currency: venta.moneda)}'),
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
                        Formatters.currency(venta.total,
                            currency: venta.moneda),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ],
                  ),
                  if (requiereNcf &&
                      permisos.contains(Permiso.accederECF) &&
                      venta.estado == EstadoVenta.completada) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        icon: const Icon(Icons.confirmation_number_outlined),
                        label: Text(necesitaFirma
                            ? 'Reintentar firma y envío DGII'
                            : 'Asignar NCF'),
                        onPressed: _procesando ? null : _asignarNcf,
                      ),
                    ),
                  ],
                  if ((venta.ecfTrackId?.isNotEmpty ?? false) &&
                      permisos.contains(Permiso.accederECF)) ...[
                    const SizedBox(height: 8),
                    Text('e-CF: ${venta.encf} · ${venta.ecfEstado ?? ''}',
                        style: Theme.of(context).textTheme.bodySmall),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        icon: const Icon(Icons.sync_outlined),
                        label: const Text('Consultar estado en DGII'),
                        onPressed:
                            _procesando ? null : _consultarEstadoDgii,
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      if (permisos.contains(Permiso.reimprimir))
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.print_outlined),
                            label: const Text('Reimprimir'),
                            onPressed:
                                _procesando ? null : () => _reimprimir(items),
                          ),
                        ),
                      if (permisos.contains(Permiso.anularVentas) &&
                          venta.estado == EstadoVenta.completada) ...[
                        const SizedBox(width: 8),
                        Expanded(
                          child: FilledButton.icon(
                            icon: const Icon(Icons.cancel_outlined),
                            label: const Text('Anular'),
                            style: FilledButton.styleFrom(
                                backgroundColor: Colors.red),
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
      await ref.read(unifiedPrinterServiceProvider).printSale(
            venta: _venta,
            items: items,
            empresa: empresa,
            nombreCajero: usuario.nombreCompleto,
          );
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Recibo reimpreso.')));
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  /// Reintenta la reserva de NCF para una venta que quedó cobrada sin
  /// comprobante (típicamente por falta de conexión en el momento del cobro
  /// -- ver `_asignarNcf` en `checkout_sheet.dart`, mismo flujo).
  Future<void> _asignarNcf() async {
    setState(() => _procesando = true);
    try {
      final empresa =
          await ref.read(empresaRepositoryProvider).porId(_venta.empresaId);
      final businessId = empresa?.remotoId;
      if (businessId == null || businessId.isEmpty) {
        throw const ValidationException(
            message: 'Necesitas estar sincronizado con la nube para emitir '
                'comprobantes fiscales.');
      }
      final sincronizada = await ref
          .read(salesSyncServiceProvider)
          .syncSale(businessId, _venta.id);
      if (!sincronizada) {
        throw const NetworkException(
            message: 'Necesitas conexión a internet para emitir el NCF.');
      }
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final config = ref.read(configuracionControllerProvider).valueOrNull;
      final branchId = sucursal?.remotoId ?? sucursal?.id ?? '';
      final ambiente = config?.fiscalAmbiente ?? 'certificacion';

      final fiscalSettings =
          await ref.read(fiscalRepositoryProvider).obtener(businessId);
      final usaECf = fiscalSettings?.eCfValidado ?? false;
      final ncfType = usaECf
          ? (_venta.tipoDocumento == TipoDocumentoVenta.facturaCreditoFiscal
              ? EcfType.e31
              : EcfType.e32)
          : (_venta.tipoDocumento == TipoDocumentoVenta.facturaCreditoFiscal
              ? NcfType.b01
              : NcfType.b02);

      // solicitarNcf es idempotente por venta (sale_uuid) -- si ya tenía
      // NCF/e-CF asignado, devuelve el mismo sin generar uno nuevo; esto
      // deja reintentar solo la firma/envío sin duplicar la reserva.
      final resultado = await ref.read(fiscalRepositoryProvider).solicitarNcf(
            businessId: businessId,
            branchId: branchId,
            saleId: _venta.id,
            ncfType: ncfType,
            ambiente: ambiente,
          );
      final encf = resultado['ncf']?.toString();
      var estado = resultado['estadoFiscal']?.toString();
      if (encf == null || encf.isEmpty) return;

      String? trackId;
      String? qrUrl;
      String? errorFirma;
      String mensaje = 'NCF asignado: $encf';
      if (estado == 'PENDIENTE_FIRMA') {
        try {
          final firmaResultado =
              await ref.read(fiscalRepositoryProvider).firmarYEnviar(
                    businessId: businessId,
                    branchId: branchId,
                    saleId: _venta.id,
                  );
          estado = firmaResultado['estadoFiscal']?.toString() ?? estado;
          trackId = firmaResultado['trackId']?.toString();
          qrUrl = firmaResultado['ecfQrUrl']?.toString();
          mensaje = 'e-CF $encf enviado a DGII.';
        } on AppException catch (e) {
          errorFirma = e.message;
          estado = 'FIRMA_FALLIDA';
          mensaje = 'NCF $encf asignado, pero DGII rechazó el envío: '
              '${e.message}';
        }
      }

      await ref.read(ventaRepositoryProvider).actualizarFiscal(
            _venta.id,
            encf: encf,
            ecfEstado: estado ?? 'ASIGNADO',
            ecfTrackId: trackId,
            ecfQrUrl: qrUrl,
            ecfError: errorFirma,
          );
      if (mounted) {
        setState(() => _venta = _venta.copyWith(
              encf: encf,
              ecfEstado: estado,
              ecfTrackId: trackId,
              ecfQrUrl: qrUrl,
              ecfError: errorFirma,
            ));
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(mensaje)));
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }

  /// Consulta el estado real de un e-CF ya enviado a DGII (TrackID) -- no
  /// re-firma ni reenvía, solo refleja la respuesta oficial más reciente.
  Future<void> _consultarEstadoDgii() async {
    setState(() => _procesando = true);
    try {
      final empresa =
          await ref.read(empresaRepositoryProvider).porId(_venta.empresaId);
      final businessId = empresa?.remotoId;
      if (businessId == null || businessId.isEmpty) {
        throw const ValidationException(
            message: 'Necesitas estar sincronizado con la nube.');
      }
      final resultado =
          await ref.read(fiscalRepositoryProvider).consultarEstadoEcf(
                businessId: businessId,
                saleId: _venta.id,
              );
      final estado = resultado['estadoFiscal']?.toString();
      await ref.read(ventaRepositoryProvider).actualizarFiscal(
            _venta.id,
            encf: _venta.encf ?? '',
            ecfEstado: estado ?? _venta.ecfEstado ?? '',
          );
      if (mounted) {
        setState(() => _venta = _venta.copyWith(ecfEstado: estado));
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Estado DGII: ${estado ?? 'sin cambios'}')));
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
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
          decoration:
              const InputDecoration(labelText: 'Motivo de la anulación'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancelar')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Anular venta')),
        ],
      ),
    );
    if (confirmado != true || !mounted) return;
    if (motivoCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Escribe un motivo para anular.')));
      return;
    }

    setState(() => _procesando = true);
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(ventaRepositoryProvider).anular(
            venta: _venta,
            motivo: motivoCtrl.text.trim(),
            dispositivoId: deviceId,
          );
      ref.invalidate(historialVentasEmpresaProvider(_venta.empresaId));
      ref.invalidate(sesionCajaActivaProvider);
      if (mounted) {
        Navigator.of(context).pop();
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _procesando = false);
    }
  }
}
