import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:package_info_plus/package_info_plus.dart';

class InfoDispositivo {
  const InfoDispositivo(
      {required this.nombreModelo,
      required this.fabricante,
      required this.versionAndroid,
      required this.appVersion});

  final String nombreModelo;
  final String fabricante;
  final String versionAndroid;
  final String appVersion;

  String get nombreParaMostrar => '$fabricante $nombreModelo';
}

class DeviceInfoService {
  final DeviceInfoPlugin _plugin = DeviceInfoPlugin();

  /// `androidInfo` es un concepto exclusivamente de Android -- en Flutter Web
  /// (usado hoy solo para pruebas rápidas en Chrome, la app real es Android)
  /// `device_info_plus` intenta rellenar el mismo modelo con datos que el
  /// navegador no tiene, y `AndroidDeviceInfo.fromMap` revienta con un
  /// `TypeError` al castear un campo nulo a String. Se evita por completo en
  /// web con un `InfoDispositivo` sintético en vez de arriesgar ese crash.
  Future<InfoDispositivo> obtener() async {
    String appVersion = 'desconocida';
    try {
      final paquete = await PackageInfo.fromPlatform();
      appVersion = '${paquete.version}+${paquete.buildNumber}';
    } catch (_) {
      // Los metadatos del paquete no son imprescindibles para crear la
      // empresa. En una compilación web servida sin version.json pueden no
      // estar disponibles.
    }

    if (kIsWeb) {
      try {
        final navegador = await _plugin.webBrowserInfo;
        return InfoDispositivo(
          nombreModelo: navegador.browserName.name,
          fabricante: 'Web',
          versionAndroid: navegador.appVersion ?? 'desconocida',
          appVersion: appVersion,
        );
      } catch (_) {
        return InfoDispositivo(
          nombreModelo: 'Navegador',
          fabricante: 'Web',
          versionAndroid: 'desconocida',
          appVersion: appVersion,
        );
      }
    }

    final android = await _plugin.androidInfo;
    return InfoDispositivo(
      nombreModelo: android.model,
      fabricante: android.manufacturer,
      versionAndroid: android.version.release,
      appVersion: appVersion,
    );
  }
}
