import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/env.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/services/secure_session_service.dart';
import 'mobile_sync_models.dart';

/// Cliente HTTP para GET /api/mobile-sync/* -- deliberadamente separado del
/// [ApiClient] general (que hoy no está conectado a ningún flujo) para
/// mantener acotado el alcance de esta primera fase de sincronización.
/// Reintenta una sola vez con refresh token ante un 401 (access token
/// vencido); si el refresh también falla, el llamador debe pedir vincular
/// de nuevo -- ver SettingsScreen.
class MobileSyncApi {
  MobileSyncApi(this._secureSession)
      : _dio = Dio(BaseOptions(
          baseUrl: Env.apiBaseUrl,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 20),
          headers: const {'Content-Type': 'application/json'},
        ));

  final SecureSessionService _secureSession;
  final Dio _dio;

  Future<Response<T>> _authorizedGet<T>(String path, {Map<String, dynamic>? query}) async {
    final token = await _secureSession.leerAccessToken();
    if (token == null) {
      throw const UnauthorizedException(message: 'No hay una vinculación activa con Tecno Caja Windows.');
    }
    try {
      return await _dio.get<T>(path, queryParameters: query, options: Options(headers: {'Authorization': 'Bearer $token'}));
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        final renovado = await _intentarRefrescar();
        if (renovado != null) {
          return _dio.get<T>(path, queryParameters: query, options: Options(headers: {'Authorization': 'Bearer $renovado'}));
        }
      }
      throw UnauthorizedException(message: 'La sesión con Windows expiró. Vincula de nuevo el dispositivo.', cause: e);
    }
  }

  Future<String?> _intentarRefrescar() async {
    final refreshToken = await _secureSession.leerRefreshToken();
    if (refreshToken == null) return null;
    try {
      final response = await _dio.post<Map<String, dynamic>>('/api/mobile-auth/refresh', data: {'refreshToken': refreshToken});
      final data = response.data;
      if (data == null) return null;
      final accessToken = data['accessToken'] as String;
      await _secureSession.guardarTokens(accessToken: accessToken, refreshToken: data['refreshToken'] as String);
      return accessToken;
    } catch (_) {
      return null;
    }
  }

  Future<List<RemoteProducto>> productos({required String branchId}) async {
    final response = await _authorizedGet<Map<String, dynamic>>('/api/mobile-sync/productos', query: {'branchId': branchId});
    final lista = (response.data?['productos'] as List?) ?? const [];
    return lista.map((e) => RemoteProducto.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<RemoteCliente>> clientes() async {
    final response = await _authorizedGet<Map<String, dynamic>>('/api/mobile-sync/clientes');
    final lista = (response.data?['clientes'] as List?) ?? const [];
    return lista.map((e) => RemoteCliente.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<RemoteProveedor>> proveedores() async {
    final response = await _authorizedGet<Map<String, dynamic>>('/api/mobile-sync/proveedores');
    final lista = (response.data?['proveedores'] as List?) ?? const [];
    return lista.map((e) => RemoteProveedor.fromJson(e as Map<String, dynamic>)).toList();
  }
}

final mobileSyncApiProvider = Provider<MobileSyncApi>((ref) => MobileSyncApi(ref.watch(secureSessionServiceProvider)));
