import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/services/secure_session_service.dart';
import '../../domain/entities/usuario.dart';
import '../repositories/usuario_repository.dart';
import 'auth_service.dart';

/// Puente entre la identidad de Firebase (Tecno Caja ID) y el registro local
/// en `usuarios`. Firebase decide QUIEN es la persona; esta tabla decide QUE
/// puede hacer dentro de ESTE negocio (rol, permisos, sucursal).
class AuthRepository {
  AuthRepository(this._authService, this._usuarioRepository, this._secureSession);

  final AuthService _authService;
  final UsuarioRepository _usuarioRepository;
  final SecureSessionService _secureSession;

  Stream<User?> get cambiosDeSesion => _authService.cambiosDeSesion;

  User? get usuarioFirebaseActual => _authService.usuarioActual;

  /// null significa: hay sesion de Firebase pero este dispositivo todavia no
  /// tiene un `Usuario` local para esa cuenta (falta onboarding, o falta
  /// sincronizar-bajar un negocio ya existente -- ver Fase de sincronizacion).
  Future<Usuario?> resolverUsuarioLocal(User firebaseUser) {
    return _usuarioRepository.porFirebaseUid(firebaseUser.uid);
  }

  Future<User> registrarConCorreo({
    required String correo,
    required String contrasena,
    required String nombreCompleto,
  }) {
    return _authService.registrarConCorreo(correo: correo, contrasena: contrasena, nombreCompleto: nombreCompleto);
  }

  Future<User> iniciarSesionConCorreo({required String correo, required String contrasena}) {
    return _authService.iniciarSesionConCorreo(correo: correo, contrasena: contrasena);
  }

  Future<User> iniciarSesionConGoogle() => _authService.iniciarSesionConGoogle();

  Future<void> enviarRecuperacionContrasena(String correo) => _authService.enviarRecuperacionContrasena(correo);

  Future<bool> verificarPin(Usuario usuario, String pin) async {
    if (usuario.pinHash == null || usuario.pinHash!.isEmpty) return true;
    return _hashPin(pin, usuario.id) == usuario.pinHash;
  }

  Future<void> establecerPin(Usuario usuario, String pin) async {
    await _usuarioRepository.actualizar(usuario.copyWith(pinHash: _hashPin(pin, usuario.id)));
  }

  Future<void> quitarPin(Usuario usuario) async {
    await _usuarioRepository.actualizar(usuario.copyWith(pinHash: ''));
  }

  String _hashPin(String pin, String salt) {
    return sha256.convert(utf8.encode('$salt:$pin:tecnocaja')).toString();
  }

  Future<void> cerrarSesion() async {
    await _authService.cerrarSesion();
    await _secureSession.limpiarBloqueo();
    await _secureSession.limpiarTokens();
  }
}

final authServiceProvider = Provider<AuthService>((ref) => AuthService());

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    ref.watch(authServiceProvider),
    ref.watch(usuarioRepositoryProvider),
    ref.watch(secureSessionServiceProvider),
  );
});
