import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../services/novapos_api_settings_service.dart';
import '../services/pos_session_service.dart';

class ReportsApiRepository {
  ReportsApiRepository({http.Client? client})
    : _client = client ?? http.Client();

  final http.Client _client;
  static const Duration _requestTimeout = Duration(seconds: 15);

  Future<dynamic> getJson(
    String path, {
    Map<String, String>? queryParameters,
    bool retryOnUnauthorized = true,
  }) async {
    final baseUrl = await NovaposApiSettingsService.instance.getBaseUrl();
    final sessionToken = await PosSessionService.instance.ensureSession();
    final uri = Uri.parse('$baseUrl$path').replace(
      queryParameters: queryParameters?.isEmpty == true
          ? null
          : queryParameters,
    );

    try {
      final response = await _client
          .get(uri, headers: _buildHeaders(sessionToken))
          .timeout(_requestTimeout);

      if (response.statusCode == 401 && retryOnUnauthorized) {
        await PosSessionService.instance.clearSession();
        final freshToken = await PosSessionService.instance.ensureSession(
          forceRefresh: true,
        );
        final retryResponse = await _client
            .get(uri, headers: _buildHeaders(freshToken))
            .timeout(_requestTimeout);
        return _decodeResponse(retryResponse);
      }

      return _decodeResponse(response);
    } on TimeoutException {
      throw StateError(
        'El servidor tardó demasiado en responder. Revisa la URL configurada y tu conexión.',
      );
    } on http.ClientException catch (error) {
      throw StateError(_friendlyClientError(error));
    }
  }

  void dispose() {
    _client.close();
  }

  Map<String, String> buildRangeQuery(DateTime from, DateTime to) {
    return <String, String>{
      'desde': _formatDate(from),
      'hasta': _formatDate(to),
    };
  }

  Map<String, String> _buildHeaders(String token) {
    return <String, String>{
      'Accept': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  dynamic _decodeResponse(http.Response response) {
    final body = response.body.trim();

    if (body.isNotEmpty && body.startsWith('<')) {
      throw StateError(
        'El servidor devolvió una página HTML en lugar de datos. '
        'Verifica que la URL configurada en Ajustes sea correcta '
        '(ej. http://192.168.1.X:3399) y que el servidor esté encendido.',
      );
    }

    final payload = body.isEmpty ? null : jsonDecode(body);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(_extractErrorMessage(payload, response.statusCode));
    }

    return payload;
  }

  String _extractErrorMessage(dynamic payload, int statusCode) {
    if (payload is Map<String, dynamic>) {
      final error = payload['error']?.toString().trim() ?? '';
      if (error.isNotEmpty) {
        return error;
      }
    }

    if (statusCode == 401) {
      return 'La sesión venció. Vuelve a intentar.';
    }

    return 'No se pudo cargar el reporte. Código $statusCode.';
  }

  String _friendlyClientError(http.ClientException error) {
    final raw = error.message.toLowerCase();
    if (raw.contains('xmlhttprequest') ||
        raw.contains('cors') ||
        raw.contains('origin')) {
      return 'El servidor bloqueó esta app por CORS. Debes permitir el dominio desde donde abriste Tecno Reporte.';
    }

    return 'No se pudo conectar con el servidor. Revisa la URL configurada en Ajustes.';
  }
}

String _formatDate(DateTime value) {
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');
  return '$year-$month-$day';
}
