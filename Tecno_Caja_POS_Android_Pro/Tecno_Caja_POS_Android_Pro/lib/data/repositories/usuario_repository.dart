import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/permisos.dart';
import '../../core/constants/roles.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/usuario.dart';
import '../local/daos/usuario_dao.dart';

class UsuarioRepository {
  UsuarioRepository(this._dao);

  final UsuarioDao _dao;

  Future<Usuario?> porId(String id) => _dao.findById(id);

  Future<Usuario?> porNombreUsuario(String usuario) => _dao.porNombreUsuario(usuario);

  Future<Usuario?> porFirebaseUid(String uid) => _dao.porFirebaseUid(uid);

  Future<List<Usuario>> deEmpresa(String empresaId) => _dao.deEmpresa(empresaId);

  Future<Usuario> crear({
    required String empresaId,
    String? sucursalId,
    required String nombre,
    String? apellido,
    required String usuario,
    String? email,
    String? telefono,
    RolBase rol = RolBase.cajero,
    String? pinHash,
    String? firebaseUid,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final entidad = Usuario(
      id: IdGenerator.newId(),
      empresaId: empresaId,
      sucursalId: sucursalId,
      nombre: nombre,
      apellido: apellido,
      usuario: usuario,
      email: email,
      telefono: telefono,
      rol: rol,
      pinHash: pinHash,
      firebaseUid: firebaseUid,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _dao.insert(entidad);
    return entidad;
  }

  Future<void> actualizar(Usuario usuario) => _dao.update(usuario);

  Future<void> registrarAcceso(String usuarioId) async {
    final usuario = await _dao.findById(usuarioId);
    if (usuario == null) return;
    await _dao.update(usuario.copyWith(ultimoAccesoEn: DateTime.now()));
  }

  /// Rol base + overrides individuales (permisos_usuario). Los revocados
  /// (otorgado=false) siempre ganan sobre el default del rol.
  Future<Set<Permiso>> permisosEfectivos(Usuario usuario) async {
    final efectivos = {...usuario.rol.permisosPorDefecto};
    final overrides = await _dao.overridesDePermisos(usuario.id);
    overrides.forEach((permiso, otorgado) {
      if (otorgado) {
        efectivos.add(permiso);
      } else {
        efectivos.remove(permiso);
      }
    });
    return efectivos;
  }

  Future<void> establecerPermiso(String usuarioId, Permiso permiso, bool otorgado) {
    return _dao.guardarOverridePermiso(
      IdGenerator.newId(),
      usuarioId,
      permiso,
      otorgado,
      DateTime.now().toIso8601String(),
    );
  }
}

final usuarioRepositoryProvider = Provider<UsuarioRepository>((ref) {
  return UsuarioRepository(ref.watch(usuarioDaoProvider));
});
