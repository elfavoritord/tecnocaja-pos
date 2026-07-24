import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:google_sign_in/google_sign_in.dart';

import '../../core/config/env.dart';
import '../../core/errors/app_exception.dart';

/// Envoltorio delgado sobre Firebase Auth + Google Sign-In. No conoce nada
/// de la tabla `usuarios` local -- eso lo resuelve AuthRepository, que es
/// quien decide que hacer con el User de Firebase (crear/vincular Usuario).
class AuthService {
  AuthService({FirebaseAuth? firebaseAuth}) : _auth = firebaseAuth ?? FirebaseAuth.instance;

  final FirebaseAuth _auth;
  bool _googleInicializado = false;

  Stream<User?> get cambiosDeSesion => _auth.authStateChanges();

  User? get usuarioActual => _auth.currentUser;

  Future<User> registrarConCorreo({
    required String correo,
    required String contrasena,
    required String nombreCompleto,
  }) async {
    try {
      final credencial = await _auth.createUserWithEmailAndPassword(email: correo, password: contrasena);
      await credencial.user?.updateDisplayName(nombreCompleto);
      final usuario = credencial.user;
      if (usuario == null) throw const UnknownAppException(message: 'No se pudo crear la cuenta.');
      return usuario;
    } on FirebaseAuthException catch (e) {
      throw _mapFirebaseError(e);
    }
  }

  Future<User> iniciarSesionConCorreo({required String correo, required String contrasena}) async {
    try {
      final credencial = await _auth.signInWithEmailAndPassword(email: correo, password: contrasena);
      final usuario = credencial.user;
      if (usuario == null) throw const UnknownAppException(message: 'No se pudo iniciar sesion.');
      return usuario;
    } on FirebaseAuthException catch (e) {
      throw _mapFirebaseError(e);
    }
  }

  Future<void> enviarRecuperacionContrasena(String correo) async {
    try {
      await _auth.sendPasswordResetEmail(email: correo);
    } on FirebaseAuthException catch (e) {
      throw _mapFirebaseError(e);
    }
  }

  Future<User> iniciarSesionConGoogle() async {
    try {
      final googleSignIn = GoogleSignIn.instance;
      if (!_googleInicializado) {
        final clientId = Env.googleServerClientId.isEmpty ? null : Env.googleServerClientId;
        await googleSignIn.initialize(
          // Android usa serverClientId (audiencia del idToken); en el
          // navegador el plugin ignora serverClientId por completo y exige
          // clientId -- Firebase provisiona un solo "Web client ID" valido
          // para ambos usos, asi que se reutiliza el mismo valor.
          clientId: kIsWeb ? clientId : null,
          serverClientId: kIsWeb ? null : clientId,
        );
        _googleInicializado = true;
      }

      final cuenta = await googleSignIn.authenticate();
      final idToken = cuenta.authentication.idToken;
      if (idToken == null) {
        throw const UnauthorizedException(message: 'Google no devolvio un token de identidad valido.');
      }

      String? accessToken;
      try {
        final autorizacion = await cuenta.authorizationClient.authorizationForScopes(['email']) ??
            await cuenta.authorizationClient.authorizeScopes(['email']);
        accessToken = autorizacion.accessToken;
      } catch (_) {
        accessToken = null; // el idToken solo ya es suficiente para Firebase
      }

      final credencial = GoogleAuthProvider.credential(idToken: idToken, accessToken: accessToken);
      final resultado = await _auth.signInWithCredential(credencial);
      final usuario = resultado.user;
      if (usuario == null) throw const UnknownAppException(message: 'No se pudo iniciar sesion con Google.');
      return usuario;
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) {
        throw const UnauthorizedException(message: 'Inicio de sesion con Google cancelado.');
      }
      throw UnknownAppException(message: 'Error de Google Sign-In: ${e.description ?? e.code}', cause: e);
    } on FirebaseAuthException catch (e) {
      throw _mapFirebaseError(e);
    }
  }

  Future<void> cerrarSesion() async {
    await _auth.signOut();
    try {
      await GoogleSignIn.instance.signOut();
    } catch (_) {
      // Si Google nunca se inicializo (usuario que solo usa correo), ignorar.
    }
  }

  Future<void> eliminarCuenta() async {
    final usuario = _auth.currentUser;
    if (usuario == null) return;
    try {
      await usuario.delete();
    } on FirebaseAuthException catch (e) {
      throw _mapFirebaseError(e);
    }
  }

  AppException _mapFirebaseError(FirebaseAuthException e) {
    final mensaje = switch (e.code) {
      'user-not-found' => 'No existe una cuenta con ese correo.',
      'wrong-password' => 'Contrasena incorrecta.',
      'invalid-credential' => 'Correo o contrasena incorrectos.',
      'email-already-in-use' => 'Ya existe una cuenta con ese correo.',
      'weak-password' => 'La contrasena es muy debil.',
      'invalid-email' => 'Correo invalido.',
      'user-disabled' => 'Esta cuenta fue deshabilitada.',
      'too-many-requests' => 'Demasiados intentos. Intenta mas tarde.',
      'requires-recent-login' => 'Por seguridad, vuelve a iniciar sesion para continuar.',
      'network-request-failed' => 'Sin conexion a internet.',
      _ => e.message ?? 'Error de autenticacion.',
    };
    return UnauthorizedException(message: mensaje, cause: e);
  }
}
