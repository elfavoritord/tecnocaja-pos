import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../models/user_model.dart';
import '../services/pos_session_service.dart';

class AuthAccessException implements Exception {
  final String message;
  const AuthAccessException(this.message);

  @override
  String toString() => message;
}

class AuthRepository {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  final Map<String, UserModel> _profileCache = {};
  CollectionReference<Map<String, dynamic>> get _users =>
      _db.collection('users');

  Stream<User?> get authStateChanges => _auth.authStateChanges();

  // ─── Lectura única del perfil ─────────────────────────────────────────────

  Future<UserModel?> getUserProfile(String uid, {String? email}) async {
    final resolved = await _resolveUserProfile(uid, email: email);
    final profile = resolved?.profile;
    if (profile != null) {
      _profileCache[uid] = profile;
      return profile;
    }
    return _profileCache[uid];
  }

  // ─── Stream del perfil (para el provider reactivo) ────────────────────────

  Stream<UserModel?> watchUserProfile(String uid, {String? email}) async* {
    try {
      final resolved = await _resolveUserProfile(uid, email: email);
      if (resolved == null) {
        yield _profileCache[uid];
        return;
      }

      _profileCache[uid] = resolved.profile;
      yield resolved.profile;

      await for (final doc in resolved.reference.snapshots()) {
        if (doc.exists) {
          final profile = UserModel.fromFirestore(doc);
          _profileCache[uid] = profile;
          yield profile;
          continue;
        }

        final fallback = await _resolveUserProfile(uid, email: email);
        final profile = fallback?.profile ?? _profileCache[uid];
        if (profile != null) {
          _profileCache[uid] = profile;
        }
        yield profile;
      }
    } catch (_) {
      yield await getUserProfile(uid, email: email) ?? _profileCache[uid];
    }
  }

  // ─── Autenticación ────────────────────────────────────────────────────────

  Future<void> signIn(String email, String password) async {
    // 1. Autenticar con Firebase Auth
    await _auth.signInWithEmailAndPassword(email: email, password: password);

    // 2. Verificar que el usuario tiene perfil y está activo en Firestore
    //    (ya NO se conecta al servidor HTTP — todo es Firestore)
    try {
      await ensureCurrentUserHasAccess();
    } on AuthAccessException catch (error) {
      if (_shouldTryPosRecovery(error)) {
        try {
          await PosSessionService.instance.ensureSession(forceRefresh: true);
          await ensureCurrentUserHasAccess();
          return;
        } catch (recoveryError, stackTrace) {
          if (_auth.currentUser != null) {
            await _auth.signOut();
          }
          Error.throwWithStackTrace(recoveryError, stackTrace);
        }
      }

      if (_auth.currentUser != null) {
        await _auth.signOut();
      }
      rethrow;
    } catch (error) {
      if (_auth.currentUser != null) {
        await _auth.signOut();
      }
      rethrow;
    }
  }

  Future<void> signOut() async {
    _profileCache.clear();
    await _auth.signOut();
  }

  Future<void> sendPasswordReset(String email) async {
    await _auth.sendPasswordResetEmail(email: email);
  }

  Future<UserModel> ensureCurrentUserHasAccess() async {
    final user = _auth.currentUser;
    if (user == null) {
      throw const AuthAccessException('No hay una sesión activa.');
    }

    final profile = await getUserProfile(user.uid, email: user.email);

    if (profile == null) {
      throw const AuthAccessException(
        'Tu cuenta no está registrada en el sistema. '
        'Asegúrate de que el usuario tiene correo y '
        'contraseña de al menos 6 caracteres.',
      );
    }

    if (!profile.isActive) {
      throw const AuthAccessException(
        'Tu usuario está inactivo en el sistema. '
        'Pide acceso a un administrador.',
      );
    }

    return profile;
  }

  User? get currentUser => _auth.currentUser;

  UserModel? getCachedProfile(String uid) => _profileCache[uid];

  Future<_ResolvedUserProfile?> _resolveUserProfile(
    String uid, {
    String? email,
  }) async {
    final directDoc = await _getUserDocumentById(uid);
    if (directDoc != null) {
      return _ResolvedUserProfile(
        reference: directDoc.reference,
        profile: UserModel.fromFirestore(directDoc),
      );
    }

    final emailDoc = await _findUserDocumentByEmail(email);
    if (emailDoc == null) return null;

    final linkedDoc = await _ensureUidBackedProfile(
      uid: uid,
      email: email,
      sourceDoc: emailDoc,
    );

    return _ResolvedUserProfile(
      reference: linkedDoc.reference,
      profile: UserModel.fromFirestore(linkedDoc),
    );
  }

  Future<DocumentSnapshot<Map<String, dynamic>>?> _getUserDocumentById(
    String uid,
  ) async {
    try {
      final doc = await _users.doc(uid).get();
      if (doc.exists) return doc;
    } catch (_) {
      // Ignora y permite fallback por email.
    }
    return null;
  }

  Future<DocumentSnapshot<Map<String, dynamic>>?> _findUserDocumentByEmail(
    String? email,
  ) async {
    final rawEmail = (email ?? '').trim();
    final normalizedEmail = rawEmail.toLowerCase();
    if (normalizedEmail.isEmpty) return null;

    const fields = ['email', 'emailLower', 'correo', 'correoLower', 'mail'];
    final candidateValues = <String>{rawEmail, normalizedEmail}
      ..removeWhere((value) => value.trim().isEmpty);

    for (final field in fields) {
      for (final value in candidateValues) {
        try {
          final snapshot = await _users
              .where(field, isEqualTo: value)
              .limit(1)
              .get();
          if (snapshot.docs.isNotEmpty) {
            return snapshot.docs.first;
          }
        } catch (_) {
          // Reglas pueden bloquear queries puntuales.
        }
      }
    }

    try {
      final snapshot = await _users.limit(200).get();
      for (final doc in snapshot.docs) {
        final data = doc.data();
        final candidates = [
          data['email'],
          data['emailLower'],
          data['correo'],
          data['correoLower'],
          data['mail'],
        ];
        final hasMatch = candidates.any(
          (value) => value?.toString().trim().toLowerCase() == normalizedEmail,
        );
        if (hasMatch) {
          return doc;
        }
      }
    } catch (_) {
      // Si tampoco se puede listar, se devuelve null.
    }

    return null;
  }

  Future<DocumentSnapshot<Map<String, dynamic>>> _ensureUidBackedProfile({
    required String uid,
    required String? email,
    required DocumentSnapshot<Map<String, dynamic>> sourceDoc,
  }) async {
    if (sourceDoc.id == uid) return sourceDoc;

    final sourceData = sourceDoc.data() ?? <String, dynamic>{};
    final mergedData = <String, dynamic>{
      ...sourceData,
      'email': _normalizedEmailFrom(email, sourceData),
      'emailLower': _normalizedEmailFrom(email, sourceData),
      'firebaseUid': uid,
    };

    try {
      await _users.doc(uid).set(mergedData, SetOptions(merge: true));
      final uidDoc = await _users.doc(uid).get();
      if (uidDoc.exists) {
        return uidDoc;
      }
    } catch (_) {
      // Si no hay permisos de escritura, seguimos usando el doc original.
    }

    return sourceDoc;
  }

  String _normalizedEmailFrom(String? authEmail, Map<String, dynamic> source) {
    final values = [
      authEmail,
      source['email'],
      source['emailLower'],
      source['correo'],
      source['correoLower'],
      source['mail'],
    ];
    for (final value in values) {
      final normalized = value?.toString().trim().toLowerCase() ?? '';
      if (normalized.isNotEmpty) return normalized;
    }
    return '';
  }

  bool _shouldTryPosRecovery(AuthAccessException error) {
    final message = error.message.trim().toLowerCase();
    return message.contains('no está registrada en el sistema') ||
        message.contains('no esta registrada en el sistema');
  }
}

class _ResolvedUserProfile {
  final DocumentReference<Map<String, dynamic>> reference;
  final UserModel profile;

  const _ResolvedUserProfile({required this.reference, required this.profile});
}
