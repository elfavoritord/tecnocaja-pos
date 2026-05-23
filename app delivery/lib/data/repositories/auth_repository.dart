import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/repartidor_model.dart';

class AuthDeliveryException implements Exception {
  final String message;
  const AuthDeliveryException(this.message);
  @override
  String toString() => message;
}

class AuthDeliveryRepository {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  User? get currentUser => _auth.currentUser;

  Stream<User?> get authStateChanges => _auth.authStateChanges();

  Future<RepartidorModel> signIn(String email, String password) async {
    try {
      final cred = await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      final repartidor = await _getRepartidor(cred.user!.uid);
      if (!repartidor.activo) {
        await _auth.signOut();
        throw const AuthDeliveryException(
          'Tu cuenta está inactiva. Contacta al administrador.',
        );
      }
      return repartidor;
    } on AuthDeliveryException {
      rethrow;
    } on FirebaseAuthException catch (e) {
      throw AuthDeliveryException(_mapFirebaseError(e.code));
    }
  }

  Future<RepartidorModel> _getRepartidor(String uid) async {
    final doc = await _db.collection('repartidores').doc(uid).get();
    if (!doc.exists) {
      await _auth.signOut();
      throw const AuthDeliveryException(
        'Tu usuario no está registrado como repartidor en este sistema.',
      );
    }
    final repartidor = RepartidorModel.fromDoc(doc);
    if (repartidor.rol != 'repartidor') {
      await _auth.signOut();
      throw const AuthDeliveryException(
        'Esta app es exclusiva para repartidores.',
      );
    }
    return repartidor;
  }

  Future<RepartidorModel?> getCurrentRepartidor() async {
    final user = _auth.currentUser;
    if (user == null) return null;
    try {
      return await _getRepartidor(user.uid);
    } catch (_) {
      return null;
    }
  }

  Future<void> signOut() => _auth.signOut();

  String _mapFirebaseError(String code) {
    switch (code) {
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
      case 'invalid-login-credentials':
        return 'Correo o contraseña incorrectos.';
      case 'too-many-requests':
        return 'Demasiados intentos. Intenta más tarde.';
      case 'network-request-failed':
        return 'Sin conexión a internet.';
      case 'user-disabled':
        return 'Esta cuenta fue desactivada.';
      default:
        return 'Error al iniciar sesión ($code).';
    }
  }
}
