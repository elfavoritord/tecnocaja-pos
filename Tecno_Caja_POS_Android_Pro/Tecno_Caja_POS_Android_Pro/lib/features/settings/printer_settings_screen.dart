import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';
import 'package:unified_esc_pos_printer/unified_esc_pos_printer.dart';

import '../../data/printing/bluetooth_printer_service.dart';
import '../../data/printing/printer_profile.dart';
import '../../data/printing/unified_printer_service.dart';
import '../../data/repositories/configuracion_repository.dart';

class PrinterSettingsScreen extends ConsumerStatefulWidget {
  const PrinterSettingsScreen({super.key});

  @override
  ConsumerState<PrinterSettingsScreen> createState() =>
      _PrinterSettingsScreenState();
}

class _PrinterSettingsScreenState extends ConsumerState<PrinterSettingsScreen> {
  final _hostController = TextEditingController();
  final _portController = TextEditingController(text: '9100');
  List<BluetoothInfo> _bluetooth = const [];
  List<UsbPrinterDevice> _usb = const [];
  bool _searching = false;
  bool _working = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final profile = await ref.read(printerProfileRepositoryProvider).load();
      _hostController.text = profile.networkHost;
      _portController.text = profile.networkPort.toString();
      await _search();
    });
  }

  @override
  void dispose() {
    _hostController.dispose();
    _portController.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() => _searching = true);
    try {
      final profile = await ref.read(printerProfileRepositoryProvider).load();
      if (profile.transport == PrinterTransport.bluetooth) {
        final service = ref.read(bluetoothPrinterServiceProvider);
        if (!await service.permisosConcedidos()) {
          _message('Autoriza Bluetooth para buscar impresoras.');
          return;
        }
        if (!await service.bluetoothEncendido()) {
          _message('Activa Bluetooth en el dispositivo.');
          return;
        }
        _bluetooth = await service.buscarImpresoras();
      } else if (profile.transport == PrinterTransport.usb) {
        _usb = await ref.read(unifiedPrinterServiceProvider).scanUsb();
      }
    } catch (error) {
      _message('No se pudieron buscar impresoras: $error');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _selectBluetooth(BluetoothInfo printer) async {
    setState(() => _working = true);
    try {
      final ok = await ref
          .read(bluetoothPrinterServiceProvider)
          .conectar(printer.macAdress);
      if (!ok) throw Exception('la impresora rechazó la conexión');
      await ref.read(configuracionControllerProvider.notifier).actualizar(
          (c) => c.copyWith(impresoraPredeterminadaMac: printer.macAdress));
      await ref.read(printerProfileProvider.notifier).guardarCambios(
          (p) => p.copyWith(transport: PrinterTransport.bluetooth));
      _message('${printer.name} quedó como predeterminada.');
    } catch (error) {
      _message('No se pudo conectar: $error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _selectUsb(UsbPrinterDevice printer) async {
    setState(() => _working = true);
    try {
      await ref.read(unifiedPrinterServiceProvider).connectUsb(printer);
      ref.invalidate(printerProfileProvider);
      _message('${printer.name} conectada por USB.');
    } catch (error) {
      _message('No se pudo conectar por USB: $error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _connectNetwork() async {
    final port = int.tryParse(_portController.text) ?? 9100;
    setState(() => _working = true);
    try {
      await ref
          .read(unifiedPrinterServiceProvider)
          .connectNetwork(_hostController.text, port);
      ref.invalidate(printerProfileProvider);
      _message('Impresora de red conectada.');
    } catch (error) {
      _message('No se pudo conectar por red: $error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _test() async {
    setState(() => _working = true);
    try {
      await ref.read(unifiedPrinterServiceProvider).printTest();
      if (kIsWeb) {
        await ref.read(printerProfileProvider.notifier).guardarCambios(
              (profile) => profile.copyWith(systemPrinterConfigured: true),
            );
        _message(
            'Prueba ESC/POS enviada directamente a la impresora de la PC.');
      } else {
        _message('Prueba enviada correctamente.');
      }
    } catch (error) {
      _message('$error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  void _message(String text) {
    if (mounted) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(text)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final configAsync = ref.watch(configuracionControllerProvider);
    final profileAsync = ref.watch(printerProfileProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Impresoras'),
        actions: [
          IconButton(
            onPressed: _searching ? null : _search,
            tooltip: 'Buscar impresoras',
            icon: _searching
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
          ),
        ],
      ),
      body: configAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text('Error: $error')),
        data: (config) => profileAsync.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => Center(child: Text('Error: $error')),
          data: (profile) => ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text('Conexión', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              SegmentedButton<PrinterTransport>(
                segments: [
                  if (kIsWeb)
                    const ButtonSegment(
                      value: PrinterTransport.system,
                      icon: Icon(Icons.desktop_windows),
                      label: Text('PC'),
                    ),
                  if (!kIsWeb) ...const [
                    ButtonSegment(
                      value: PrinterTransport.bluetooth,
                      icon: Icon(Icons.bluetooth),
                      label: Text('Bluetooth'),
                    ),
                    ButtonSegment(
                      value: PrinterTransport.usb,
                      icon: Icon(Icons.usb),
                      label: Text('USB'),
                    ),
                    ButtonSegment(
                      value: PrinterTransport.network,
                      icon: Icon(Icons.wifi),
                      label: Text('Red'),
                    ),
                  ],
                ],
                selected: {profile.transport},
                onSelectionChanged: (value) async {
                  await ref
                      .read(printerProfileProvider.notifier)
                      .guardarCambios(
                          (p) => p.copyWith(transport: value.first));
                  await _search();
                },
              ),
              const SizedBox(height: 16),
              if (profile.transport == PrinterTransport.system)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.print),
                    title: const Text('Impresora instalada en esta PC'),
                    subtitle: Text(
                      profile.systemPrinterConfigured
                          ? 'Configurada para impresión térmica directa, sin PDF.'
                          : 'Inicia Tecno Caja Print Service y pulsa “Probar impresión directa”.',
                    ),
                    trailing: Icon(
                      profile.systemPrinterConfigured
                          ? Icons.check_circle
                          : Icons.info_outline,
                      color:
                          profile.systemPrinterConfigured ? Colors.green : null,
                    ),
                  ),
                ),
              if (profile.transport == PrinterTransport.bluetooth)
                _BluetoothList(
                  printers: _bluetooth,
                  selectedMac: config.impresoraPredeterminadaMac,
                  enabled: !_working,
                  onSelect: _selectBluetooth,
                ),
              if (profile.transport == PrinterTransport.usb)
                _UsbList(
                  printers: _usb,
                  selectedId: profile.usbIdentifier,
                  enabled: !_working,
                  onSelect: _selectUsb,
                ),
              if (profile.transport == PrinterTransport.network) ...[
                TextField(
                  controller: _hostController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Dirección IP',
                    hintText: '192.168.1.100',
                    prefixIcon: Icon(Icons.lan),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _portController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Puerto',
                    hintText: '9100',
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _working ? null : _connectNetwork,
                  icon: const Icon(Icons.link),
                  label: const Text('Conectar y guardar'),
                ),
              ],
              const Divider(height: 36),
              Text('Recibos térmicos',
                  style: Theme.of(context).textTheme.titleMedium),
              RadioGroup<int>(
                groupValue: config.impresoraAnchoMm,
                onChanged: (value) {
                  if (value != null) {
                    ref
                        .read(configuracionControllerProvider.notifier)
                        .actualizar((c) => c.copyWith(impresoraAnchoMm: value));
                  }
                },
                child: const Column(
                  children: [
                    RadioListTile(value: 58, title: Text('Papel de 58 mm')),
                    RadioListTile(value: 80, title: Text('Papel de 80 mm')),
                  ],
                ),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Imprimir al cobrar'),
                subtitle: const Text(
                    'Imprime el recibo automáticamente al finalizar'),
                value: config.imprimirAutomatico,
                onChanged: (value) => ref
                    .read(configuracionControllerProvider.notifier)
                    .actualizar((c) => c.copyWith(imprimirAutomatico: value)),
              ),
              const Divider(height: 36),
              Text('Impresora de etiquetas (TSPL)',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue:
                    '${profile.labelWidthMm}x${profile.labelHeightMm}',
                decoration:
                    const InputDecoration(labelText: 'Tamaño de etiqueta'),
                items: const [
                  DropdownMenuItem(value: '40x30', child: Text('40 × 30 mm')),
                  DropdownMenuItem(value: '50x30', child: Text('50 × 30 mm')),
                  DropdownMenuItem(value: '60x40', child: Text('60 × 40 mm')),
                ],
                onChanged: (value) {
                  final parts = value?.split('x');
                  if (parts?.length == 2) {
                    ref
                        .read(printerProfileProvider.notifier)
                        .guardarCambios((p) => p.copyWith(
                              labelWidthMm: int.parse(parts![0]),
                              labelHeightMm: int.parse(parts[1]),
                            ));
                  }
                },
              ),
              const SizedBox(height: 8),
              const Text(
                'Compatible con impresoras de etiquetas que aceptan comandos TSPL. '
                'Usa la conexión seleccionada arriba.',
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: _working ? null : _test,
                icon: const Icon(Icons.print),
                label: Text(
                  _working
                      ? 'Procesando…'
                      : kIsWeb
                          ? 'Probar impresión directa'
                          : 'Imprimir prueba',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BluetoothList extends StatelessWidget {
  const _BluetoothList({
    required this.printers,
    required this.selectedMac,
    required this.enabled,
    required this.onSelect,
  });
  final List<BluetoothInfo> printers;
  final String? selectedMac;
  final bool enabled;
  final ValueChanged<BluetoothInfo> onSelect;

  @override
  Widget build(BuildContext context) {
    if (printers.isEmpty) {
      return const Text(
          'No hay impresoras emparejadas. Empareja una desde Android y pulsa actualizar.');
    }
    return Column(
      children: printers
          .map((printer) => Card(
                child: ListTile(
                  leading: const Icon(Icons.print_outlined),
                  title: Text(printer.name),
                  subtitle: Text(printer.macAdress),
                  trailing: selectedMac == printer.macAdress
                      ? const Icon(Icons.check_circle, color: Colors.green)
                      : null,
                  onTap: enabled ? () => onSelect(printer) : null,
                ),
              ))
          .toList(),
    );
  }
}

class _UsbList extends StatelessWidget {
  const _UsbList({
    required this.printers,
    required this.selectedId,
    required this.enabled,
    required this.onSelect,
  });
  final List<UsbPrinterDevice> printers;
  final String? selectedId;
  final bool enabled;
  final ValueChanged<UsbPrinterDevice> onSelect;

  @override
  Widget build(BuildContext context) {
    if (printers.isEmpty) {
      return const Text(
          'Conecta la impresora con un adaptador USB OTG y pulsa actualizar.');
    }
    return Column(
      children: printers
          .map((printer) => Card(
                child: ListTile(
                  leading: const Icon(Icons.usb),
                  title: Text(printer.name),
                  subtitle: Text(printer.identifier),
                  trailing: selectedId == printer.identifier
                      ? const Icon(Icons.check_circle, color: Colors.green)
                      : null,
                  onTap: enabled ? () => onSelect(printer) : null,
                ),
              ))
          .toList(),
    );
  }
}
