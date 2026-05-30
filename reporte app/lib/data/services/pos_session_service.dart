import 'dart:convert';
import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'novapos_api_settings_service.dart';

class PosSessionService {
  PosSessionService._();

  static final PosSessionService instance = PosSessionService._();

  static const String _tokenPrefsKey = 'novapos_session_token';
  static const Duration _requestTimeout = Duration(seconds: 15);

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final http.Client _client = http.Client();

  // Mutex: evita que múltiples requests paralelos llamen firebase-session al mismo tiempo
  Future<String>? _pendingRefresh;

  Future<String> ensureSession({bool forceRefresh = false}) async {
    final prefs = await SharedPreferences.getInstance();
    if (!forceRefresh) {
      final storedToken = prefs.getString(_tokenPrefsKey) ?? '';
      if (storedToken.isNotEmpty) {
        return storedToken;
      }
    }

    // Si ya hay un refresh en progreso, esperar ese mismo resultado
    if (_pendingRefresh != null) {
      return _pendingRefresh!;
    }

    _pendingRefresh = _doRefreshSession(prefs, forceRefresh);
    try {
      final token = await _pendingRefresh!;
      return token;
    } finally {
      _pendingRefresh = null;
    }
  }

  Future<String> _doRefreshSession(
    SharedPreferences prefs,
    bool forceRefresh,
  ) async {
    final user = _auth.currentUser;
    if (user == null) {
      throw StateError('No hay un usuario autenticado en Firebase.');
    }

    try {
      final idToken = await user.getIdToken(forceRefresh);
      final baseUrl = await NovaposApiSettingsService.instance.getBaseUrl();
      final response = await _client
          .post(
            Uri.parse('$baseUrl/api/login/firebase-session'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'idToken': idToken}),
          )
          .timeout(_requestTimeout);

      final payload = _decodeBody(response.body);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final message =
            payload['error']?.toString() ??
            'No se pudo abrir la sesión del POS.';
        throw StateError(message);
      }

      final token = payload['token']?.toString() ?? '';
      if (token.isEmpty) {
        throw StateError(
          'El POS no devolvió un token de sesión válido para reportes.',
        );
      }

      await prefs.setString(_tokenPrefsKey, token);
      return token;
    } on TimeoutException {
      throw StateError(
        'El servidor tardó demasiado en responder. Revisa la URL configurada y tu conexión.',
      );
    } on http.ClientException catch (error) {
      throw StateError(_friendlyClientError(error));
    }
  }

  Future<void> clearSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenPrefsKey);
  }

  Map<String, dynamic> _decodeBody(String body) {
    final trimmed = body.trim();
    if (trimmed.isEmpty) {
      return <String, dynamic>{};
    }

    if (trimmed.startsWith('<')) {
      throw StateError(
        'El servidor devolvió HTML en lugar del token de sesión. '
        'Verifica que la URL del servidor sea correcta en Ajustes.',
      );
    }

    final decoded = jsonDecode(trimmed);
    if (decoded is Map<String, dynamic>) {
      return decoded;
    }

    return <String, dynamic>{'data': decoded};
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
