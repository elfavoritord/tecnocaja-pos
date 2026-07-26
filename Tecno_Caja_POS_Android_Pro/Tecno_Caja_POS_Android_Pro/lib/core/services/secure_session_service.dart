import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/id_generator.dart';

/// Todo lo sensible que no debe vivir en SQLite plano: tokens del backend
/// Windows/nube, id de dispositivo persistente, y quien quedo con la sesion
/// bloqueada por PIN. Usa Keystore/Keychain via flutter_secure_storage.
class SecureSessionService {
  SecureSessionService()
      : _storage = const FlutterSecureStorage(
          aOptions: AndroidOptions(encryptedSharedPreferences: true),
        );

  final FlutterSecureStorage _storage;

  static const _keyAccessToken = 'tc_access_token';
  static const _keyRefreshToken = 'tc_refresh_token';
  static const _keyDeviceId = 'tc_device_id';
  static const _keyUsuarioBloqueado = 'tc_usuario_bloqueado';
  static const _keyBiometriaHabilitada = 'tc_biometria_habilitada';

  Future<void> guardarTokens(
      {required String accessToken, String? refreshToken}) async {
    await _storage.write(key: _keyAccessToken, value: accessToken);
    if (refreshToken != null) {
      await _storage.write(key: _keyRefreshToken, value: refreshToken);
    }
  }

  Future<String?> leerAccessToken() => _safeRead(_keyAccessToken);

  Future<String?> leerRefreshToken() => _safeRead(_keyRefreshToken);

  Future<void> limpiarTokens() async {
    await _storage.delete(key: _keyAccessToken);
    await _storage.delete(key: _keyRefreshToken);
  }

  /// Identidad estable de esta instalacion (no del hardware -- generarla
  /// nosotros evita pedir permisos invasivos tipo READ_PHONE_STATE). Cambia
  /// solo si se reinstala la app.
  Future<String> obtenerOCrearDeviceId() async {
    // En Web no es un secreto y no debe depender de WebCrypto. Si cambia el
    // origen/puerto o se corrompe la clave de flutter_secure_storage,
    // crypto.decrypt puede detener toda una venta. SharedPreferences usa
    // localStorage/IndexedDB sin cifrado y es apropiado para este UUID.
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      final existente = prefs.getString(_keyDeviceId);
      if (existente != null && existente.isNotEmpty) return existente;
      final nuevo = IdGenerator.newId();
      await prefs.setString(_keyDeviceId, nuevo);
      return nuevo;
    }
    final existente = await _safeRead(_keyDeviceId);
    if (existente != null && existente.isNotEmpty) return existente;
    final nuevo = IdGenerator.newId();
    await _storage.write(key: _keyDeviceId, value: nuevo);
    return nuevo;
  }

  Future<void> guardarUsuarioBloqueado(String usuarioId) =>
      _storage.write(key: _keyUsuarioBloqueado, value: usuarioId);

  Future<String?> leerUsuarioBloqueado() => _safeRead(_keyUsuarioBloqueado);

  Future<void> limpiarBloqueo() => _storage.delete(key: _keyUsuarioBloqueado);

  Future<void> establecerBiometriaHabilitada(bool habilitada) {
    return _storage.write(
        key: _keyBiometriaHabilitada, value: habilitada ? '1' : '0');
  }

  Future<bool> biometriaHabilitada() async {
    return (await _safeRead(_keyBiometriaHabilitada)) == '1';
  }

  Future<void> limpiarTodo() => _storage.deleteAll();

  Future<String?> _safeRead(String key) async {
    try {
      return await _storage.read(key: key);
    } catch (_) {
      // Un valor cifrado con una clave web anterior no se puede recuperar.
      // Se elimina solo esa entrada; el login puede renovar tokens y la app
      // no queda congelada en una excepción de WebCrypto.
      try {
        await _storage.delete(key: key);
      } catch (_) {}
      return null;
    }
  }
}
