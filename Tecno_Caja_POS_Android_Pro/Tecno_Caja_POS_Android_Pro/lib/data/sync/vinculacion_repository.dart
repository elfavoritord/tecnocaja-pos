import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/constants/sync_estado.dart';
import '../../core/providers/database_providers.dart';
import '../../core/providers/service_providers.dart';
import '../../core/services/secure_session_service.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/sucursal_caja.dart';
import '../../domain/entities/usuario.dart';
import '../repositories/configuracion_repository.dart';
import 'mobile_sync_models.dart';

/// Persiste localmente el resultado de una vinculación exitosa con Tecno
/// Caja Windows (empresa + sucursales + cajas + el usuario actual), guarda
/// los tokens móviles, y marca `configuracion.windows_vinculado = 1`.
///
/// Todo se crea con `syncEstado = sincronizado` y `remotoId` apuntando al id
/// INT de Windows -- son datos que YA existen del lado servidor, no hay nada
/// pendiente de subir. Usa inserts crudos dentro de una sola transacción
/// (igual que InventarioRepository) porque los DAO están atados al
/// `Database` de nivel superior, no al `Transaction` -- mezclar ambos en la
/// misma operación produce interbloqueos en sqflite.
class VinculacionRepository {
  VinculacionRepository(this._db, this._configuracionRepository, this._secureSession);

  final Database _db;
  final ConfiguracionRepository _configuracionRepository;
  final SecureSessionService _secureSession;

  Future<Usuario?> vincular(MobileLinkPayload payload, {required String deviceId, String? deviceName}) async {
    await _secureSession.guardarTokens(accessToken: payload.accessToken, refreshToken: payload.refreshToken);

    final now = DateTime.now();
    late Usuario usuarioLocal;

    await _db.transaction((txn) async {
      final empresa = Empresa(
        id: IdGenerator.newId(),
        nombre: payload.negocio.nombre,
        rncCedula: payload.negocio.rnc,
        direccion: payload.negocio.direccion,
        telefono: payload.negocio.telefono,
        monedaPrincipal: payload.negocio.moneda,
        tasaItbisDefault: payload.negocio.tasaItbis,
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
      );
      await txn.insert('empresas', empresa.toMap());

      final sucursalIdPorRemoto = <String, String>{};
      for (final remotaSucursal in payload.negocio.sucursales) {
        final sucursal = Sucursal(
          id: IdGenerator.newId(),
          empresaId: empresa.id,
          nombre: remotaSucursal.nombre,
          codigo: remotaSucursal.codigo,
          direccion: remotaSucursal.direccion,
          telefono: remotaSucursal.telefono,
          dispositivoId: deviceId,
          creadoEn: now,
          actualizadoEn: now,
          syncEstado: SyncEstado.sincronizado,
          sincronizadoEn: now,
          remotoId: remotaSucursal.id,
        );
        await txn.insert('sucursales', sucursal.toMap());
        sucursalIdPorRemoto[remotaSucursal.id] = sucursal.id;
      }

      for (final remotaCaja in payload.negocio.cajas) {
        final sucursalLocalId = sucursalIdPorRemoto[remotaCaja.sucursalId];
        if (sucursalLocalId == null) continue;
        final caja = Caja(
          id: IdGenerator.newId(),
          empresaId: empresa.id,
          sucursalId: sucursalLocalId,
          nombre: remotaCaja.nombre,
          codigo: remotaCaja.codigo,
          dispositivoId: deviceId,
          creadoEn: now,
          actualizadoEn: now,
          syncEstado: SyncEstado.sincronizado,
          sincronizadoEn: now,
          remotoId: remotaCaja.id,
        );
        await txn.insert('cajas', caja.toMap());
      }

      usuarioLocal = Usuario(
        id: IdGenerator.newId(),
        empresaId: empresa.id,
        sucursalId: payload.usuario.sucursalId != null ? sucursalIdPorRemoto[payload.usuario.sucursalId] : null,
        nombre: payload.usuario.nombre,
        usuario: payload.usuario.usuario,
        email: payload.usuario.email,
        telefono: payload.usuario.telefono,
        rol: payload.usuario.rol,
        firebaseUid: payload.usuario.firebaseUid,
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: payload.usuario.id,
      );
      await txn.insert('usuarios', usuarioLocal.toMap());
    });

    final configuracionActual = await _configuracionRepository.obtener();
    await _configuracionRepository.guardar(configuracionActual.copyWith(
      empresaId: usuarioLocal.empresaId,
      windowsVinculado: true,
      windowsModoConexion: 'nube',
      windowsCodigoDispositivo: deviceId,
      windowsNombreDispositivo: deviceName,
      windowsVinculadoEn: now,
    ));

    return usuarioLocal;
  }
}

final vinculacionRepositoryProvider = Provider<VinculacionRepository>((ref) {
  return VinculacionRepository(
    ref.watch(databaseProvider),
    ref.watch(configuracionRepositoryProvider),
    ref.watch(secureSessionServiceProvider),
  );
});
