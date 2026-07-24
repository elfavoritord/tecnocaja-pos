import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:print_bluetooth_thermal/print_bluetooth_thermal.dart';

import '../../core/errors/app_exception.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/venta.dart';
import '../repositories/configuracion_repository.dart';
import 'receipt_formatter.dart';

/// Envuelve print_bluetooth_thermal: buscar impresoras emparejadas, conectar,
/// reconectar a la predeterminada guardada en ConfiguracionApp, e imprimir
/// bytes ESC/POS. No guarda estado propio de conexion -- pregunta siempre al
/// plugin (`connectionStatus`) porque el SO puede desconectar la impresora
/// en cualquier momento sin avisar a Flutter.
class BluetoothPrinterService {
  BluetoothPrinterService(this._configRepo);

  final ConfiguracionRepository _configRepo;

  /// print_bluetooth_thermal no tiene implementacion web (solo
  /// Android/iOS/macOS/Windows) -- cualquier llamada al plugin en el
  /// navegador termina en MissingPluginException, asi que cada metodo
  /// publico corta antes con un resultado neutro (o PrinterException en los
  /// que imprimen de verdad).
  Future<bool> permisosConcedidos() async {
    if (kIsWeb) return false;
    final resultados = await [Permission.bluetoothConnect, Permission.bluetoothScan].request();
    return resultados.values.every((estado) => estado.isGranted);
  }

  Future<bool> bluetoothEncendido() async {
    if (kIsWeb) return false;
    return PrintBluetoothThermal.bluetoothEnabled;
  }

  /// Android: impresoras ya emparejadas en los ajustes del sistema (este
  /// plugin no hace descubrimiento nuevo, solo lista lo ya vinculado).
  Future<List<BluetoothInfo>> buscarImpresoras() async {
    if (kIsWeb) return const [];
    return PrintBluetoothThermal.pairedBluetooths;
  }

  Future<bool> estaConectada() async {
    if (kIsWeb) return false;
    return PrintBluetoothThermal.connectionStatus;
  }

  Future<bool> conectar(String macAddress) async {
    if (kIsWeb) return false;
    return PrintBluetoothThermal.connect(macPrinterAddress: macAddress);
  }

  Future<bool> desconectar() async {
    if (kIsWeb) return false;
    return PrintBluetoothThermal.disconnect;
  }

  /// Se llama antes de cada impresion: si ya hay conexion activa la reusa,
  /// si no intenta reconectar sola a la impresora predeterminada guardada.
  Future<bool> _asegurarConectada() async {
    if (await estaConectada()) return true;
    final config = await _configRepo.obtener();
    final mac = config.impresoraPredeterminadaMac;
    if (mac == null || mac.isEmpty) return false;
    return conectar(mac);
  }

  Future<bool> imprimirBytes(List<int> bytes) => PrintBluetoothThermal.writeBytes(bytes);

  Future<void> imprimirVenta({
    required Venta venta,
    required List<VentaItem> items,
    required Empresa empresa,
    required String nombreCajero,
    String? nombreCliente,
  }) async {
    if (kIsWeb) {
      throw const PrinterException(
        message: 'La impresión Bluetooth no está disponible en la vista web. Pruébala en el emulador o un Android real.',
      );
    }
    final config = await _configRepo.obtener();
    final conectada = await _asegurarConectada();
    if (!conectada) {
      throw const PrinterException(
        message: 'No hay una impresora conectada. Configúrala en Ajustes > Impresora.',
      );
    }
    final bytes = await ReceiptFormatter.ticketDeVenta(
      venta: venta,
      items: items,
      empresa: empresa,
      nombreCajero: nombreCajero,
      nombreCliente: nombreCliente,
      anchoMm: config.impresoraAnchoMm,
    );
    final ok = await imprimirBytes(bytes);
    if (!ok) {
      throw const PrinterException(message: 'Fallo al enviar el recibo a la impresora.');
    }
  }

  Future<void> imprimirPrueba(int anchoMm) async {
    if (kIsWeb) {
      throw const PrinterException(
        message: 'La impresión Bluetooth no está disponible en la vista web. Pruébala en el emulador o un Android real.',
      );
    }
    final conectada = await _asegurarConectada();
    if (!conectada) {
      throw const PrinterException(message: 'No hay una impresora conectada.');
    }
    final profile = await CapabilityProfile.load();
    final generator = Generator(anchoMm >= 80 ? PaperSize.mm80 : PaperSize.mm58, profile);

    List<int> bytes = [];
    bytes += generator.text(
      'Tecno Caja POS',
      styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2),
    );
    bytes += generator.text('Prueba de impresión', styles: const PosStyles(align: PosAlign.center));
    bytes += generator.text('Papel: ${anchoMm}mm', styles: const PosStyles(align: PosAlign.center));
    bytes += generator.hr();
    bytes += generator.text('Si puedes leer esto con claridad, la impresora quedó bien configurada.');
    bytes += generator.feed(2);
    bytes += generator.cut();

    final ok = await imprimirBytes(bytes);
    if (!ok) {
      throw const PrinterException(message: 'Fallo al enviar la prueba a la impresora.');
    }
  }
}

final bluetoothPrinterServiceProvider = Provider<BluetoothPrinterService>((ref) {
  return BluetoothPrinterService(ref.watch(configuracionRepositoryProvider));
});
