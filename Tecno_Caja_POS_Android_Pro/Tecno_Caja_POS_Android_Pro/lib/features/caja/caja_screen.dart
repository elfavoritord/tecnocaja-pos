import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/caja_repository.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../widgets/loading_button.dart';

class CajaScreen extends ConsumerWidget {
  const CajaScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sesionAsync = ref.watch(sesionCajaActivaProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Caja')),
      body: sesionAsync.when(
        data: (sesion) => sesion == null
            ? const _AbrirCajaForm()
            : _SesionAbiertaView(sesion: sesion),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Error: $e')),
      ),
    );
  }
}

class _AbrirCajaForm extends ConsumerStatefulWidget {
  const _AbrirCajaForm();

  @override
  ConsumerState<_AbrirCajaForm> createState() => _AbrirCajaFormState();
}

class _AbrirCajaFormState extends ConsumerState<_AbrirCajaForm> {
  final _montoCtrl = TextEditingController(text: '0');
  bool _cargando = false;

  @override
  void dispose() {
    _montoCtrl.dispose();
    super.dispose();
  }

  Future<void> _abrir() async {
    final auth = ref.read(authControllerProvider);
    final caja = await ref.read(cajaActivaProvider.future);
    final sucursal = await ref.read(sucursalActivaProvider.future);
    if (auth.usuario == null || caja == null || sucursal == null) return;

    final monto = double.tryParse(_montoCtrl.text.replaceAll(',', '.')) ?? 0;
    setState(() => _cargando = true);
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final registerId = caja.remotoId ?? caja.id;
      await ref.read(cloudFunctionsServiceProvider).acquireCashRegister(
            registerId: registerId,
            deviceId: deviceId,
            openingAmount: monto,
          );
      try {
        await ref.read(cajaRepositoryProvider).abrir(
              empresaId: auth.empresaId!,
              sucursalId: sucursal.id,
              cajaId: caja.id,
              usuarioId: auth.usuario!.id,
              montoApertura: monto,
              dispositivoId: deviceId,
            );
      } catch (_) {
        await ref
            .read(cloudFunctionsServiceProvider)
            .releaseCashRegister(registerId);
        rethrow;
      }
      ref.invalidate(sesionCajaActivaProvider);
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.point_of_sale, size: 56),
              const SizedBox(height: 12),
              Text('La caja está cerrada',
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(
                'Registra el monto inicial para abrir el turno',
                style: Theme.of(context).textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _montoCtrl,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall,
                decoration: const InputDecoration(prefixText: 'RD\$ '),
              ),
              const SizedBox(height: 20),
              LoadingButton(
                  label: 'Abrir caja', isLoading: _cargando, onPressed: _abrir),
            ],
          ),
        ),
      ),
    );
  }
}

class _SesionAbiertaView extends ConsumerWidget {
  const _SesionAbiertaView({required this.sesion});

  final SesionCaja sesion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<ResumenCierreCaja>(
      future: ref.read(cajaRepositoryProvider).calcularResumen(sesion),
      builder: (context, snapshot) {
        final resumen = snapshot.data;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              color:
                  Theme.of(context).colorScheme.primary.withValues(alpha: 0.08),
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.lock_open, color: Colors.green),
                        const SizedBox(width: 8),
                        Text('Turno abierto',
                            style: Theme.of(context).textTheme.titleMedium),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text('Desde ${Formatters.dateTime(sesion.abiertaEn)}',
                        style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (resumen == null)
              const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()))
            else ...[
              _filaResumen(context, 'Monto de apertura', resumen.montoApertura),
              _filaResumen(
                  context, 'Ventas en efectivo', resumen.totalVentasEfectivo),
              _filaResumen(
                  context, 'Ventas con tarjeta', resumen.totalVentasTarjeta),
              _filaResumen(context, 'Ventas por transferencia',
                  resumen.totalVentasTransferencia),
              _filaResumen(
                  context, 'Ventas a crédito', resumen.totalVentasCredito),
              _filaResumen(context, 'Entradas manuales', resumen.totalEntradas),
              _filaResumen(context, 'Salidas / gastos',
                  -(resumen.totalSalidas + resumen.totalGastos)),
              const Divider(height: 32),
              _filaResumen(
                  context, 'Efectivo esperado en caja', resumen.montoEsperado,
                  destacado: true),
              const SizedBox(height: 8),
              Text('${resumen.cantidadVentas} ventas en este turno',
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 24),
              FilledButton.icon(
                icon: const Icon(Icons.lock_outline),
                label: const Text('Cerrar caja'),
                onPressed: () => _abrirDialogoCierre(
                    context, ref, sesion, resumen.montoEsperado),
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _filaResumen(BuildContext context, String etiqueta, double monto,
      {bool destacado = false}) {
    final estilo = destacado
        ? Theme.of(context)
            .textTheme
            .titleMedium
            ?.copyWith(fontWeight: FontWeight.bold)
        : Theme.of(context).textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(etiqueta, style: estilo),
          Text(Formatters.currency(monto), style: estilo),
        ],
      ),
    );
  }

  Future<void> _abrirDialogoCierre(BuildContext context, WidgetRef ref,
      SesionCaja sesion, double montoEsperado) async {
    final controller =
        TextEditingController(text: montoEsperado.toStringAsFixed(2));
    final confirmado = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Cerrar caja'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('¿Cuánto efectivo contaste físicamente en la caja?'),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              autofocus: true,
              decoration: const InputDecoration(prefixText: 'RD\$ '),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancelar')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Confirmar cierre')),
        ],
      ),
    );
    if (confirmado != true) return;

    final montoContado =
        double.tryParse(controller.text.replaceAll(',', '.')) ?? montoEsperado;
    final usuarioId = ref.read(authControllerProvider).usuario?.id;
    if (usuarioId == null) return;
    final caja = await ref.read(cajaActivaProvider.future);
    if (caja == null) return;

    late final SesionCaja cerrada;
    try {
      await ref
          .read(cloudFunctionsServiceProvider)
          .releaseCashRegister(caja.remotoId ?? caja.id);
      cerrada = await ref.read(cajaRepositoryProvider).cerrar(
            sesion: sesion,
            usuarioCierreId: usuarioId,
            montoContado: montoContado,
          );
    } on AppException catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message)),
        );
      }
      return;
    }
    ref.invalidate(sesionCajaActivaProvider);

    if (!context.mounted) return;
    final diferencia = cerrada.diferencia ?? 0;
    unawaited(showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Caja cerrada'),
        content: Text(
          diferencia == 0
              ? 'La caja cuadró exactamente.'
              : diferencia > 0
                  ? 'Sobrante de ${Formatters.currency(diferencia)}.'
                  : 'Faltante de ${Formatters.currency(diferencia.abs())}.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cerrar')),
        ],
      ),
    ));
  }
}
