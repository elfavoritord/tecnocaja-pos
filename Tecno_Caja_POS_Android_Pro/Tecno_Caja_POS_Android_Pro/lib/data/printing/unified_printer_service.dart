import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:unified_esc_pos_printer/unified_esc_pos_printer.dart'
    as unified;

import '../../core/errors/app_exception.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/venta.dart';
import '../repositories/configuracion_repository.dart';
import 'bluetooth_printer_service.dart';
import 'label_formatter.dart';
import 'local_print_bridge.dart';
import 'printer_profile.dart';
import 'receipt_formatter.dart';
import 'web_printer_service.dart';

class UnifiedPrinterService {
  UnifiedPrinterService(
    this._profileRepository,
    this._configRepository,
    this._bluetooth,
    this._webPrinter,
    this._localBridge,
  );

  final PrinterProfileRepository _profileRepository;
  final ConfiguracionRepository _configRepository;
  final BluetoothPrinterService _bluetooth;
  final WebPrinterService _webPrinter;
  final LocalPrintBridge _localBridge;
  // PrinterManager construye conectores USB que consultan dart:io Platform
  // en su constructor. En Web esa API lanza Unsupported operation incluso
  // antes de intentar imprimir, por eso jamás se instancia en Chrome.
  final unified.PrinterManager? _manager =
      kIsWeb ? null : unified.PrinterManager();

  Future<List<unified.UsbPrinterDevice>> scanUsb() async {
    if (kIsWeb) return const [];
    final devices = await _manager!.scanPrinters(
      timeout: const Duration(seconds: 4),
      types: const {unified.PrinterConnectionType.usb},
    );
    return devices.whereType<unified.UsbPrinterDevice>().toList();
  }

  Future<void> connectUsb(unified.UsbPrinterDevice device) async {
    await _manager!.connect(device);
    final current = await _profileRepository.load();
    await _profileRepository.save(current.copyWith(
      transport: PrinterTransport.usb,
      usbName: device.name,
      usbIdentifier: device.identifier,
    ));
  }

  Future<void> connectNetwork(String host, int port) async {
    if (host.trim().isEmpty) {
      throw const PrinterException(
          message: 'Escribe la dirección IP de la impresora.');
    }
    await _manager!.connect(unified.NetworkPrinterDevice(
      name: 'Impresora $host',
      host: host.trim(),
      port: port,
    ));
    final current = await _profileRepository.load();
    await _profileRepository.save(current.copyWith(
      transport: PrinterTransport.network,
      networkHost: host.trim(),
      networkPort: port,
    ));
  }

  Future<void> disconnectDirect() async {
    await _manager?.disconnect();
  }

  Future<void> _ensureDirect(PrinterProfile profile) async {
    final manager = _manager;
    if (manager == null) {
      throw const PrinterException(
        message: 'Esta conexión de impresora no está disponible en Web.',
      );
    }
    if (manager.isConnected) return;
    switch (profile.transport) {
      case PrinterTransport.system:
        return;
      case PrinterTransport.bluetooth:
        return;
      case PrinterTransport.usb:
        final identifier = profile.usbIdentifier;
        if (identifier == null || identifier.isEmpty) {
          throw const PrinterException(
              message: 'Selecciona una impresora USB.');
        }
        await manager.connect(unified.UsbPrinterDevice(
          name: profile.usbName ?? 'Impresora USB',
          identifier: identifier,
          usbPlatform: unified.UsbPlatform.android,
        ));
      case PrinterTransport.network:
        await connectNetwork(profile.networkHost, profile.networkPort);
    }
  }

  Future<void> printRaw(List<int> bytes) async {
    final profile = await _profileRepository.load();
    if (profile.transport == PrinterTransport.system) {
      throw const PrinterException(
        message: 'La impresora de la PC requiere un documento imprimible.',
      );
    }
    if (profile.transport == PrinterTransport.bluetooth) {
      await _bluetooth.imprimirBytesConectando(bytes);
      return;
    }
    try {
      await _ensureDirect(profile);
      await _manager!.printBytes(bytes);
    } catch (error) {
      throw PrinterException(message: 'No se pudo imprimir: $error');
    }
  }

  Future<void> printTest() async {
    final config = await _configRepository.obtener();
    final selected = await _profileRepository.load();
    if (kIsWeb) {
      final profile = await CapabilityProfile.load();
      final generator = Generator(
        config.impresoraAnchoMm >= 80 ? PaperSize.mm80 : PaperSize.mm58,
        profile,
      );
      var bytes = <int>[];
      bytes += generator.reset();
      bytes += generator.text(
        'Tecno Caja POS',
        styles: const PosStyles(
          align: PosAlign.center,
          bold: true,
          height: PosTextSize.size2,
          width: PosTextSize.size2,
        ),
      );
      bytes += generator.text(
        'Prueba directa ESC/POS ${config.impresoraAnchoMm} mm',
        styles: const PosStyles(align: PosAlign.center),
      );
      bytes += generator.feed(2);
      bytes += generator.cut();
      await _localBridge.printRaw(bytes);
      return;
    }
    if (selected.transport == PrinterTransport.system) {
      await _webPrinter.printTest(config.impresoraAnchoMm);
      return;
    }
    final profile = await CapabilityProfile.load();
    final generator = Generator(
      config.impresoraAnchoMm >= 80 ? PaperSize.mm80 : PaperSize.mm58,
      profile,
    );
    var bytes = <int>[];
    bytes += generator.text(
      'Tecno Caja POS',
      styles: const PosStyles(
        align: PosAlign.center,
        bold: true,
        height: PosTextSize.size2,
        width: PosTextSize.size2,
      ),
    );
    bytes += generator.text(
      'Prueba ${config.impresoraAnchoMm} mm',
      styles: const PosStyles(align: PosAlign.center),
    );
    bytes += generator.hr();
    bytes += generator.text('Impresora configurada correctamente.');
    bytes += generator.feed(2);
    bytes += generator.cut();
    await printRaw(bytes);
  }

  Future<void> printSale({
    required Venta venta,
    required List<VentaItem> items,
    required Empresa empresa,
    required String nombreCajero,
    String? nombreCliente,
  }) async {
    final config = await _configRepository.obtener();
    final selected = await _profileRepository.load();
    if (kIsWeb) {
      final bytes = await ReceiptFormatter.ticketDeVenta(
        venta: venta,
        items: items,
        empresa: empresa,
        nombreCajero: nombreCajero,
        nombreCliente: nombreCliente,
        anchoMm: config.impresoraAnchoMm,
      );
      await _localBridge.printRaw(bytes);
      return;
    }
    if (selected.transport == PrinterTransport.system) {
      await _webPrinter.printSale(
        sale: venta,
        items: items,
        company: empresa,
        cashier: nombreCajero,
        customer: nombreCliente,
        widthMm: config.impresoraAnchoMm,
      );
      return;
    }
    final bytes = await ReceiptFormatter.ticketDeVenta(
      venta: venta,
      items: items,
      empresa: empresa,
      nombreCajero: nombreCajero,
      nombreCliente: nombreCliente,
      anchoMm: config.impresoraAnchoMm,
    );
    await printRaw(bytes);
  }

  Future<void> printLabels(Producto product, int quantity) async {
    final profile = await _profileRepository.load();
    if (kIsWeb || profile.transport == PrinterTransport.system) {
      await _webPrinter.printLabels(
        product: product,
        quantity: quantity,
        widthMm: profile.labelWidthMm,
        heightMm: profile.labelHeightMm,
      );
      return;
    }
    await printRaw(LabelFormatter.tspl(
      product: product,
      quantity: quantity,
      widthMm: profile.labelWidthMm,
      heightMm: profile.labelHeightMm,
      gapMm: profile.labelGapMm,
    ));
  }
}

final unifiedPrinterServiceProvider = Provider<UnifiedPrinterService>((ref) {
  return UnifiedPrinterService(
    ref.watch(printerProfileRepositoryProvider),
    ref.watch(configuracionRepositoryProvider),
    ref.watch(bluetoothPrinterServiceProvider),
    ref.watch(webPrinterServiceProvider),
    LocalPrintBridge(),
  );
});
