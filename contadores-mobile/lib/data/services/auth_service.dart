import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'dart:convert';
import '../models/user_model.dart';

class AuthService {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final LocalAuthentication _localAuth = LocalAuthentication();

  static const _keyProfile = 'contadores_user_profile';
  static const _keyBiometrics = 'contadores_biometrics_enabled';
  static const _keyPin = 'contadores_pin';

  Stream<User?> get authStateChanges => _auth.authStateChanges();
  User? get currentUser => _auth.currentUser;

  // ── Login ──────────────────────────────────────────────────────────────────
  Future<UserModel> signIn(String email, String password) async {
    final cred = await _auth.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    final user = cred.user!;
    return _fetchAndCacheProfile(user);
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  Future<void> signOut() async {
    await _auth.signOut();
    await _storage.delete(key: _keyProfile);
  }

  // ── Recuperar contraseña ───────────────────────────────────────────────────
  Future<void> sendPasswordResetEmail(String email) async {
    await _auth.sendPasswordResetEmail(email: email.trim());
  }

  // ── Perfil ─────────────────────────────────────────────────────────────────
  Future<UserModel> fetchProfile() async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('No hay sesión activa.');
    return _fetchAndCacheProfile(user);
  }

  Future<UserModel> _fetchAndCacheProfile(User user) async {
    final uid = user.uid;
    final adminDoc = await _db.collection('platform_admins').doc(uid).get();

    if (!adminDoc.exists) {
      throw Exception('Esta cuenta no tiene acceso a Tecno Caja Contadores.');
    }

    final adminData = adminDoc.data()!;
    if (adminData['status'] != 'active') {
      throw Exception('Esta cuenta está inactiva o suspendida.');
    }

    UserModel profile;

    if (adminData['role'] == 'colaborador') {
      final parentId = adminData['parentContadorId'] as String?;
      if (parentId == null) throw Exception('Colaborador sin contador principal.');

      final results = await Future.wait([
        _db.collection('contadores').doc(parentId).collection('colaboradores').doc(uid).get(),
        _db.collection('contadores').doc(parentId).get(),
      ]);

      final colabDoc = results[0];
      final parentDoc = results[1];
      if (!colabDoc.exists) throw Exception('Perfil de colaborador no encontrado.');

      final colabData = colabDoc.data()!;
      final parentData = parentDoc.data() ?? {};

      profile = UserModel(
        uid: uid,
        contadorDocId: parentId,
        email: user.email ?? '',
        fullName: colabData['nombre'] as String? ?? '',
        nombreFirma: parentData['nombre_firma'] as String? ?? '',
        responsable: colabData['nombre'] as String? ?? '',
        rnc: colabData['rnc'] as String? ?? parentData['rnc'] as String? ?? '',
        telefono: colabData['telefono'] as String? ?? '',
        correo: colabData['email'] as String? ?? user.email ?? '',
        logoUrl: parentData['logo_url'] as String?,
        isColaborador: true,
        colaboradorId: uid,
        tipo: colabData['tipo'] as String? ?? 'dependiente',
        estado: colabData['estado'] as String?,
        clientesAsignados: List<String>.from(colabData['clientesAsignados'] as List? ?? []),
        parentContadorId: parentId,
      );
    } else {
      if (adminData['role'] != 'contador_asociado') {
        throw Exception('Esta cuenta no tiene acceso como contador.');
      }

      final snap = await _db
          .collection('contadores')
          .where('firebase_uid', isEqualTo: uid)
          .limit(1)
          .get();

      if (snap.docs.isEmpty) {
        throw Exception('Perfil de contador no encontrado.');
      }

      final contDoc = snap.docs.first;
      final contData = contDoc.data();

      if ((contData['estado'] as String? ?? '').toLowerCase() == 'suspendido') {
        throw Exception('Tu firma contable está suspendida.');
      }

      profile = UserModel(
        uid: uid,
        contadorDocId: contDoc.id,
        email: user.email ?? '',
        fullName: adminData['fullName'] as String? ?? contData['responsable'] as String? ?? '',
        nombreFirma: contData['nombre_firma'] as String? ?? '',
        responsable: contData['responsable'] as String? ?? '',
        rnc: contData['rnc'] as String? ?? '',
        telefono: contData['telefono'] as String? ?? '',
        correo: contData['correo'] as String? ?? user.email ?? '',
        logoUrl: contData['logo_url'] as String?,
        isColaborador: false,
      );
    }

    await _cacheProfile(profile);
    _db.collection('platform_admins').doc(uid).update({'lastLoginAt': FieldValue.serverTimestamp()}).ignore();
    return profile;
  }

  Future<void> _cacheProfile(UserModel profile) async {
    await _storage.write(key: _keyProfile, value: jsonEncode(profile.toMap()));
  }

  Future<UserModel?> getCachedProfile() async {
    final json = await _storage.read(key: _keyProfile);
    if (json == null) return null;
    try {
      final map = jsonDecode(json) as Map<String, dynamic>;
      return UserModel.fromMap(map['uid'] as String, map);
    } catch (_) {
      return null;
    }
  }

  // ── Actualizar perfil ──────────────────────────────────────────────────────
  Future<void> updateProfile(String contadorDocId, Map<String, dynamic> updates) async {
    updates['updated_at'] = FieldValue.serverTimestamp();
    await _db.collection('contadores').doc(contadorDocId).update(updates);
  }

  // ── Biometría ──────────────────────────────────────────────────────────────
  Future<bool> isBiometricsAvailable() async {
    final canCheck = await _localAuth.canCheckBiometrics;
    final isSupported = await _localAuth.isDeviceSupported();
    return canCheck && isSupported;
  }

  Future<bool> authenticateWithBiometrics() async {
    try {
      return await _localAuth.authenticate(
        localizedReason: 'Verifica tu identidad para acceder a Tecno Caja Contadores',
        options: const AuthenticationOptions(
          biometricOnly: false,
          stickyAuth: true,
        ),
      );
    } catch (_) {
      return false;
    }
  }

  Future<bool> isBiometricsEnabled() async {
    final val = await _storage.read(key: _keyBiometrics);
    return val == 'true';
  }

  Future<void> setBiometricsEnabled(bool enabled) async {
    await _storage.write(key: _keyBiometrics, value: enabled.toString());
  }

  // ── PIN ────────────────────────────────────────────────────────────────────
  Future<bool> hasPin() async {
    final pin = await _storage.read(key: _keyPin);
    return pin != null && pin.isNotEmpty;
  }

  Future<void> setPin(String pin) async {
    await _storage.write(key: _keyPin, value: pin);
  }

  Future<bool> verifyPin(String pin) async {
    final stored = await _storage.read(key: _keyPin);
    return stored == pin;
  }

  Future<void> removePin() async {
    await _storage.delete(key: _keyPin);
  }
}
