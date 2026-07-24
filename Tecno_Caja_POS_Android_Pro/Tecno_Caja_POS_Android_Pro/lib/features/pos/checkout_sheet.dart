import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/printing/bluetooth_printer_service.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/venta_repository.dart';
import '../../domain/calculo_venta.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/venta.dart';
import '../../widgets/loading_button.dart';
import 'carrito_controller.dart';
import 'ventas_sesion_screen.dart';

Future<Venta?> mostrarCheckout(BuildContext context, WidgetRef ref, SesionCaja sesion) {
  return showModalBottomSheet<Venta>(
    context: context,
    isScrollControlled: true,
    builder: (context) => _CheckoutSheet(sesion: sesion),
  );
}

class _CheckoutSheet extends ConsumerStatefulWidget {
  const _CheckoutSheet({required this.sesion});

  final SesionCaja sesion;

  @override
  ConsumerState<_CheckoutSheet> createState() => _CheckoutSheetState();
}

class _CheckoutSheetState extends ConsumerState<_CheckoutSheet> {
  String _metodoPago = MetodoPago.efectivo;
  final _montoRecibidoCtrl = TextEditingController();
  bool _cargando = false;
  bool? _imprimirOverride;

  @override
  void dispose() {
    _montoRecibidoCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final carrito = ref.watch(carritoControllerProvider);
    final config = ref.watch(configuracionControllerProvider).valueOrNull;
    final redondeoActivo = config?.redondeoActivo ?? false;
    final redondeoPaso = config?.redondeoPaso ?? 1.0;

    final calculo = CalculadoraVenta.calcular(
      items: carrito.lineas
          .map((l) => ItemCalculo(
                productoId: l.producto.id,
                cantidad: l.cantidad,
                precioUnitario: l.precioUnitario,
                tasaItbis: l.producto.tasaItbis,
                itbisIncluido: l.producto.itbisIncluido,
                descuentoMonto: l.descuentoMonto,
                descuentoPorcentaje: l.descuentoPorcentaje,
              ))
          .toList(),
      descuentoGlobalMonto: carrito.descuentoGlobalMonto,
      descuentoGlobalPorcentaje: carrito.descuentoGlobalPorcentaje,
      redondeoActivo: redondeoActivo,
      redondeoPaso: redondeoPaso,
    );

    final montoRecibido = double.tryParse(_montoRecibidoCtrl.text.replaceAll(',', '.'));
    final cambio = _metodoPago == MetodoPago.efectivo && montoRecibido != null
        ? CalculadoraVenta.calcularCambio(montoRecibido, calculo.total)
        : null;
    final requiereCliente = _metodoPago == MetodoPago.credito && carrito.clienteId == null;
    final imprimir = _imprimirOverride ?? (config?.imprimirAutomatico ?? false);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Cobrar', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 16),
              _filaTotal(context, 'Subtotal', calculo.subtotal),
              if (calculo.descuentoTotal > 0) _filaTotal(context, 'Descuento', -calculo.descuentoTotal),
              _filaTotal(context, 'ITBIS', calculo.itbis),
              if (calculo.redondeoAplicado != 0) _filaTotal(context, 'Redondeo', calculo.redondeoAplicado),
              const Divider(),
              _filaTotal(context, 'Total', calculo.total, destacado: true),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                children: [
                  _chipMetodo(MetodoPago.efectivo, 'Efectivo', Icons.payments_outlined),
                  _chipMetodo(MetodoPago.tarjeta, 'Tarjeta', Icons.credit_card),
                  _chipMetodo(MetodoPago.transferencia, 'Transferencia', Icons.swap_horiz),
                  _chipMetodo(MetodoPago.credito, 'Crédito', Icons.event_note),
                ],
              ),
              if (_metodoPago == MetodoPago.efectivo) ...[
                const SizedBox(height: 16),
                TextField(
                  controller: _montoRecibidoCtrl,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Monto recibido', prefixText: 'RD\$ '),
                  onChanged: (_) => setState(() {}),
                ),
                if (cambio != null) ...[
                  const SizedBox(height: 8),
                  Text('Devuelta: ${Formatters.currency(cambio)}', style: Theme.of(context).textTheme.titleMedium),
                ],
              ],
              if (requiereCliente) ...[
                const SizedBox(height: 12),
                Text(
                  'Selecciona un cliente en el carrito para vender a crédito.',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Imprimir recibo'),
                value: imprimir,
                onChanged: (v) => setState(() => _imprimirOverride = v),
              ),
              const SizedBox(height: 8),
              LoadingButton(
                label: imprimir ? 'Cobrar e imprimir' : 'Cobrar sin imprimir',
                isLoading: _cargando,
                onPressed: requiereCliente ? null : () => _confirmar(calculo, imprimir),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chipMetodo(String valor, String etiqueta, IconData icono) {
    return ChoiceChip(
      label: Text(etiqueta),
      avatar: Icon(icono, size: 18),
      selected: _metodoPago == valor,
      onSelected: (_) => setState(() => _metodoPago = valor),
    );
  }

  Widget _filaTotal(BuildContext context, String etiqueta, double monto, {bool destacado = false}) {
    final estilo = destacado ? Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold) : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(etiqueta, style: estilo),
          Text(Formatters.currency(monto), style: estilo),
        ],
      ),
    );
  }

  Future<void> _confirmar(ResultadoCalculoVenta calculo, bool imprimir) async {
    final auth = ref.read(authControllerProvider);
    final carrito = ref.read(carritoControllerProvider);
    final caja = await ref.read(cajaActivaProvider.future);
    if (!mounted || auth.usuario == null || caja == null) return;

    final montoRecibido =
        _metodoPago == MetodoPago.efectivo ? double.tryParse(_montoRecibidoCtrl.text.replaceAll(',', '.')) : null;

    if (_metodoPago == MetodoPago.efectivo && (montoRecibido == null || montoRecibido < calculo.total)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('El monto recibido es menor al total.')),
      );
      return;
    }

    setState(() => _cargando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final config = ref.read(configuracionControllerProvider).valueOrNull;

      final venta = await ref.read(ventaRepositoryProvider).registrarVenta(
            empresaId: auth.empresaId!,
            sucursalId: widget.sesion.sucursalId,
            cajaId: widget.sesion.cajaId,
            sesionCajaId: widget.sesion.id,
            usuarioId: auth.usuario!.id,
            clienteId: carrito.clienteId,
            metodoPago: _metodoPago,
            montoRecibido: montoRecibido,
            descuentoGlobalMonto: carrito.descuentoGlobalMonto,
            descuentoGlobalPorcentaje: carrito.descuentoGlobalPorcentaje,
            redondeoActivo: config?.redondeoActivo ?? false,
            redondeoPaso: config?.redondeoPaso ?? 1.0,
            dispositivoId: deviceId,
            lineas: carrito.lineas
                .map((l) => LineaVentaSolicitada(
                      productoId: l.producto.id,
                      nombreProducto: l.producto.nombre,
                      cantidad: l.cantidad,
                      precioUnitario: l.precioUnitario,
                      precioOriginal: l.precioOverride != null ? l.producto.precioVenta : null,
                      tasaItbis: l.producto.tasaItbis,
                      itbisIncluido: l.producto.itbisIncluido,
                      descuentoMonto: l.descuentoMonto,
                      descuentoPorcentaje: l.descuentoPorcentaje,
                      nota: l.nota,
                    ))
                .toList(),
          );

      ref.read(carritoControllerProvider.notifier).limpiar();
      ref.invalidate(sesionCajaActivaProvider);
      if (auth.empresaId != null) {
        ref.invalidate(ventasSuspendidasProvider(auth.empresaId!));
      }
      ref.invalidate(historialVentasSesionProvider(widget.sesion.id));

      if (imprimir) {
        try {
          final items = await ref.read(ventaRepositoryProvider).itemsDe(venta.id);
          final empresa = await ref.read(empresaRepositoryProvider).actual();
          if (empresa != null) {
            await ref.read(bluetoothPrinterServiceProvider).imprimirVenta(
                  venta: venta,
                  items: items,
                  empresa: empresa,
                  nombreCajero: auth.usuario!.nombreCompleto,
                  nombreCliente: carrito.nombreCliente,
                );
          }
        } on AppException catch (e) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Venta guardada, pero no se pudo imprimir: ${e.message}')),
            );
          }
        }
      }

      if (mounted) Navigator.of(context).pop(venta);
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }
}
