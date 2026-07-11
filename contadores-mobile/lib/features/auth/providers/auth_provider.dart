import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../../data/models/user_model.dart';
import '../../../data/services/auth_service.dart';

// ── Servicios ──────────────────────────────────────────────────────────────
final authServiceProvider = Provider<AuthService>((ref) => AuthService());

// ── Estado de autenticación Firebase ──────────────────────────────────────
final authStateProvider = StreamProvider<User?>((ref) {
  return ref.watch(authServiceProvider).authStateChanges;
});

// ── Perfil del usuario actual ──────────────────────────────────────────────
final userProfileProvider = StateNotifierProvider<UserProfileNotifier, AsyncValue<UserModel?>>((ref) {
  return UserProfileNotifier(ref.watch(authServiceProvider));
});

class UserProfileNotifier extends StateNotifier<AsyncValue<UserModel?>> {
  final AuthService _service;

  UserProfileNotifier(this._service) : super(const AsyncValue.loading()) {
    _init();
  }

  Future<void> _init() async {
    final cached = await _service.getCachedProfile();
    if (cached != null) {
      state = AsyncValue.data(cached);
    } else {
      state = const AsyncValue.data(null);
    }
  }

  Future<void> signIn(String email, String password) async {
    state = const AsyncValue.loading();
    try {
      final profile = await _service.signIn(email, password);
      state = AsyncValue.data(profile);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      rethrow;
    }
  }

  Future<void> refresh() async {
    try {
      final profile = await _service.fetchProfile();
      state = AsyncValue.data(profile);
    } catch (_) {}
  }

  Future<void> signOut() async {
    await _service.signOut();
    state = const AsyncValue.data(null);
  }

  Future<void> updateProfile(Map<String, dynamic> updates) async {
    final current = state.valueOrNull;
    if (current == null) return;
    await _service.updateProfile(current.contadorDocId, updates);
    await refresh();
  }

  UserModel? get profile => state.valueOrNull;
}

// ── Notifier de login ──────────────────────────────────────────────────────
class LoginState {
  final bool isLoading;
  final String? error;
  final bool rememberMe;

  const LoginState({
    this.isLoading = false,
    this.error,
    this.rememberMe = true,
  });

  LoginState copyWith({bool? isLoading, String? error, bool? rememberMe, bool clearError = false}) =>
      LoginState(
        isLoading: isLoading ?? this.isLoading,
        error: clearError ? null : (error ?? this.error),
        rememberMe: rememberMe ?? this.rememberMe,
      );
}

final loginProvider = StateNotifierProvider<LoginNotifier, LoginState>((ref) {
  return LoginNotifier(ref);
});

class LoginNotifier extends StateNotifier<LoginState> {
  final Ref _ref;

  LoginNotifier(this._ref) : super(const LoginState());

  Future<void> signIn(String email, String password) async {
    state = state.copyWith(isLoading: true, clearError: true);
    try {
      await _ref.read(userProfileProvider.notifier).signIn(email, password);
      if (state.rememberMe) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('saved_email', email);
      }
      state = state.copyWith(isLoading: false);
    } on Exception catch (e) {
      state = state.copyWith(isLoading: false, error: _parseError(e.toString()));
    } catch (e) {
      state = state.copyWith(isLoading: false, error: _parseError(e.toString()));
    }
  }

  void toggleRememberMe() {
    state = state.copyWith(rememberMe: !state.rememberMe);
  }

  void clearError() {
    state = state.copyWith(clearError: true);
  }

  String _parseError(String raw) {
    if (raw.contains('user-not-found') || raw.contains('wrong-password') || raw.contains('invalid-credential')) {
      return 'Correo o contraseña incorrectos.';
    }
    if (raw.contains('too-many-requests')) {
      return 'Demasiados intentos. Espera unos minutos.';
    }
    if (raw.contains('network-request-failed')) {
      return 'Sin conexión a internet.';
    }
    if (raw.contains('no tiene acceso') || raw.contains('no tiene')) {
      return raw.replaceAll('Exception: ', '');
    }
    return raw.replaceAll('Exception: ', '');
  }
}

// ── Recuperar contraseña ───────────────────────────────────────────────────
class ForgotPasswordState {
  final bool isLoading;
  final String? error;
  final bool sent;

  const ForgotPasswordState({this.isLoading = false, this.error, this.sent = false});

  ForgotPasswordState copyWith({bool? isLoading, String? error, bool? sent, bool clearError = false}) =>
      ForgotPasswordState(
        isLoading: isLoading ?? this.isLoading,
        error: clearError ? null : (error ?? this.error),
        sent: sent ?? this.sent,
      );
}

final forgotPasswordProvider = StateNotifierProvider.autoDispose<ForgotPasswordNotifier, ForgotPasswordState>((ref) {
  return ForgotPasswordNotifier(ref.watch(authServiceProvider));
});

class ForgotPasswordNotifier extends StateNotifier<ForgotPasswordState> {
  final AuthService _service;

  ForgotPasswordNotifier(this._service) : super(const ForgotPasswordState());

  Future<void> send(String email) async {
    state = state.copyWith(isLoading: true, clearError: true);
    try {
      await _service.sendPasswordResetEmail(email);
      state = state.copyWith(isLoading: false, sent: true);
    } catch (e) {
      state = state.copyWith(isLoading: false, error: 'No se pudo enviar el correo. Verifica el email.');
    }
  }
}
