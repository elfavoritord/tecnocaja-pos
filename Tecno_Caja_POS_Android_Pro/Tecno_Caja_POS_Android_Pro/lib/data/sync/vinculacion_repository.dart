import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/constants/roles.dart';
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
  VinculacionRepository(
      this._db, this._configuracionRepository, this._secureSession);

  final Database _db;
  final ConfiguracionRepository _configuracionRepository;
  final SecureSessionService _secureSession;

  /// Une un usuario con la instalación local canónica de su mismo negocio.
  /// En versiones anteriores cada cuenta Firebase podía crear otra fila de
  /// empresa con el mismo remoto_id, dejando al cajero en un catálogo vacío.
  Future<Usuario> reconciliarEmpresaUsuario(
    Usuario usuario,
    String remoteBusinessId,
  ) async {
    return _db.transaction((txn) async {
      final companies = await txn.query(
        'empresas',
        where: 'remoto_id = ? AND eliminado = 0',
        whereArgs: [remoteBusinessId],
        orderBy: 'creado_en ASC',
      );
      if (companies.length < 2) return usuario;

      Map<String, Object?> canonical = companies.first;
      var highestProductCount = -1;
      for (final company in companies) {
        final id = company['id']!.toString();
        final count = Sqflite.firstIntValue(await txn.rawQuery(
              'SELECT COUNT(*) FROM productos '
              'WHERE empresa_id = ? AND activo = 1 AND eliminado = 0',
              [id],
            )) ??
            0;
        if (count > highestProductCount) {
          canonical = company;
          highestProductCount = count;
        }
      }
      final canonicalId = canonical['id']!.toString();
      if (canonicalId == usuario.empresaId) return usuario;

      final currentBranch = usuario.sucursalId == null
          ? const <Map<String, Object?>>[]
          : await txn.query(
              'sucursales',
              columns: ['remoto_id'],
              where: 'id = ?',
              whereArgs: [usuario.sucursalId],
              limit: 1,
            );
      final remoteBranchId = currentBranch.firstOrNull?['remoto_id'];
      var targetBranches = remoteBranchId == null
          ? const <Map<String, Object?>>[]
          : await txn.query(
              'sucursales',
              columns: ['id'],
              where: 'empresa_id = ? AND remoto_id = ? AND eliminado = 0',
              whereArgs: [canonicalId, remoteBranchId],
              limit: 1,
            );
      if (targetBranches.isEmpty) {
        targetBranches = await txn.query(
          'sucursales',
          columns: ['id'],
          where: 'empresa_id = ? AND eliminado = 0',
          whereArgs: [canonicalId],
          limit: 1,
        );
      }
      final branchId = targetBranches.firstOrNull?['id']?.toString();
      final now = DateTime.now().toIso8601String();
      await txn.update(
        'usuarios',
        {
          'empresa_id': canonicalId,
          'sucursal_id': branchId,
          'actualizado_en': now,
        },
        where: 'id = ?',
        whereArgs: [usuario.id],
      );
      final updated = await txn.query(
        'usuarios',
        where: 'id = ?',
        whereArgs: [usuario.id],
        limit: 1,
      );
      return Usuario.fromMap(updated.first);
    });
  }

  /// Importa el catálogo que el bootstrap entrega mediante Admin SDK. Esta
  /// ruta evita que diferencias de sucursal o reglas antiguas de Firestore
  /// dejen al cajero sin productos.
  Future<int> importarProductosDesdeBootstrap(
    List<dynamic> products, {
    required String localBusinessId,
    required String deviceId,
  }) async {
    if (products.isEmpty) return 0;
    return _db.transaction((txn) async {
      final branches = await txn.query(
        'sucursales',
        columns: ['id', 'remoto_id'],
        where: 'empresa_id = ? AND eliminado = 0',
        whereArgs: [localBusinessId],
      );
      final byRemote = {
        for (final branch in branches)
          if (branch['remoto_id'] != null)
            branch['remoto_id']!.toString(): branch['id']!.toString(),
      };
      final defaultBranch = branches.firstOrNull?['id']?.toString();
      final now = DateTime.now().toIso8601String();
      var imported = 0;
      for (final raw in products.whereType<Map>()) {
        final data = Map<String, dynamic>.from(raw);
        final remoteId = data['id']?.toString() ?? '';
        final name = data['name']?.toString().trim() ?? '';
        if (remoteId.isEmpty || name.isEmpty) continue;
        final existing = await txn.query(
          'productos',
          where: '''
            empresa_id = ? AND eliminado = 0 AND (
              remoto_id = ? OR
              (codigo_barras IS NOT NULL AND codigo_barras != '' AND codigo_barras = ?) OR
              (sku IS NOT NULL AND sku != '' AND sku = ?) OR
              (lower(trim(nombre)) = ? AND abs(precio_venta - ?) < 0.001)
            )
          ''',
          whereArgs: [
            localBusinessId,
            remoteId,
            (data['barcode'] ?? data['sku'])?.toString(),
            data['sku']?.toString(),
            name.toLowerCase(),
            _number(data['price']),
          ],
          orderBy: 'actualizado_en DESC',
          limit: 1,
        );
        final existingRow = existing.firstOrNull;
        final localId = existingRow?['id']?.toString() ?? IdGenerator.newId();
        final branchId =
            byRemote[data['branchId']?.toString()] ?? defaultBranch;
        await txn.insert(
          'productos',
          {
            'id': localId,
            'nombre': name,
            'sku': data['sku']?.toString(),
            'codigo_barras': (data['barcode'] ?? data['sku'])?.toString(),
            'marca': data['brand']?.toString(),
            'unidad_medida': data['unit']?.toString() ?? 'unidad',
            'precio_compra': _number(data['cost']),
            'precio_venta': _number(data['price']),
            'tasa_itbis': _number(data['taxRate'], fallback: 0.18),
            'itbis_incluido': data['taxIncluded'] == false ? 0 : 1,
            'imagen_path': data['imageUrl']?.toString(),
            'stock_minimo': _number(data['minStock']),
            'activo': data['isActive'] == false ? 0 : 1,
            'empresa_id': localBusinessId,
            'sucursal_id': branchId,
            'dispositivo_id': deviceId,
            'creado_en': existingRow?['creado_en'] ?? now,
            'actualizado_en': now,
            'version': (existingRow?['version'] as int? ?? 0) + 1,
            'sync_estado': 'sincronizado',
            'sincronizado_en': now,
            'remoto_id': remoteId,
            'eliminado': 0,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        if (branchId != null) {
          final inventory = await txn.query(
            'inventario_sucursal',
            where: 'producto_id = ? AND sucursal_id = ?',
            whereArgs: [localId, branchId],
            limit: 1,
          );
          await txn.insert(
            'inventario_sucursal',
            {
              'id': inventory.firstOrNull?['id'] ?? IdGenerator.newId(),
              'producto_id': localId,
              'stock': _number(data['stock']),
              'stock_minimo': _number(data['minStock']),
              'empresa_id': localBusinessId,
              'sucursal_id': branchId,
              'dispositivo_id': deviceId,
              'creado_en': inventory.firstOrNull?['creado_en'] ?? now,
              'actualizado_en': now,
              'version': (inventory.firstOrNull?['version'] as int? ?? 0) + 1,
              'sync_estado': 'sincronizado',
              'sincronizado_en': now,
              'remoto_id': '$remoteId:$branchId',
              'eliminado': 0,
            },
            conflictAlgorithm: ConflictAlgorithm.replace,
          );
        }
        imported++;
      }
      return imported;
    });
  }

  double _number(Object? value, {double fallback = 0}) {
    if (value is num) return value.toDouble();
    return double.tryParse(value?.toString() ?? '') ?? fallback;
  }

  Future<Usuario?> vincular(MobileLinkPayload payload,
      {required String deviceId, String? deviceName}) async {
    await _secureSession.guardarTokens(
        accessToken: payload.accessToken, refreshToken: payload.refreshToken);

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
        sucursalId: payload.usuario.sucursalId != null
            ? sucursalIdPorRemoto[payload.usuario.sucursalId]
            : null,
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

  /// Persiste localmente una empresa creada 100% desde el móvil (Cloud
  /// Function `createMobileCompany`, ver `CloudFunctionsService`) -- a
  /// diferencia de [vincular], esto NUNCA habla con Tecno Caja Windows, así
  /// que `windowsVinculado` queda en su default (false). El negocio YA existe
  /// en Firestore (es la fuente de verdad) cuando esto corre, por eso todo se
  /// marca `sincronizado` con `remotoId` = los ids (UUID) que devolvió la
  /// Cloud Function, igual que [vincular] hace con los ids INT de Windows.
  Future<Usuario> vincularDesdeNube({
    required String businessId,
    required String branchId,
    required String registerId,
    required String nombreComercial,
    String? razonSocial,
    String? rncCedula,
    String? direccion,
    String? telefono,
    required String provincia,
    String? tipoNegocio,
    required String monedaPrincipal,
    required double tasaItbis,
    required String ownerNombre,
    String? ownerApellido,
    String? email,
    required String firebaseUid,
    required String deviceId,
    String? deviceName,
  }) async {
    final now = DateTime.now();
    late Usuario usuarioLocal;

    await _db.transaction((txn) async {
      final empresa = Empresa(
        id: IdGenerator.newId(),
        nombre: nombreComercial,
        nombreComercial: nombreComercial,
        rncCedula: rncCedula,
        direccion: direccion,
        telefono: telefono,
        email: email,
        tipoNegocio: tipoNegocio,
        provincia: provincia,
        monedaPrincipal: monedaPrincipal,
        tasaItbisDefault: tasaItbis,
        tipoPlan: 'trial',
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: businessId,
      );
      await txn.insert('empresas', empresa.toMap());

      final sucursal = Sucursal(
        id: IdGenerator.newId(),
        empresaId: empresa.id,
        nombre: 'Sucursal Principal',
        codigo: 'SUC-001',
        direccion: direccion,
        telefono: telefono,
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: branchId,
      );
      await txn.insert('sucursales', sucursal.toMap());

      final caja = Caja(
        id: IdGenerator.newId(),
        empresaId: empresa.id,
        sucursalId: sucursal.id,
        nombre: 'Caja Principal',
        codigo: 'CAJA-001',
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: registerId,
      );
      await txn.insert('cajas', caja.toMap());

      // Rol: la Cloud Function asigna 'businessOwner' en Firestore. Todavía
      // no existe RolBase.propietario en el enum local (pendiente de la Fase
      // 4 del plan de sincronización) -- administradorGeneral es el rol local
      // con permisos equivalentes mientras tanto.
      usuarioLocal = Usuario(
        id: IdGenerator.newId(),
        empresaId: empresa.id,
        sucursalId: sucursal.id,
        nombre: ownerNombre,
        apellido: ownerApellido,
        usuario: (email ?? ownerNombre).split('@').first,
        email: email,
        telefono: telefono,
        rol: RolBase.administradorGeneral,
        firebaseUid: firebaseUid,
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: firebaseUid,
      );
      await txn.insert('usuarios', usuarioLocal.toMap());
    });

    final configuracionActual = await _configuracionRepository.obtener();
    await _configuracionRepository.guardar(configuracionActual.copyWith(
      empresaId: usuarioLocal.empresaId,
    ));

    return usuarioLocal;
  }

  /// Crea el espejo SQLite de una empresa de Windows que ya fue publicada
  /// en Firestore. No necesita tokens REST ni que la computadora esté
  /// encendida: businessId, sucursales, cajas y permisos vienen del callable
  /// `getMyCompanyBootstrap`.
  Future<Usuario?> vincularPosDesdeNube(
    Map<String, dynamic> bootstrap, {
    required String firebaseUid,
    required String deviceId,
  }) async {
    if (bootstrap['linked'] != true) return null;

    final businessId = bootstrap['businessId']?.toString() ?? '';
    final business =
        Map<String, dynamic>.from(bootstrap['business'] as Map? ?? const {});
    final remoteUser =
        Map<String, dynamic>.from(bootstrap['user'] as Map? ?? const {});
    final remoteBranches = (bootstrap['branches'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    final remoteRegisters = (bootstrap['registers'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();

    if (businessId.isEmpty || remoteBranches.isEmpty) return null;

    final now = DateTime.now();
    late Usuario usuarioLocal;

    await _db.transaction((txn) async {
      final empresa = Empresa(
        id: IdGenerator.newId(),
        nombre: business['name']?.toString() ?? 'Mi negocio',
        nombreComercial: business['name']?.toString(),
        rncCedula: business['rnc']?.toString(),
        direccion: business['address']?.toString(),
        telefono: business['phone']?.toString(),
        email: remoteUser['email']?.toString(),
        monedaPrincipal: _normalizarMoneda(business['currency']),
        tasaItbisDefault: (business['taxRate'] as num?)?.toDouble() ?? 0.18,
        tipoPlan: 'vinculado',
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: businessId,
      );
      await txn.insert('empresas', empresa.toMap());

      final branchLocalIds = <String, String>{};
      for (final remote in remoteBranches) {
        final remoteId = remote['id']?.toString() ?? '';
        if (remoteId.isEmpty) continue;
        final branch = Sucursal(
          id: IdGenerator.newId(),
          empresaId: empresa.id,
          nombre: remote['name']?.toString() ?? 'Sucursal',
          codigo: remote['code']?.toString(),
          direccion: remote['address']?.toString(),
          telefono: remote['phone']?.toString(),
          dispositivoId: deviceId,
          creadoEn: now,
          actualizadoEn: now,
          syncEstado: SyncEstado.sincronizado,
          sincronizadoEn: now,
          remotoId: remoteId,
        );
        await txn.insert('sucursales', branch.toMap());
        branchLocalIds[remoteId] = branch.id;
      }

      for (final remote in remoteRegisters) {
        final remoteId = remote['id']?.toString() ?? '';
        final branchLocalId = branchLocalIds[remote['branchId']?.toString()];
        if (remoteId.isEmpty || branchLocalId == null) continue;
        final register = Caja(
          id: IdGenerator.newId(),
          empresaId: empresa.id,
          sucursalId: branchLocalId,
          nombre: remote['name']?.toString() ?? 'Caja',
          codigo: remote['code']?.toString(),
          dispositivoId: deviceId,
          creadoEn: now,
          actualizadoEn: now,
          syncEstado: SyncEstado.sincronizado,
          sincronizadoEn: now,
          remotoId: remoteId,
        );
        await txn.insert('cajas', register.toMap());
      }

      final displayName = remoteUser['displayName']?.toString().trim() ?? '';
      final nameParts = displayName.split(RegExp(r'\s+'));
      usuarioLocal = Usuario(
        id: IdGenerator.newId(),
        empresaId: empresa.id,
        sucursalId: branchLocalIds.values.first,
        nombre: nameParts.isEmpty || nameParts.first.isEmpty
            ? 'Usuario'
            : nameParts.first,
        apellido: nameParts.length > 1 ? nameParts.skip(1).join(' ') : null,
        usuario:
            (remoteUser['email']?.toString() ?? displayName).split('@').first,
        email: remoteUser['email']?.toString(),
        rol: _rolDesdeNube(remoteUser['role']?.toString()),
        firebaseUid: firebaseUid,
        dispositivoId: deviceId,
        creadoEn: now,
        actualizadoEn: now,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: remoteUser['posUserId']?.toString() ?? firebaseUid,
      );
      await txn.insert('usuarios', usuarioLocal.toMap());
    });

    final configuracionActual = await _configuracionRepository.obtener();
    await _configuracionRepository.guardar(configuracionActual.copyWith(
      empresaId: usuarioLocal.empresaId,
      windowsVinculado: true,
      windowsModoConexion: 'nube',
      windowsCodigoDispositivo: deviceId,
      windowsVinculadoEn: now,
    ));
    return usuarioLocal;
  }

  String _normalizarMoneda(Object? value) {
    final raw = value?.toString().toUpperCase() ?? 'DOP';
    return raw.contains('US') ? 'USD' : 'DOP';
  }

  RolBase _rolDesdeNube(String? role) {
    return switch (role?.toLowerCase()) {
      'owner' || 'businessowner' || 'admin' => RolBase.administradorGeneral,
      'branch_admin' ||
      'administradorsucursal' =>
        RolBase.administradorSucursal,
      'supervisor' => RolBase.supervisor,
      'accountant' || 'contador' => RolBase.contador,
      'delivery' => RolBase.delivery,
      _ => RolBase.cajero,
    };
  }

  /// Borra TODOS los datos locales de este dispositivo (empresa, sucursales,
  /// cajas, usuarios, productos, clientes, ventas, configuración, etc.) para
  /// permitir un reintento limpio de vinculación con Windows.
  ///
  /// Caso de uso: el primer intento de vinculación falló silenciosamente
  /// (p.ej. el POS Windows estaba apagado) y el usuario terminó en el
  /// onboarding standalone, creando un negocio local vacío atado a su mismo
  /// `firebase_uid` -- lo que bloquea para siempre futuros intentos de
  /// vinculación (`AuthRepository.resolverUsuarioLocal` encuentra ese usuario
  /// primero y nunca vuelve a intentar). Ver Ajustes > Sincronización.
  ///
  /// Destructivo e irreversible: la UI debe confirmar con el usuario antes
  /// de llamar esto. Solo tiene sentido cuando `windowsVinculado == false`.
  Future<void> borrarDatosLocalesParaReintentar() async {
    final tablas = await _db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'android_metadata'",
    );
    await _db.transaction((txn) async {
      for (final fila in tablas) {
        await txn.delete(fila['name'] as String);
      }
    });
  }
}

final vinculacionRepositoryProvider = Provider<VinculacionRepository>((ref) {
  return VinculacionRepository(
    ref.watch(databaseProvider),
    ref.watch(configuracionRepositoryProvider),
    ref.watch(secureSessionServiceProvider),
  );
});
