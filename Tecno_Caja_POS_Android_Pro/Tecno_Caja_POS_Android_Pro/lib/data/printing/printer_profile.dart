import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum PrinterTransport { system, bluetooth, usb, network }

class PrinterProfile {
  const PrinterProfile({
    this.transport = PrinterTransport.bluetooth,
    this.usbName,
    this.usbIdentifier,
    this.networkHost = '',
    this.networkPort = 9100,
    this.labelWidthMm = 50,
    this.labelHeightMm = 30,
    this.labelGapMm = 2,
    this.systemPrinterConfigured = false,
  });

  final PrinterTransport transport;
  final String? usbName;
  final String? usbIdentifier;
  final String networkHost;
  final int networkPort;
  final int labelWidthMm;
  final int labelHeightMm;
  final int labelGapMm;
  final bool systemPrinterConfigured;

  PrinterProfile copyWith({
    PrinterTransport? transport,
    String? usbName,
    String? usbIdentifier,
    String? networkHost,
    int? networkPort,
    int? labelWidthMm,
    int? labelHeightMm,
    int? labelGapMm,
    bool? systemPrinterConfigured,
  }) =>
      PrinterProfile(
        transport: transport ?? this.transport,
        usbName: usbName ?? this.usbName,
        usbIdentifier: usbIdentifier ?? this.usbIdentifier,
        networkHost: networkHost ?? this.networkHost,
        networkPort: networkPort ?? this.networkPort,
        labelWidthMm: labelWidthMm ?? this.labelWidthMm,
        labelHeightMm: labelHeightMm ?? this.labelHeightMm,
        labelGapMm: labelGapMm ?? this.labelGapMm,
        systemPrinterConfigured:
            systemPrinterConfigured ?? this.systemPrinterConfigured,
      );
}

class PrinterProfileRepository {
  static const _prefix = 'printer.profile.';

  Future<PrinterProfile> load() async {
    final prefs = await SharedPreferences.getInstance();
    const fallback =
        kIsWeb ? PrinterTransport.system : PrinterTransport.bluetooth;
    final transportName = kIsWeb
        ? PrinterTransport.system.name
        : (prefs.getString('${_prefix}transport') ?? fallback.name);
    return PrinterProfile(
      transport: PrinterTransport.values.firstWhere(
        (value) => value.name == transportName,
        orElse: () => fallback,
      ),
      usbName: prefs.getString('${_prefix}usbName'),
      usbIdentifier: prefs.getString('${_prefix}usbIdentifier'),
      networkHost: prefs.getString('${_prefix}networkHost') ?? '',
      networkPort: prefs.getInt('${_prefix}networkPort') ?? 9100,
      labelWidthMm: prefs.getInt('${_prefix}labelWidth') ?? 50,
      labelHeightMm: prefs.getInt('${_prefix}labelHeight') ?? 30,
      labelGapMm: prefs.getInt('${_prefix}labelGap') ?? 2,
      systemPrinterConfigured:
          prefs.getBool('${_prefix}systemConfigured') ?? false,
    );
  }

  Future<void> save(PrinterProfile profile) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('${_prefix}transport', profile.transport.name);
    if (profile.usbName != null) {
      await prefs.setString('${_prefix}usbName', profile.usbName!);
    }
    if (profile.usbIdentifier != null) {
      await prefs.setString('${_prefix}usbIdentifier', profile.usbIdentifier!);
    }
    await prefs.setString('${_prefix}networkHost', profile.networkHost.trim());
    await prefs.setInt('${_prefix}networkPort', profile.networkPort);
    await prefs.setInt('${_prefix}labelWidth', profile.labelWidthMm);
    await prefs.setInt('${_prefix}labelHeight', profile.labelHeightMm);
    await prefs.setInt('${_prefix}labelGap', profile.labelGapMm);
    await prefs.setBool(
        '${_prefix}systemConfigured', profile.systemPrinterConfigured);
  }
}

final printerProfileRepositoryProvider =
    Provider<PrinterProfileRepository>((ref) => PrinterProfileRepository());

final printerProfileProvider =
    AsyncNotifierProvider<PrinterProfileController, PrinterProfile>(
  PrinterProfileController.new,
);

class PrinterProfileController extends AsyncNotifier<PrinterProfile> {
  @override
  Future<PrinterProfile> build() =>
      ref.watch(printerProfileRepositoryProvider).load();

  Future<void> guardarCambios(
      PrinterProfile Function(PrinterProfile) transform) async {
    final current = state.valueOrNull ??
        await ref.read(printerProfileRepositoryProvider).load();
    final next = transform(current);
    await ref.read(printerProfileRepositoryProvider).save(next);
    state = AsyncData(next);
  }
}
