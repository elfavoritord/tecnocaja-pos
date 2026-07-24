import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/proveedor.dart';
import '../local/daos/proveedor_dao.dart';

class ProveedorRepository {
  ProveedorRepository(this._dao, this._db);

  final ProveedorDao _dao;
  final Database _db;

  Future<List<Proveedor>> deEmpresa(String empresaId) => _dao.deEmpresa(empresaId);

  Future<List<Proveedor>> buscar(String empresaId, String termino) => _dao.buscar(empresaId, termino);

  Future<Proveedor?> porId(String id) => _dao.findById(id);

  Future<Proveedor> crear({
    required String empresaId,
    required String nombre,
    String? empresaProveedora,
    String? telefono,
    String? email,
    String? rnc,
    String? contacto,
    String? direccion,
    String? diasVisita,
    int? terminosPagoDias,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final proveedor = Proveedor(
      id: IdGenerator.newId(),
      nombre: nombre,
      empresaProveedora: empresaProveedora,
      telefono: telefono,
      email: email,
      rnc: rnc,
      contacto: contacto,
      direccion: direccion,
      diasVisita: diasVisita,
      terminosPagoDias: terminosPagoDias,
      empresaId: empresaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _dao.insert(proveedor);
    return proveedor;
  }

  Future<void> actualizar(Proveedor proveedor) => _dao.update(proveedor);

  Future<void> desactivar(String id) => _dao.softDelete(id, nowIso: DateTime.now().toIso8601String());

  /// Cuentas por pagar: suma de `monto_pendiente` de las compras no saldadas
  /// de este proveedor. Se calcula en vivo desde `compras` en vez de guardar
  /// un balance propio en `proveedores` -- a diferencia de Cliente.balance,
  /// aqui todavia no existe UI de Compras que lo mantenga consistente.
  Future<double> cuentaPorPagar(String proveedorId) async {
    final rows = await _db.rawQuery(
      "SELECT COALESCE(SUM(monto_pendiente), 0) as total FROM compras WHERE proveedor_id = ? AND eliminado = 0 AND estado != 'pagada'",
      [proveedorId],
    );
    return (rows.first['total'] as num?)?.toDouble() ?? 0;
  }
}

final proveedorRepositoryProvider = Provider<ProveedorRepository>((ref) {
  return ProveedorRepository(ref.watch(proveedorDaoProvider), ref.watch(databaseProvider));
});
