import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../domain/entities/usuario.dart';
import '../repositories/empresa_repository.dart';
import '../repositories/caja_repository.dart';
import '../repositories/usuario_repository.dart';
import '../cloud/cloud_functions_service.dart';
import '../sync/catalog_sync_repository.dart';
import '../sync/cloud_business_sync_repository.dart';
import '../sync/mobile_link_service.dart';
import '../sync/sales_sync_service.dart';
import '../sync/vinculacion_repository.dart';
import 'auth_repository.dart';

enum AuthStatus {
  cargando,
  noAutenticado,
  requiereOnboarding,
  bloqueado,
  autenticado
}

class AuthState {
  const AuthState({required this.status, this.usuario, this.empresaId});

  final AuthStatus status;
  final Usuario? usuario;
  final String? empresaId;

  static const cargando = AuthState(status: AuthStatus.cargando);
  static const noAutenticado = AuthState(status: AuthStatus.noAutenticado);
  static const requiereOnboarding =
      AuthState(status: AuthStatus.requiereOnboarding);

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
      final vinculadoDesdeNube = await _intentarVincularDesdeNube(firebaseUser);
      if (vinculadoDesdeNube != null) {
        state = AuthState(
          status: AuthStatus.autenticado,
          usuario: vinculadoDesdeNube,
          empresaId: vinculadoDesdeNube.empresaId,
        );
        return;
      }
      final vinculado = await _intentarVincularConWindows(firebaseUser);
      if (vinculado != null) {
        state = AuthState(
            status: AuthStatus.autenticado,
            usuario: vinculado,
            empresaId: vinculado.empresaId);
        return;
      }
      state = AuthState.requiereOnboarding;
      return;
    }
    await ref.read(usuarioRepositoryProvider).registrarAcceso(usuario.id);
    final usuarioSincronizado =
        await _sincronizarEmpresaVinculadaDesdeNube(usuario);
    state = AuthState(
        status: AuthStatus.autenticado,
        usuario: usuarioSincronizado,
        empresaId: usuarioSincronizado.empresaId);
  }

  Future<Usuario> _sincronizarEmpresaVinculadaDesdeNube(Usuario usuario) async {
    try {
      final empresa =
          await ref.read(empresaRepositoryProvider).porId(usuario.empresaId);
      final remoteBusinessId = empresa?.remotoId;
      if (remoteBusinessId == null || remoteBusinessId.isEmpty) return usuario;
      final reconciliado = await ref
          .read(vinculacionRepositoryProvider)
          .reconciliarEmpresaUsuario(usuario, remoteBusinessId);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final bootstrap =
          await ref.read(cloudFunctionsServiceProvider).getMyCompanyBootstrap();
      await ref
          .read(vinculacionRepositoryProvider)
          .importarProductosDesdeBootstrap(
            bootstrap['products'] as List? ?? const [],
            localBusinessId: reconciliado.empresaId,
            deviceId: deviceId,
          );
      await ref.read(cloudBusinessSyncRepositoryProvider).pushLocalProducts(
            localBusinessId: reconciliado.empresaId,
            remoteBusinessId: remoteBusinessId,
          );
      await ref.read(cloudBusinessSyncRepositoryProvider).pushLocalCustomers(
            localBusinessId: reconciliado.empresaId,
            remoteBusinessId: remoteBusinessId,
          );
      await ref
          .read(salesSyncServiceProvider)
          .syncPendingSales(reconciliado.empresaId);
      await ref.read(cloudBusinessSyncRepositoryProvider).pullInitial(
            localBusinessId: reconciliado.empresaId,
            remoteBusinessId: remoteBusinessId,
            localUserId: reconciliado.id,
            deviceId: deviceId,
          );
      return reconciliado;
    } catch (e) {
      debugPrint('[AuthController] actualización Firestore falló: $e');
      return usuario;
    }
  }

  Future<Usuario?> _intentarVincularDesdeNube(User firebaseUser) async {
    try {
      final bootstrap =
          await ref.read(cloudFunctionsServiceProvider).getMyCompanyBootstrap();
      if (bootstrap['linked'] != true) return null;
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final usuario =
          await ref.read(vinculacionRepositoryProvider).vincularPosDesdeNube(
                bootstrap,
                firebaseUid: firebaseUser.uid,
                deviceId: deviceId,
              );
      if (usuario != null) {
        try {
          await ref
              .read(vinculacionRepositoryProvider)
              .importarProductosDesdeBootstrap(
                bootstrap['products'] as List? ?? const [],
                localBusinessId: usuario.empresaId,
                deviceId: deviceId,
              );
          await ref
              .read(salesSyncServiceProvider)
              .syncPendingSales(usuario.empresaId);
          await ref.read(cloudBusinessSyncRepositoryProvider).pullInitial(
                localBusinessId: usuario.empresaId,
                remoteBusinessId: bootstrap['businessId'].toString(),
                localUserId: usuario.id,
                deviceId: deviceId,
              );
        } catch (e) {
          debugPrint('[AuthController] pull inicial desde Firestore falló: $e');
        }
      }
      return usuario;
    } catch (e) {
      debugPrint('[AuthController] _intentarVincularDesdeNube falló: $e');
      return null;
    }
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

      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final infoDispositivo =
          await ref.read(deviceInfoServiceProvider).obtener();

      final payload =
          await ref.read(mobileLinkServiceProvider).intentarVincular(
                idToken: idToken,
                deviceId: deviceId,
                deviceName: infoDispositivo.nombreParaMostrar,
                appVersion: infoDispositivo.appVersion,
              );
      if (payload == null) return null;

      final usuarioLocal =
          await ref.read(vinculacionRepositoryProvider).vincular(
                payload,
                deviceId: deviceId,
                deviceName: infoDispositivo.nombreParaMostrar,
              );
      if (usuarioLocal != null) {
        await _sincronizarCatalogoInicial(usuarioLocal, deviceId);
      }
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
  Future<void> _sincronizarCatalogoInicial(
      Usuario usuario, String deviceId) async {
    try {
      final sucursales = await ref
          .read(empresaRepositoryProvider)
          .sucursalesDe(usuario.empresaId);
      if (sucursales.isEmpty) return;
      await ref.read(catalogSyncRepositoryProvider).sincronizarTodo(
            empresaId: usuario.empresaId,
            sucursal: sucursales.first,
            dispositivoId: deviceId,
          );
      final empresa =
          await ref.read(empresaRepositoryProvider).porId(usuario.empresaId);
      if (empresa?.remotoId?.isNotEmpty == true) {
        await ref.read(cloudBusinessSyncRepositoryProvider).pushLocalProducts(
              localBusinessId: usuario.empresaId,
              remoteBusinessId: empresa!.remotoId!,
            );
        await ref.read(cloudBusinessSyncRepositoryProvider).pushLocalCustomers(
              localBusinessId: usuario.empresaId,
              remoteBusinessId: empresa.remotoId!,
            );
      }
    } catch (e) {
      debugPrint('[AuthController] _sincronizarCatalogoInicial falló: $e');
    }
  }

  /// Llamado por el wizard de onboarding (Fase 5) al terminar de crear
  /// empresa/sucursal/caja/usuario para esta cuenta de Firebase.
  void onboardingCompletado(Usuario usuario) => _autenticar(usuario);

  /// Reintento explícito para sesiones que llegaron al onboarding antes de
  /// que el perfil del POS terminara de publicarse en Firebase.
  Future<bool> buscarEmpresaExistenteEnNube() async {
    final firebaseUser = ref.read(authRepositoryProvider).usuarioFirebaseActual;
    if (firebaseUser == null) return false;
    final usuario = await _intentarVincularDesdeNube(firebaseUser);
    if (usuario == null) return false;
    _autenticar(usuario);
    return true;
  }

  /// Reintenta la vinculación con Windows para una cuenta que quedó atrapada
  /// en un negocio local standalone (ver
  /// VinculacionRepository.borrarDatosLocalesParaReintentar). Borra todos los
  /// datos locales de este dispositivo y repite el mismo handshake que
  /// `_onFirebaseUserChanged` intenta la primera vez. Si Windows sigue sin
  /// responder o sin match, el usuario queda en onboarding (nunca con una
  /// referencia a datos ya borrados). Llamado desde Ajustes > Sincronización
  /// -- la UI debe confirmar con el usuario antes, es destructivo.
  Future<bool> reintentarVinculacionConWindows() async {
    final firebaseUser = ref.read(authRepositoryProvider).usuarioFirebaseActual;
    if (firebaseUser == null) return false;

    await ref
        .read(vinculacionRepositoryProvider)
        .borrarDatosLocalesParaReintentar();

    final vinculado = await _intentarVincularConWindows(firebaseUser);
    if (vinculado == null) {
      state = AuthState.requiereOnboarding;
      return false;
    }
    state = AuthState(
        status: AuthStatus.autenticado,
        usuario: vinculado,
        empresaId: vinculado.empresaId);
    return true;
  }

  /// Login con usuario/contraseña locales del POS (mismo camino que ese
  /// cajero ya usa en Windows) -- NO pasa por Firebase, es un flujo de auth
  /// totalmente separado del que escucha `_onFirebaseUserChanged`. Si ya
  /// existe un Usuario local para ese nombre de usuario (login repetido en
  /// este mismo dispositivo) lo reutiliza en vez de crear empresa/usuario
  /// duplicados -- igual que `_intentarVincularConWindows` hace vía
  /// `resolverUsuarioLocal` antes de llamar a VinculacionRepository.
  Future<void> iniciarSesionLocalPos(
      {required String usuario, required String password}) async {
    final deviceId =
        await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
    final infoDispositivo = await ref.read(deviceInfoServiceProvider).obtener();

    final payload =
        await ref.read(mobileLinkServiceProvider).iniciarSesionLocal(
              usuario: usuario,
              password: password,
              deviceId: deviceId,
              deviceName: infoDispositivo.nombreParaMostrar,
              appVersion: infoDispositivo.appVersion,
            );

    final usuarioRepo = ref.read(usuarioRepositoryProvider);
    var usuarioLocal =
        await usuarioRepo.porNombreUsuario(payload.usuario.usuario);
    if (usuarioLocal == null) {
      usuarioLocal = await ref.read(vinculacionRepositoryProvider).vincular(
            payload,
            deviceId: deviceId,
            deviceName: infoDispositivo.nombreParaMostrar,
          );
    } else {
      await ref.read(secureSessionServiceProvider).guardarTokens(
            accessToken: payload.accessToken,
            refreshToken: payload.refreshToken,
          );
    }
    if (usuarioLocal == null) {
      throw const UnknownAppException(
          message: 'No se pudo completar el inicio de sesión.');
    }

    // Un usuario existente también necesita refrescar el catálogo. Antes solo
    // se hacía al crear el usuario local por primera vez, por lo que los
    // cajeros recurrentes entraban con productos vacíos en un navegador o
    // dispositivo nuevo. Es best-effort y nunca borra el catálogo offline si
    // Windows no está disponible.
    await _sincronizarCatalogoInicial(usuarioLocal, deviceId);
    await usuarioRepo.registrarAcceso(usuarioLocal.id);
    _autenticar(usuarioLocal);
  }

  void _autenticar(Usuario usuario) {
    state = AuthState(
        status: AuthStatus.autenticado,
        usuario: usuario,
        empresaId: usuario.empresaId);
  }

  void notificarAppPausada() {
    if (state.status == AuthStatus.autenticado) {
      _pausadoEn = DateTime.now();
    }
  }

  void notificarAppReanudada() {
    final actual = state;
    if (actual.status != AuthStatus.autenticado) return;
    final pinActivo =
        actual.usuario?.pinHash != null && actual.usuario!.pinHash!.isNotEmpty;
    final pausadoEn = _pausadoEn;
    if (pinActivo &&
        pausadoEn != null &&
        DateTime.now().difference(pausadoEn) > _umbralBloqueo) {
      state = actual.copyWith(status: AuthStatus.bloqueado);
    }
    _pausadoEn = null;
  }

  Future<void> desbloquearConPin(String pin) async {
    final usuario = state.usuario;
    if (usuario == null) return;
    final valido =
        await ref.read(authRepositoryProvider).verificarPin(usuario, pin);
    if (!valido) throw const UnauthorizedException(message: 'PIN incorrecto.');
    state = state.copyWith(status: AuthStatus.autenticado);
  }

  void desbloquearConBiometria() {
    if (state.usuario != null) {
      state = state.copyWith(status: AuthStatus.autenticado);
    }
  }

  Future<bool> cerrarSesion() async {
    final usuario = state.usuario;
    if (usuario != null) {
      final sesion = await ref
          .read(cajaRepositoryProvider)
          .sesionAbiertaDeUsuario(usuario.id);
      if (sesion != null) return false;
    }
    await ref.read(authRepositoryProvider).cerrarSesion();
    return true;
  }
}

final authControllerProvider =
    NotifierProvider<AuthController, AuthState>(AuthController.new);
