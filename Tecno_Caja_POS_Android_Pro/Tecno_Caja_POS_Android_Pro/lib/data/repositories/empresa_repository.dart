import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/sucursal_caja.dart';
import '../local/daos/empresa_dao.dart';
import '../local/daos/sucursal_caja_dao.dart';

class EmpresaRepository {
  EmpresaRepository(this._empresaDao, this._sucursalDao, this._cajaDao);

  final EmpresaDao _empresaDao;
  final SucursalDao _sucursalDao;
  final CajaDao _cajaDao;

  Future<Empresa?> actual() => _empresaDao.actual();

  Future<Empresa> crear({
    required String nombre,
    String? nombreComercial,
    String? rncCedula,
    String? direccion,
    String? telefono,
    String? email,
    String? tipoNegocio,
    String? provincia,
    String monedaPrincipal = 'DOP',
    double tasaItbisDefault = 0.18,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final empresa = Empresa(
      id: IdGenerator.newId(),
      nombre: nombre,
      nombreComercial: nombreComercial,
      rncCedula: rncCedula,
      direccion: direccion,
      telefono: telefono,
      email: email,
      tipoNegocio: tipoNegocio,
      provincia: provincia,
      monedaPrincipal: monedaPrincipal,
      tasaItbisDefault: tasaItbisDefault,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _empresaDao.insert(empresa);
    return empresa;
  }

  Future<void> actualizar(Empresa empresa) => _empresaDao.update(empresa);

  Future<Sucursal> crearSucursal({
    required String empresaId,
    required String nombre,
    String? codigo,
    String? direccion,
    String? telefono,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final sucursal = Sucursal(
      id: IdGenerator.newId(),
      empresaId: empresaId,
      nombre: nombre,
      codigo: codigo,
      direccion: direccion,
      telefono: telefono,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _sucursalDao.insert(sucursal);
    return sucursal;
  }

  Future<List<Sucursal>> sucursalesDe(String empresaId) => _sucursalDao.deEmpresa(empresaId);

  Future<Caja> crearCaja({
    required String empresaId,
    required String sucursalId,
    required String nombre,
    String? codigo,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final caja = Caja(
      id: IdGenerator.newId(),
      empresaId: empresaId,
      sucursalId: sucursalId,
      nombre: nombre,
      codigo: codigo,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _cajaDao.insert(caja);
    return caja;
  }

  Future<List<Caja>> cajasDe(String sucursalId) => _cajaDao.deSucursal(sucursalId);
}

final empresaRepositoryProvider = Provider<EmpresaRepository>((ref) {
  return EmpresaRepository(
    ref.watch(empresaDaoProvider),
    ref.watch(sucursalDaoProvider),
    ref.watch(cajaDaoProvider),
  );
});
