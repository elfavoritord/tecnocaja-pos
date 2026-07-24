import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';

import '../../core/errors/app_exception.dart';
import '../../data/printing/bluetooth_printer_service.dart';
import '../../data/repositories/configuracion_repository.dart';

class PrinterSettingsScreen extends ConsumerStatefulWidget {
  const PrinterSettingsScreen({super.key});

  @override
  ConsumerState<PrinterSettingsScreen> createState() => _PrinterSettingsScreenState();
}

class _PrinterSettingsScreenState extends ConsumerState<PrinterSettingsScreen> {
  List<BluetoothInfo> _impresoras = [];
  bool _buscando = false;
  bool _probando = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _buscar());
  }

  Future<void> _buscar() async {
    setState(() => _buscando = true);
    try {
      final servicio = ref.read(bluetoothPrinterServiceProvider);
      final permisos = await servicio.permisosConcedidos();
      if (!permisos) {
        _avisar('Se necesita permiso de Bluetooth para buscar impresoras.');
        return;
      }
      final encendido = await servicio.bluetoothEncendido();
      if (!encendido) {
        _avisar('Activa el Bluetooth del dispositivo.');
        return;
      }
      final impresoras = await servicio.buscarImpresoras();
      if (mounted) setState(() => _impresoras = impresoras);
    } finally {
      if (mounted) setState(() => _buscando = false);
    }
  }

  Future<void> _conectar(BluetoothInfo impresora) async {
    final servicio = ref.read(bluetoothPrinterServiceProvider);
    final ok = await servicio.conectar(impresora.macAdress);
    if (!mounted) return;
    if (!ok) {
      _avisar('No se pudo conectar con ${impresora.name}.');
      return;
    }
    await ref
        .read(configuracionControllerProvider.notifier)
        .actualizar((c) => c.copyWith(impresoraPredeterminadaMac: impresora.macAdress));
    _avisar('${impresora.name} conectada y guardada como predeterminada.');
  }

  Future<void> _olvidar() async {
    await ref.read(bluetoothPrinterServiceProvider).desconectar();
    await ref.read(configuracionControllerProvider.notifier).actualizar((c) => c.copyWith(impresoraPredeterminadaMac: ''));
    _avisar('Impresora desvinculada.');
  }

  Future<void> _probar() async {
    final config = ref.read(configuracionControllerProvider).valueOrNull;
    setState(() => _probando = true);
    try {
      await ref.read(bluetoothPrinterServiceProvider).imprimirPrueba(config?.impresoraAnchoMm ?? 58);
      _avisar('Prueba enviada a la impresora.');
    } on AppException catch (e) {
      _avisar(e.message);
    } finally {
      if (mounted) setState(() => _probando = false);
    }
  }

  void _avisar(String mensaje) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(mensaje)));
  }

  @override
  Widget build(BuildContext context) {
    final configAsync = ref.watch(configuracionControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Impresora'),
        actions: [
          IconButton(
            icon: _buscando
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
            tooltip: 'Buscar de nuevo',
            onPressed: _buscando ? null : _buscar,
          ),
        ],
      ),
      body: configAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Error: $e')),
        data: (config) {
          final macGuardada = config.impresoraPredeterminadaMac;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text('Impresoras emparejadas', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                'Empareja la impresora desde los ajustes de Bluetooth de Android y luego búscala aquí.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              if (_impresoras.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Text('No se encontraron impresoras emparejadas.'),
                )
              else
                ..._impresoras.map((impresora) {
                  final esPredeterminada = macGuardada != null && macGuardada == impresora.macAdress;
                  return Card(
                    child: ListTile(
                      leading: Icon(
                        Icons.print_outlined,
                        color: esPredeterminada ? Theme.of(context).colorScheme.primary : null,
                      ),
                      title: Text(impresora.name),
                      subtitle: Text(impresora.macAdress),
                      trailing: esPredeterminada ? const Icon(Icons.check_circle, color: Colors.green) : null,
                      onTap: () => _conectar(impresora),
                    ),
                  );
                }),
              if (macGuardada != null && macGuardada.isNotEmpty) ...[
                const SizedBox(height: 4),
                TextButton.icon(
                  icon: const Icon(Icons.link_off),
                  label: const Text('Olvidar impresora predeterminada'),
                  onPressed: _olvidar,
                ),
              ],
              const Divider(height: 32),
              Text('Papel', style: Theme.of(context).textTheme.titleMedium),
              RadioGroup<int>(
                groupValue: config.impresoraAnchoMm,
                onChanged: (v) {
                  if (v != null) {
                    ref.read(configuracionControllerProvider.notifier).actualizar((c) => c.copyWith(impresoraAnchoMm: v));
                  }
                },
                child: const Column(
                  children: [
                    RadioListTile<int>(title: Text('58 mm'), value: 58),
                    RadioListTile<int>(title: Text('80 mm'), value: 80),
                  ],
                ),
              ),
              SwitchListTile(
                title: const Text('Imprimir automáticamente al cobrar'),
                subtitle: const Text('También puedes decidirlo caso por caso al cobrar'),
                value: config.imprimirAutomatico,
                onChanged: (v) =>
                    ref.read(configuracionControllerProvider.notifier).actualizar((c) => c.copyWith(imprimirAutomatico: v)),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                icon: _probando
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.receipt_long),
                label: Text(_probando ? 'Imprimiendo…' : 'Imprimir prueba'),
                onPressed: (macGuardada == null || macGuardada.isEmpty || _probando) ? null : _probar,
              ),
            ],
          );
        },
      ),
    );
  }
}
