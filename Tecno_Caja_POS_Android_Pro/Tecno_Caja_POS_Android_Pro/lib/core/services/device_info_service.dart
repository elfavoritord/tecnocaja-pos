import 'package:device_info_plus/device_info_plus.dart';
import 'package:package_info_plus/package_info_plus.dart';

class InfoDispositivo {
  const InfoDispositivo({required this.nombreModelo, required this.fabricante, required this.versionAndroid, required this.appVersion});

  final String nombreModelo;
  final String fabricante;
  final String versionAndroid;
  final String appVersion;

  String get nombreParaMostrar => '$fabricante $nombreModelo';
}

class DeviceInfoService {
  final DeviceInfoPlugin _plugin = DeviceInfoPlugin();

  Future<InfoDispositivo> obtener() async {
    final android = await _plugin.androidInfo;
    final paquete = await PackageInfo.fromPlatform();
    return InfoDispositivo(
      nombreModelo: android.model,
      fabricante: android.manufacturer,
      versionAndroid: android.version.release,
      appVersion: '${paquete.version}+${paquete.buildNumber}',
    );
  }
}
