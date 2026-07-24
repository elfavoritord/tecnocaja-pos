import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../domain/entities/usuario.dart';
import '../repositories/empresa_repository.dart';
import '../repositories/usuario_repository.dart';
import '../sync/catalog_sync_repository.dart';
import '../sync/mobile_link_service.dart';
import '../sync/vinculacion_repository.dart';
import 'auth_repository.dart';

enum AuthStatus { cargando, noAutenticado, requiereOnboarding, bloqueado, autenticado }

class AuthState {
  const AuthState({required this.status, this.usuario, this.empresaId});

  final AuthStatus status;
  final Usuario? usuario;
  final String? empresaId;

  static const cargando = AuthState(status: AuthStatus.cargando);
  static const noAutenticado = AuthState(status: AuthStatus.noAutenticado);
  static const requiereOnboarding = AuthState(status: AuthStatus.requiereOnboarding);

  AuthState copyWith({AuthStatus? status, Usuario? usuario}) {
    return AuthState(
      status: status ?? this.status,
      usuario: usuario ?? this.usuario,
      empresaId: usuario?.empresaId ?? empresaId,
    );
  }
}

/// Unica fuente de verdad de "en que pantalla deberia estar el usuario" --
/// el router (GoRouter.redirect) observa esto para decidir entre
/// login/onboarding/pin-lock/dashboard. Combina el stream de Firebase con el
/// bloqueo por inactividad (PIN), que Firebase no sabe nada de eso.
class AuthController extends Notifier<AuthState> {
  StreamSubscription<User?>? _sub;
  DateTime? _pausadoEn;

  static const _umbralBloqueo = Duration(seconds: 60);

  @override
  AuthState build() {
    final repo = ref.watch(authRepositoryProvider);
    _sub = repo.cambiosDeSesion.listen(_onFirebaseUserChanged);
    ref.onDispose(() => _sub?.cancel());
    return AuthState.cargando;
  }

  Future<void> _onFirebaseUserChanged(User? firebaseUser) async {
    if (firebaseUser == null) {
      state = AuthState.noAutenticado;
      return;
    }
    final repo = ref.read(authRepositoryProvider);
    final usuario = await repo.resolverUsuarioLocal(firebaseUser);
    if (usuario == null) {
      final vinculado = await _intentarVincularConWindows(firebaseUser);
      if (vinculado != null) {
        state = AuthState(status: AuthStatus.autenticado, usuario: vinculado, empresaId: vinculado.empresaId);
        return;
      }
      state = AuthState.requiereOnboarding;
      return;
    }
    await ref.read(usuarioRepositoryProvider).registrarAcceso(usuario.id);
    state = AuthState(status: AuthStatus.autenticado, usuario: usuario, empresaId: usuario.empresaId);
  }

  /// Antes de mandar a un usuario nuevo al onboarding standalone, se intenta
  /// un "handshake" silencioso con Tecno Caja Windows: si esta misma cuenta
  /// de Google (Tecno Caja ID) ya tiene un usuario activo allá, el
  /// dispositivo se vincula automáticamente en vez de crear un negocio
  /// nuevo. Cualquier fallo (sin red, sin match, Windows sin Firebase
  /// configurado) es silencioso -- la mayoría de las instalaciones son
  /// standalone y no deben esperar por esto. Ver VinculacionRepository.
  Future<Usuario?> _intentarVincularConWindows(User firebaseUser) async {
    try {
      final idToken = await firebaseUser.getIdToken();
      if (idToken == null) return null;

      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final infoDispositivo = await ref.read(deviceInfoServiceProvider).obtener();

      final payload = await ref.read(mobileLinkServiceProvider).intentarVincular(
            idToken: idToken,
            deviceId: deviceId,
            deviceName: infoDispositivo.nombreParaMostrar,
            appVersion: infoDispositivo.appVersion,
          );
      if (payload == null) return null;

      final usuarioLocal = await ref.read(vinculacionRepositoryProvider).vincular(
            payload,
            deviceId: deviceId,
            deviceName: infoDispositivo.nombreParaMostrar,
          );
      if (usuarioLocal != null) await _sincronizarCatalogoInicial(usuarioLocal, deviceId);
      return usuarioLocal;
    } catch (e) {
      debugPrint('[AuthController] _intentarVincularConWindows falló: $e');
      return null;
    }
  }

  /// Primer pull de catálogo (productos/clientes/proveedores) justo después
  /// de vincular por primera vez -- sin esto, el usuario recién vinculado ve
  /// la app vacía y tiene que saber que existe un botón de "sincronizar" en
  /// Ajustes. Es best-effort: si falla (sin red en ese instante, etc.) el
  /// login igual se completa: la sincronización manual en Ajustes queda como
  /// respaldo. Solo aplica la primera vez -- si el usuario ya existia
  /// localmente esta funcion nunca se llama (ver _onFirebaseUserChanged e
  /// iniciarSesionLocalPos).
  Future<void> _sincronizarCatalogoInicial(Usuario usuario, String deviceId) async {
    try {
      final sucursales = await ref.read(empresaRepositoryProvider).sucursalesDe(usuario.empresaId);
      if (sucursales.isEmpty) return;
      await ref.read(catalogSyncRepositoryProvider).sincronizarTodo(
            empresaId: usuario.empresaId,
            sucursal: sucursales.first,
            dispositivoId: deviceId,
          );
    } catch (e) {
      debugPrint('[AuthController] _sincronizarCatalogoInicial falló: $e');
    }
  }

  /// Llamado por el wizard de onboarding (Fase 5) al terminar de crear
  /// empresa/sucursal/caja/usuario para esta cuenta de Firebase.
  void onboardingCompletado(Usuario usuario) => _autenticar(usuario);

  /// Login con usuario/contraseña locales del POS (mismo camino que ese
  /// cajero ya usa en Windows) -- NO pasa por Firebase, es un flujo de auth
  /// totalmente separado del que escucha `_onFirebaseUserChanged`. Si ya
  /// existe un Usuario local para ese nombre de usuario (login repetido en
  /// este mismo dispositivo) lo reutiliza en vez de crear empresa/usuario
  /// duplicados -- igual que `_intentarVincularConWindows` hace vía
  /// `resolverUsuarioLocal` antes de llamar a VinculacionRepository.
  Future<void> iniciarSesionLocalPos({required String usuario, required String password}) async {
    final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    final infoDispositivo = await ref.read(deviceInfoServiceProvider).obtener();

    final payload = await ref.read(mobileLinkServiceProvider).iniciarSesionLocal(
          usuario: usuario,
          password: password,
          deviceId: deviceId,
          deviceName: infoDispositivo.nombreParaMostrar,
          appVersion: infoDispositivo.appVersion,
        );

    final usuarioRepo = ref.read(usuarioRepositoryProvider);
    var usuarioLocal = await usuarioRepo.porNombreUsuario(payload.usuario.usuario);
    if (usuarioLocal == null) {
      usuarioLocal = await ref.read(vinculacionRepositoryProvider).vincular(
            payload,
            deviceId: deviceId,
            deviceName: infoDispositivo.nombreParaMostrar,
          );
      if (usuarioLocal != null) await _sincronizarCatalogoInicial(usuarioLocal, deviceId);
    } else {
      await ref.read(secureSessionServiceProvider).guardarTokens(
            accessToken: payload.accessToken,
            refreshToken: payload.refreshToken,
          );
    }
    if (usuarioLocal == null) {
      throw const UnknownAppException(message: 'No se pudo completar el inicio de sesión.');
    }

    await usuarioRepo.registrarAcceso(usuarioLocal.id);
    _autenticar(usuarioLocal);
  }

  void _autenticar(Usuario usuario) {
    state = AuthState(status: AuthStatus.autenticado, usuario: usuario, empresaId: usuario.empresaId);
  }

  void notificarAppPausada() {
    if (state.status == AuthStatus.autenticado) {
      _pausadoEn = DateTime.now();
    }
  }

  void notificarAppReanudada() {
    final actual = state;
    if (actual.status != AuthStatus.autenticado) return;
    final pinActivo = actual.usuario?.pinHash != null && actual.usuario!.pinHash!.isNotEmpty;
    final pausadoEn = _pausadoEn;
    if (pinActivo && pausadoEn != null && DateTime.now().difference(pausadoEn) > _umbralBloqueo) {
      state = actual.copyWith(status: AuthStatus.bloqueado);
    }
    _pausadoEn = null;
  }

  Future<void> desbloquearConPin(String pin) async {
    final usuario = state.usuario;
    if (usuario == null) return;
    final valido = await ref.read(authRepositoryProvider).verificarPin(usuario, pin);
    if (!valido) throw const UnauthorizedException(message: 'PIN incorrecto.');
    state = state.copyWith(status: AuthStatus.autenticado);
  }

  void desbloquearConBiometria() {
    if (state.usuario != null) {
      state = state.copyWith(status: AuthStatus.autenticado);
    }
  }

  Future<void> cerrarSesion() => ref.read(authRepositoryProvider).cerrarSesion();
}

final authControllerProvider = NotifierProvider<AuthController, AuthState>(AuthController.new);
