import 'package:sqflite/sqflite.dart';

import '../../../core/constants/permisos.dart';
import '../../../domain/entities/usuario.dart';
import 'base_dao.dart';

class UsuarioDao extends BaseDao<Usuario> {
  UsuarioDao(Database db) : super(db, 'usuarios');

  @override
  Map<String, Object?> toMap(Usuario entity) => entity.toMap();

  @override
  Usuario fromMap(Map<String, Object?> map) => Usuario.fromMap(map);

  @override
  String idOf(Usuario entity) => entity.id;

  Future<Usuario?> porNombreUsuario(String usuario) async {
    final rows = await findAll(where: 'usuario = ?', whereArgs: [usuario], limit: 1);
    return rows.isEmpty ? null : rows.first;
  }

  Future<Usuario?> porFirebaseUid(String uid) async {
    final rows = await findAll(where: 'firebase_uid = ?', whereArgs: [uid], limit: 1);
    return rows.isEmpty ? null : rows.first;
  }

  Future<List<Usuario>> deEmpresa(String empresaId) {
    return findAll(where: 'empresa_id = ?', whereArgs: [empresaId], orderBy: 'nombre ASC');
  }

  /// Permisos individuales otorgados/revocados encima del rol base
  /// (tabla `permisos_usuario`). El calculo del set efectivo vive en
  /// UsuarioRepository, que combina esto con RolBase.permisosPorDefecto.
  Future<Map<Permiso, bool>> overridesDePermisos(String usuarioId) async {
    final rows = await db.query('permisos_usuario', where: 'usuario_id = ? AND eliminado = 0', whereArgs: [usuarioId]);
    final result = <Permiso, bool>{};
    for (final row in rows) {
      final permiso = Permiso.values.firstWhere(
        (p) => p.name == row['permiso'],
        orElse: () => Permiso.verReportes,
      );
      result[permiso] = (row['otorgado'] as int? ?? 1) == 1;
    }
    return result;
  }

  Future<void> guardarOverridePermiso(String id, String usuarioId, Permiso permiso, bool otorgado, String nowIso) async {
    await db.insert('permisos_usuario', {
      'id': id,
      'usuario_id': usuarioId,
      'permiso': permiso.name,
      'otorgado': otorgado ? 1 : 0,
      'creado_en': nowIso,
      'actualizado_en': nowIso,
      'version': 1,
      'sync_estado': 'pendiente',
      'eliminado': 0,
    });
  }
}
