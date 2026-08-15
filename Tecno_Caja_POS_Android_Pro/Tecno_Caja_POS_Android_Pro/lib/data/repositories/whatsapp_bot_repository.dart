import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/env.dart';
import '../../core/errors/app_exception.dart';

class WhatsappBotStatus {
  const WhatsappBotStatus({
    required this.status,
    required this.ready,
    required this.connected,
    this.qr,
    this.message,
  });

  final String status;
  final bool ready;
  final bool connected;
  final String? qr;
  final String? message;

  factory WhatsappBotStatus.fromMap(Map<String, Object?> map) {
    final status = map['status']?.toString() ?? 'desconocido';
    return WhatsappBotStatus(
      status: status,
      ready: map['ready'] == true || status == 'ready',
      connected: map['connected'] == true || status == 'ready',
      qr: map['qr']?.toString(),
      message: map['message']?.toString() ?? map['error']?.toString(),
    );
  }
}

class WhatsappBotRepository {
  WhatsappBotRepository()
      : _dio = Dio(
          BaseOptions(
            baseUrl: Env.apiBaseUrl,
            connectTimeout: const Duration(seconds: 8),
            receiveTimeout: const Duration(seconds: 12),
            sendTimeout: const Duration(seconds: 12),
            headers: const {'Content-Type': 'application/json'},
          ),
        );

  final Dio _dio;

  Future<WhatsappBotStatus> status() async {
    final data = await _get('/api/wa-bot/status');
    return WhatsappBotStatus.fromMap(data);
  }

  Future<Map<String, Object?>> savedKeys() => _get('/api/wa-bot/saved-keys');

  Future<String> instructions() async {
    final data = await _get('/api/wa-bot/instructions');
    return data['instructions']?.toString() ?? '';
  }

  Future<void> saveInstructions(String instructions) async {
    await _post('/api/wa-bot/instructions', {'instructions': instructions});
  }

  Future<void> start({
    required String ownerPhone,
    String? ownerPhone2,
    required String provider,
    String? apiKey,
  }) async {
    await _post('/api/wa-bot/start', {
      'ownerPhone': ownerPhone,
      if (ownerPhone2?.trim().isNotEmpty == true) 'ownerPhone2': ownerPhone2,
      'provider': provider,
      if (apiKey?.trim().isNotEmpty == true) 'apiKey': apiKey,
    });
  }

  Future<void> stop() => _post('/api/wa-bot/stop', const {});

  Future<Map<String, Object?>> _get(String path) async {
    try {
      final res = await _dio.get<dynamic>(path);
      return _asMap(res.data);
    } on DioException catch (e) {
      throw _map(e);
    }
  }

  Future<void> _post(String path, Map<String, Object?> data) async {
    try {
      await _dio.post<dynamic>(path, data: data);
    } on DioException catch (e) {
      throw _map(e);
    }
  }

  Map<String, Object?> _asMap(dynamic data) {
    if (data is Map) return data.map((k, v) => MapEntry(k.toString(), v));
    return const {};
  }

  AppException _map(DioException e) {
    final data = e.response?.data;
    final message = data is Map
        ? (data['error']?.toString() ?? data['message']?.toString())
        : null;
    if (e.response?.statusCode == 404) {
      return NotFoundException(
        message: message ??
            'El bot de WhatsApp no está disponible en este servidor.',
        cause: e,
      );
    }
    if (e.type == DioExceptionType.connectionError ||
        e.type == DioExceptionType.connectionTimeout) {
      return const NetworkException(
        message:
            'No se pudo conectar al servicio del bot. Verifica la conexión con el POS Windows o la API configurada.',
      );
    }
    return ServerException(
      message: message ?? 'No se pudo comunicar con WhatsApp Bot.',
      cause: e,
    );
  }
}

final whatsappBotRepositoryProvider = Provider<WhatsappBotRepository>((ref) {
  return WhatsappBotRepository();
});
