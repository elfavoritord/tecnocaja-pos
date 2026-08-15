import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';

import '../network/network_info.dart';
import '../services/biometric_service.dart';
import '../services/device_info_service.dart';
import '../services/secure_session_service.dart';

final secureSessionServiceProvider =
    Provider<SecureSessionService>((ref) => SecureSessionService());
final deviceInfoServiceProvider =
    Provider<DeviceInfoService>((ref) => DeviceInfoService());
final biometricServiceProvider =
    Provider<BiometricService>((ref) => BiometricService());
final networkInfoProvider = Provider<NetworkInfo>(
  (ref) => NetworkInfoImpl(Connectivity()),
);
