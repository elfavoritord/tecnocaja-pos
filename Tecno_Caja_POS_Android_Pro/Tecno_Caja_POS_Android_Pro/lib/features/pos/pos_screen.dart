import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/producto_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../data/sync/catalog_sync_repository.dart';
import '../../data/sync/cloud_business_sync_repository.dart';
import '../../data/sync/vinculacion_repository.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/sesion_caja.dart';
import '../productos/producto_form_screen.dart';
import 'barcode_scanner_sheet.dart';
import 'carrito_controller.dart';
import 'checkout_sheet.dart';
import 'ventas_sesion_screen.dart';
import 'widgets/selector_cliente.dart';

class PosScreen extends ConsumerWidget {
  const PosScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sesionAsync = ref.watch(sesionCajaActivaProvider);
    final sesion = sesionAsync.valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Vender'),
        actions: sesion == null
            ? null
            : [
                IconButton(
                  icon: const Icon(Icons.qr_code_scanner),
                  tooltip: 'Escanear código',
                  onPressed: () => _escanearYAgregar(context, ref),
                ),
                _BotonVentasSesion(sesion: sesion),
              ],
      ),
      body: sesionAsync.when(
        data: (sesion) => sesion == null
            ? const _CajaCerradaAviso()
            : _PosContenido(sesion: sesion),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Error: $e')),
      ),
    );
  }

  Future<void> _escanearYAgregar(BuildContext context, WidgetRef ref) async {
    final config = ref.read(configuracionControllerProvider).valueOrNull;
    final codigo = await mostrarEscanerCodigoBarras(context,
        vibrarActivo: config?.vibrarScanner ?? true);
    if (codigo == null || !context.mounted) return;

    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    final producto = await ref
        .read(productoRepositoryProvider)
        .porCodigoBarras(empresaId, codigo);
    if (producto != null) {
      ref.read(carritoControllerProvider.notifier).agregarProducto(producto);
      return;
    }

    if (!context.mounted) return;
    final crear = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Producto no encontrado'),
        content: Text(
            'No hay ningún producto con el código "$codigo". ¿Deseas crearlo?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancelar')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Crear producto')),
        ],
      ),
    );
    if (crear == true && context.mounted) {
      await Navigator.of(context).push<bool>(
        MaterialPageRoute(
            builder: (_) => ProductoFormScreen(codigoBarrasInicial: codigo)),
      );
    }
  }
}

class _BotonVentasSesion extends ConsumerWidget {
  const _BotonVentasSesion({required this.sesion});
  final SesionCaja sesion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final empresaId = ref.watch(authControllerProvider).empresaId;
    final cantidad = empresaId == null
        ? 0
        : ref.watch(ventasSuspendidasProvider(empresaId)).valueOrNull?.length ??
            0;

    return IconButton(
      tooltip: 'Ventas del turno',
      icon: Badge(
        label: Text('$cantidad'),
        isLabelVisible: cantidad > 0,
        child: const Icon(Icons.receipt_long_outlined),
      ),
      onPressed: () => Navigator.of(context).push<void>(
        MaterialPageRoute(builder: (_) => VentasSesionScreen(sesion: sesion)),
      ),
    );
  }
}

class _CajaCerradaAviso extends StatelessWidget {
  const _CajaCerradaAviso();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.point_of_sale, size: 64),
            const SizedBox(height: 12),
            Text('Abre la caja para empezar a vender',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 16),
            FilledButton(
                onPressed: () => context.push('/caja'),
                child: const Text('Ir a Caja')),
          ],
        ),
      ),
    );
  }
}

class _PosContenido extends ConsumerStatefulWidget {
  const _PosContenido({required this.sesion});
  final SesionCaja sesion;

  @override
  ConsumerState<_PosContenido> createState() => _PosContenidoState();
}

class _PosContenidoState extends ConsumerState<_PosContenido> {
  final _busquedaCtrl = TextEditingController();
  List<Producto> _productos = [];
  bool _cargando = true;
  bool _recuperandoCatalogo = false;
  String? _errorCatalogo;
  Timer? _autoSyncTimer;

  @override
  void initState() {
    super.initState();
    _cargar('');
    _autoSyncTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted && _productos.isEmpty && !_cargando) {
        _cargar('');
      }
    });
  }

  @override
  void dispose() {
    _busquedaCtrl.dispose();
    _autoSyncTimer?.cancel();
    super.dispose();
  }

  Future<void> _cargar(String termino) async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargando = true);
    final repo = ref.read(productoRepositoryProvider);
    var productos = termino.isEmpty
        ? await repo.deEmpresa(empresaId)
        : await repo.buscar(empresaId, termino);
    if (productos.isEmpty && termino.isEmpty && !_recuperandoCatalogo) {
      productos = await _recuperarCatalogo(empresaId, repo);
    }
    if (mounted) {
      setState(() {
        _productos = productos;
        _cargando = false;
      });
      if (productos.isNotEmpty) {
        _autoSyncTimer?.cancel();
      }
    }
  }

  Future<List<Producto>> _recuperarCatalogo(
    String empresaId,
    ProductoRepository repository,
  ) async {
    _recuperandoCatalogo = true;
    _errorCatalogo = null;
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final empresa =
          await ref.read(empresaRepositoryProvider).porId(empresaId);
      final usuario = ref.read(authControllerProvider).usuario;
      final remoteBusinessId = empresa?.remotoId;
      if (remoteBusinessId != null &&
          remoteBusinessId.isNotEmpty &&
          usuario != null) {
        try {
          final bootstrap = await ref
              .read(cloudFunctionsServiceProvider)
              .getMyCompanyBootstrap();
          await ref
              .read(vinculacionRepositoryProvider)
              .importarProductosDesdeBootstrap(
                bootstrap['products'] as List? ?? const [],
                localBusinessId: empresaId,
                deviceId: deviceId,
              );
          await ref.read(cloudBusinessSyncRepositoryProvider).pullInitial(
                localBusinessId: empresaId,
                remoteBusinessId: remoteBusinessId,
                localUserId: usuario.id,
                deviceId: deviceId,
              );
        } catch (_) {
          // El POS vinculado queda como segundo origen del mismo catálogo.
        }
      }
      var products = await repository.deEmpresa(empresaId);
      if (products.isNotEmpty) return products;

      final branch = await ref.read(sucursalActivaProvider.future);
      if (branch != null && branch.remotoId?.isNotEmpty == true) {
        await ref.read(catalogSyncRepositoryProvider).sincronizarTodo(
              empresaId: empresaId,
              sucursal: branch,
              dispositivoId: deviceId,
            );
      }
      products = await repository.deEmpresa(empresaId);
      return products;
    } catch (error) {
      _errorCatalogo = error.toString();
      return repository.deEmpresa(empresaId);
    } finally {
      _recuperandoCatalogo = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final buscador = Padding(
      padding: const EdgeInsets.all(12),
      child: TextField(
        controller: _busquedaCtrl,
        decoration: InputDecoration(
          prefixIcon: const Icon(Icons.search),
          hintText: 'Buscar producto por nombre, SKU o código',
          suffixIcon: _busquedaCtrl.text.isEmpty
              ? null
              : IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () {
                    _busquedaCtrl.clear();
                    _cargar('');
                  },
                ),
        ),
        onChanged: _cargar,
      ),
    );

    final grid = _cargando
        ? const Center(child: CircularProgressIndicator())
        : _productos.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('No hay productos disponibles'),
                      if (_errorCatalogo != null) ...[
                        const SizedBox(height: 8),
                        const Text(
                          'Esperando el catálogo de la empresa. '
                          'Se actualizará automáticamente.',
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ],
                  ),
                ),
              )
            : GridView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 180,
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  childAspectRatio: 0.85,
                ),
                itemCount: _productos.length,
                itemBuilder: (context, index) {
                  final producto = _productos[index];
                  return _TarjetaProducto(
                    producto: producto,
                    onTap: () => ref
                        .read(carritoControllerProvider.notifier)
                        .agregarProducto(producto),
                  );
                },
              );

    final panelProductos = Column(children: [buscador, Expanded(child: grid)]);

    return LayoutBuilder(
      builder: (context, constraints) {
        final esTablet = constraints.maxWidth > 700;
        if (esTablet) {
          return Row(
            children: [
              Expanded(child: panelProductos),
              SizedBox(
                width: 380,
                child: _PanelCarrito(sesion: widget.sesion),
              ),
            ],
          );
        }
        return Stack(
          children: [
            Padding(
                padding: const EdgeInsets.only(bottom: 76),
                child: panelProductos),
            Align(
                alignment: Alignment.bottomCenter,
                child: _BarraCarritoCompacta(sesion: widget.sesion)),
          ],
        );
      },
    );
  }
}

class _TarjetaProducto extends StatelessWidget {
  const _TarjetaProducto({required this.producto, required this.onTap});
  final Producto producto;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // TODO(inventario-ui): mostrar stock por sucursal y bloquear el tap si
    // esta agotado -- requiere resolver InventarioSucursal por producto en
    // lote (no uno a uno por card). Ver Fase 8.
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                height: 56,
                width: double.infinity,
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(Icons.inventory_2_outlined,
                    color: AppColors.primaryDark),
              ),
              const SizedBox(height: 8),
              Text(producto.nombre,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 4),
              Text(
                Formatters.currency(producto.precioVenta),
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: AppColors.primaryDark, fontWeight: FontWeight.bold),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BarraCarritoCompacta extends ConsumerWidget {
  const _BarraCarritoCompacta({required this.sesion});
  final SesionCaja sesion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final carrito = ref.watch(carritoControllerProvider);
    if (carrito.estaVacio) return const SizedBox.shrink();

    return Material(
      elevation: 8,
      child: InkWell(
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (context) => SizedBox(
            height: MediaQuery.of(context).size.height * 0.8,
            child: _PanelCarrito(sesion: sesion),
          ),
        ),
        child: Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          color: AppColors.primary,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('${carrito.cantidadUnidades.toStringAsFixed(0)} artículos',
                  style: const TextStyle(color: Colors.white)),
              Text(
                Formatters.currency(carrito.subtotalBruto),
                style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 16),
              ),
              const Icon(Icons.shopping_cart, color: Colors.white),
            ],
          ),
        ),
      ),
    );
  }
}

class _PanelCarrito extends ConsumerWidget {
  const _PanelCarrito({required this.sesion});
  final SesionCaja sesion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final carrito = ref.watch(carritoControllerProvider);
    final notifier = ref.read(carritoControllerProvider.notifier);
    final empresaId = ref.watch(authControllerProvider).empresaId;

    return Container(
      decoration: BoxDecoration(
          border:
              Border(left: BorderSide(color: Theme.of(context).dividerColor))),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Carrito', style: Theme.of(context).textTheme.titleMedium),
                if (carrito.lineas.isNotEmpty) ...[
                  IconButton(
                    icon: const Icon(Icons.pause_circle_outlined),
                    tooltip: 'Suspender venta',
                    onPressed: () => _suspender(context, ref, sesion),
                  ),
                  TextButton(
                      onPressed: notifier.limpiar, child: const Text('Vaciar')),
                ],
              ],
            ),
          ),
          ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(carrito.nombreCliente ?? 'Venta anónima'),
            trailing: const Icon(Icons.chevron_right),
            onTap: empresaId == null
                ? null
                : () async {
                    final cliente =
                        await mostrarSelectorCliente(context, empresaId);
                    if (cliente != null)
                      notifier.establecerCliente(cliente.id, cliente.nombre);
                  },
          ),
          const Divider(height: 1),
          Expanded(
            child: carrito.estaVacio
                ? const Center(child: Text('Agrega productos para empezar'))
                : ListView.separated(
                    padding: const EdgeInsets.all(12),
                    itemCount: carrito.lineas.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, index) {
                      final linea = carrito.lineas[index];
                      return Card(
                        margin: EdgeInsets.zero,
                        child: Padding(
                          padding: const EdgeInsets.all(10),
                          child: Row(
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(linea.producto.nombre,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis),
                                    Text(
                                      Formatters.currency(linea.precioUnitario),
                                      style:
                                          Theme.of(context).textTheme.bodySmall,
                                    ),
                                  ],
                                ),
                              ),
                              IconButton(
                                icon: const Icon(Icons.remove_circle_outline),
                                onPressed: () => notifier.cambiarCantidad(
                                    linea.producto.id, linea.cantidad - 1),
                              ),
                              Text(linea.cantidad.toStringAsFixed(
                                  linea.cantidad.truncateToDouble() ==
                                          linea.cantidad
                                      ? 0
                                      : 2)),
                              IconButton(
                                icon: const Icon(Icons.add_circle_outline),
                                onPressed: () => notifier.cambiarCantidad(
                                    linea.producto.id, linea.cantidad + 1),
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
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Total',
                        style: Theme.of(context).textTheme.titleMedium),
                    Text(
                      Formatters.currency(carrito.subtotalBruto),
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
                  child: FilledButton(
                    onPressed: carrito.estaVacio
                        ? null
                        : () => mostrarCheckout(context, ref, sesion),
                    child: const Text('Cobrar'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _suspender(
      BuildContext context, WidgetRef ref, SesionCaja sesion) async {
    final carrito = ref.read(carritoControllerProvider);
    if (carrito.estaVacio) return;
    final auth = ref.read(authControllerProvider);
    if (auth.usuario == null || auth.empresaId == null) return;

    final deviceId =
        await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    await ref.read(ventaRepositoryProvider).suspender(
          empresaId: auth.empresaId!,
          sucursalId: sesion.sucursalId,
          cajaId: sesion.cajaId,
          sesionCajaId: sesion.id,
          usuarioId: auth.usuario!.id,
          clienteId: carrito.clienteId,
          dispositivoId: deviceId,
          lineas: carrito.lineas
              .map((l) => LineaVentaSolicitada(
                    productoId: l.producto.id,
                    nombreProducto: l.producto.nombre,
                    cantidad: l.cantidad,
                    precioUnitario: l.precioUnitario,
                    tasaItbis: l.producto.tasaItbis,
                    itbisIncluido: l.producto.itbisIncluido,
                    descuentoMonto: l.descuentoMonto,
                    descuentoPorcentaje: l.descuentoPorcentaje,
                    nota: l.nota,
                  ))
              .toList(),
        );

    ref.read(carritoControllerProvider.notifier).limpiar();
    ref.invalidate(ventasSuspendidasProvider(auth.empresaId!));
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Venta suspendida.')));
    }
  }
}
