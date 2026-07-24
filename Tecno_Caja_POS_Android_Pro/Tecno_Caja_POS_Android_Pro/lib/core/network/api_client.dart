import 'package:dio/dio.dart';
import '../config/env.dart';
import '../errors/app_exception.dart';

typedef TokenReader = Future<String?> Function();
typedef TokenRefresher = Future<String?> Function();
typedef UnauthorizedHandler = Future<void> Function();

/// Cliente HTTP unico de la app. Inyecta el JWT en cada request, refresca el
/// token una vez ante un 401 antes de forzar logout, y traduce errores de Dio
/// a [AppException] para que la UI nunca dependa de detalles de transporte.
class ApiClient {
  ApiClient({
    required TokenReader readAccessToken,
    required TokenRefresher refreshAccessToken,
    required UnauthorizedHandler onUnauthorized,
    String? baseUrlOverride,
  })  : _readAccessToken = readAccessToken,
        _refreshAccessToken = refreshAccessToken,
        _onUnauthorized = onUnauthorized,
        dio = Dio(
          BaseOptions(
            baseUrl: baseUrlOverride ?? Env.apiBaseUrl,
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 20),
            sendTimeout: const Duration(seconds: 20),
            headers: const {'Content-Type': 'application/json'},
          ),
        ) {
    validateBaseUrl(dio.options.baseUrl);
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _readAccessToken();
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          if (deviceId.isNotEmpty) {
            options.headers['X-Device-Id'] = deviceId;
          }
          handler.next(options);
        },
        onError: (error, handler) async {
          final isUnauthorized = error.response?.statusCode == 401;
          final alreadyRetried = error.requestOptions.extra['retried'] == true;
          if (isUnauthorized && !alreadyRetried) {
            final newToken = await _refreshAccessToken();
            if (newToken != null) {
              final retryOptions = error.requestOptions..extra['retried'] = true;
              retryOptions.headers['Authorization'] = 'Bearer $newToken';
              try {
                final response = await dio.fetch<dynamic>(retryOptions);
                handler.resolve(response);
                return;
              } catch (_) {
                // cae al onUnauthorized de abajo
              }
            }
            await _onUnauthorized();
          }
          handler.next(error);
        },
      ),
    );
  }

  final Dio dio;
  final TokenReader _readAccessToken;
  final TokenRefresher _refreshAccessToken;
  final UnauthorizedHandler _onUnauthorized;

  /// Se completa despues de construir el cliente (DeviceInfoService es async).
  String deviceId = '';

  /// Cambia el backend activo (nube vs. servidor Windows en LAN) sin recrear
  /// el cliente, para no perder los interceptores ya configurados.
  void setBaseUrl(String url) {
    validateBaseUrl(url);
    dio.options.baseUrl = url;
  }

  /// HTTPS obligatorio salvo hosts locales/privados (RFC1918, localhost,
  /// 10.0.2.2 del emulador). Ver network_security_config.xml para el porque.
  static void validateBaseUrl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.host.isEmpty) return;
    if (uri.scheme == 'https') return;
    if (_isLocalOrPrivateHost(uri.host)) return;
    throw const ServerException(
      message: 'Conexion insegura bloqueada: se requiere HTTPS fuera de la red local.',
    );
  }

  static bool _isLocalOrPrivateHost(String host) {
    if (host == 'localhost' || host == '127.0.0.1' || host == '10.0.2.2') {
      return true;
    }
    final parts = host.split('.').map(int.tryParse).toList();
    if (parts.length != 4 || parts.any((p) => p == null)) return false;
    final a = parts[0]!;
    final b = parts[1]!;
    if (a == 10) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    return false;
  }

  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query}) {
    return _wrap(() => dio.get<T>(path, queryParameters: query));
  }

  Future<Response<T>> post<T>(String path, {dynamic data, String? idempotencyKey}) {
    final options = idempotencyKey != null ? Options(headers: {'Idempotency-Key': idempotencyKey}) : null;
    return _wrap(() => dio.post<T>(path, data: data, options: options));
  }

  Future<Response<T>> put<T>(String path, {dynamic data}) {
    return _wrap(() => dio.put<T>(path, data: data));
  }

  Future<Response<T>> patch<T>(String path, {dynamic data}) {
    return _wrap(() => dio.patch<T>(path, data: data));
  }

  Future<Response<T>> delete<T>(String path) {
    return _wrap(() => dio.delete<T>(path));
  }

  Future<Response<T>> _wrap<T>(Future<Response<T>> Function() call) async {
    try {
      return await call();
    } on DioException catch (e) {
      throw _mapDioException(e);
    }
  }

  AppException _mapDioException(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.connectionError:
        return const NetworkException();
      default:
        final status = e.response?.statusCode;
        final serverMessage = _extractServerMessage(e.response?.data);
        if (status == 401) {
          return UnauthorizedException(message: serverMessage ?? 'Sesion invalida o expirada.', cause: e);
        }
        if (status == 403) {
          return ForbiddenException(message: serverMessage ?? 'No tienes permiso para realizar esta accion.', cause: e);
        }
        if (status == 404) {
          return NotFoundException(message: serverMessage ?? 'No se encontro el registro.', cause: e);
        }
        if (status == 409) {
          return ConflictException(message: serverMessage ?? 'Conflicto de sincronizacion.', cause: e);
        }
        if (status == 422 || status == 400) {
          return ValidationException(message: serverMessage ?? 'Datos invalidos.', cause: e);
        }
        if (status != null && status >= 500) {
          return ServerException(message: serverMessage ?? 'Error del servidor. Intenta de nuevo.', statusCode: status, cause: e);
        }
        return UnknownAppException(message: serverMessage ?? 'Ocurrio un error inesperado.', cause: e);
    }
  }

  String? _extractServerMessage(dynamic data) {
    if (data is Map && data['message'] is String) return data['message'] as String;
    if (data is Map && data['error'] is String) return data['error'] as String;
    return null;
  }
}
