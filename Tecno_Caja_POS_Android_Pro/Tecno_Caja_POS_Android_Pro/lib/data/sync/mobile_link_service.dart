import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/env.dart';
import '../../core/errors/app_exception.dart';
import 'mobile_sync_models.dart';

/// Intento de vinculación con Tecno Caja Windows vía el mismo Tecno Caja ID
/// (Google) que ya usa el login de la app. Se ejecuta automáticamente cada
/// vez que Firebase autentica a un usuario que todavía no tiene un [Usuario]
/// local -- ver AuthController._onFirebaseUserChanged.
///
/// Deliberadamente NO usa el [ApiClient] general (timeouts largos, maneja
/// 401 con refresh): esto es una sonda de "¿existe un POS Windows con este
/// usuario?" que debe fallar rápido y en silencio -- la mayoría de las
/// instalaciones son 100% standalone y no tienen Windows detrás, así que no
/// se debe hacer esperar el onboarding más de unos segundos.
class MobileLinkService {
  MobileLinkService() : _dio = Dio(BaseOptions(
          baseUrl: Env.apiBaseUrl,
          connectTimeout: const Duration(seconds: 5),
          sendTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 6),
          headers: const {'Content-Type': 'application/json'},
        ));

  final Dio _dio;

  /// Devuelve null si no hay vinculación posible: usuario sin match en
  /// Windows (404), Windows no configurado con Firebase, sin red, o
  /// cualquier otro error -- todos se tratan igual (seguir a onboarding
  /// standalone). El error solo se registra en consola de depuración.
  Future<MobileLinkPayload?> intentarVincular({
    required String idToken,
    required String deviceId,
    String? deviceName,
    String? appVersion,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/mobile-auth/login',
        data: {
          'idToken': idToken,
          'deviceId': deviceId,
          'deviceName': deviceName,
          'platform': 'android',
          'appVersion': appVersion,
        },
      );
      final data = response.data;
      if (data == null) return null;
      return MobileLinkPayload.fromJson(data);
    } on DioException catch (e) {
      debugPrint(
        '[MobileLinkService] intentarVincular falló: '
        '${e.response?.statusCode} ${e.response?.data ?? e.message}',
      );
      return null;
    } catch (e) {
      debugPrint('[MobileLinkService] intentarVincular falló: $e');
      return null;
    }
  }

  /// Login explicito con usuario/contraseña locales del POS (la misma
  /// cuenta con la que ese cajero entra en Windows). A diferencia de
  /// [intentarVincular] esto lo dispara el usuario a proposito tecleando
  /// credenciales, asi que los errores deben llegar claros a la UI en vez
  /// de tragarse.
  Future<MobileLinkPayload> iniciarSesionLocal({
    required String usuario,
    required String password,
    required String deviceId,
    String? deviceName,
    String? appVersion,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/api/mobile-auth/login-local',
        data: {
          'usuario': usuario,
          'password': password,
          'deviceId': deviceId,
          'deviceName': deviceName,
          'platform': 'android',
          'appVersion': appVersion,
        },
      );
      final data = response.data;
      if (data == null) {
        throw const UnknownAppException(message: 'El POS no devolvió una respuesta válida.');
      }
      return MobileLinkPayload.fromJson(data);
    } on DioException catch (e) {
      final data = e.response?.data;
      final mensaje = data is Map ? data['error'] as String? : null;
      final status = e.response?.statusCode;
      if (status == 401) {
        throw UnauthorizedException(message: mensaje ?? 'Usuario o contraseña incorrectos.');
      }
      if (status == 429) {
        throw UnauthorizedException(message: mensaje ?? 'Demasiados intentos. Espera unos minutos.');
      }
      if (status == 400) {
        throw ValidationException(message: mensaje ?? 'Faltan datos para iniciar sesión.');
      }
      throw NetworkException(
        message: mensaje ?? 'No se pudo conectar con el POS. Verifica la conexión con Windows.',
        cause: e,
      );
    }
  }
}

final mobileLinkServiceProvider = Provider<MobileLinkService>((ref) => MobileLinkService());
