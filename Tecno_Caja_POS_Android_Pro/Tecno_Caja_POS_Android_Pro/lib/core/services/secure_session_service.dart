import 'package:flutter_secure_storage/flutter_secure_storage.dart';

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

  Future<void> guardarTokens({required String accessToken, String? refreshToken}) async {
    await _storage.write(key: _keyAccessToken, value: accessToken);
    if (refreshToken != null) {
      await _storage.write(key: _keyRefreshToken, value: refreshToken);
    }
  }

  Future<String?> leerAccessToken() => _storage.read(key: _keyAccessToken);

  Future<String?> leerRefreshToken() => _storage.read(key: _keyRefreshToken);

  Future<void> limpiarTokens() async {
    await _storage.delete(key: _keyAccessToken);
    await _storage.delete(key: _keyRefreshToken);
  }

  /// Identidad estable de esta instalacion (no del hardware -- generarla
  /// nosotros evita pedir permisos invasivos tipo READ_PHONE_STATE). Cambia
  /// solo si se reinstala la app.
  Future<String> obtenerOCrearDeviceId() async {
    final existente = await _storage.read(key: _keyDeviceId);
    if (existente != null && existente.isNotEmpty) return existente;
    final nuevo = IdGenerator.newId();
    await _storage.write(key: _keyDeviceId, value: nuevo);
    return nuevo;
  }

  Future<void> guardarUsuarioBloqueado(String usuarioId) => _storage.write(key: _keyUsuarioBloqueado, value: usuarioId);

  Future<String?> leerUsuarioBloqueado() => _storage.read(key: _keyUsuarioBloqueado);

  Future<void> limpiarBloqueo() => _storage.delete(key: _keyUsuarioBloqueado);

  Future<void> establecerBiometriaHabilitada(bool habilitada) {
    return _storage.write(key: _keyBiometriaHabilitada, value: habilitada ? '1' : '0');
  }

  Future<bool> biometriaHabilitada() async {
    return (await _storage.read(key: _keyBiometriaHabilitada)) == '1';
  }

  Future<void> limpiarTodo() => _storage.deleteAll();
}
