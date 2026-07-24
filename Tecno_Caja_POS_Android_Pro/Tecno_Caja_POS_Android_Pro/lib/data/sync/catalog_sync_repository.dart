import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/constants/sync_estado.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/categoria.dart';
import '../../domain/entities/cliente.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/proveedor.dart';
import '../../domain/entities/sucursal_caja.dart';
import '../local/daos/catalogo_dao.dart';
import '../local/daos/cliente_dao.dart';
import '../local/daos/proveedor_dao.dart';
import 'mobile_sync_api.dart';

class ResultadoSincronizacion {
  const ResultadoSincronizacion({required this.productos, required this.clientes, required this.proveedores});

  final int productos;
  final int clientes;
  final int proveedores;

  int get total => productos + clientes + proveedores;
}

/// Pull de catálogo desde Tecno Caja Windows -- fase 1 de sincronización
/// (solo lectura). Cada entidad se upsertea por `remoto_id`: si ya existe
/// una fila local vinculada a ese id de Windows se actualiza, si no se crea
/// nueva con UUID local. Todo llega marcado `sincronizado` porque ya existe
/// del lado servidor -- no hay nada pendiente de subir.
///
/// Deliberadamente NO sincroniza ventas, caja ni ajustes de inventario desde
/// el celular hacia Windows todavía (fase 2) -- ver nota en
/// server/routes/mobile-sync.routes.js.
class CatalogSyncRepository {
  CatalogSyncRepository(
    this._api,
    this._db,
    this._productoDao,
    this._categoriaDao,
    this._clienteDao,
    this._proveedorDao,
  );

  final MobileSyncApi _api;
  final Database _db;
  final ProductoDao _productoDao;
  final CategoriaDao _categoriaDao;
  final ClienteDao _clienteDao;
  final ProveedorDao _proveedorDao;

  Future<ResultadoSincronizacion> sincronizarTodo({
    required String empresaId,
    required Sucursal sucursal,
    String? dispositivoId,
  }) async {
    final productos = await _sincronizarProductos(empresaId: empresaId, sucursal: sucursal, dispositivoId: dispositivoId);
    final clientes = await _sincronizarClientes(empresaId: empresaId, dispositivoId: dispositivoId);
    final proveedores = await _sincronizarProveedores(empresaId: empresaId, dispositivoId: dispositivoId);
    return ResultadoSincronizacion(productos: productos, clientes: clientes, proveedores: proveedores);
  }

  Future<int> _sincronizarProductos({
    required String empresaId,
    required Sucursal sucursal,
    String? dispositivoId,
  }) async {
    if (sucursal.remotoId == null) return 0;
    final remotos = await _api.productos(branchId: sucursal.remotoId!);

    final categoriasExistentes = await _categoriaDao.deEmpresa(empresaId);
    final categoriaIdPorNombre = <String, String>{
      for (final c in categoriasExistentes) c.nombre.trim().toLowerCase(): c.id,
    };

    var count = 0;
    final now = DateTime.now();
    for (final r in remotos) {
      String? categoriaId;
      final nombreCategoria = r.categoria?.trim();
      if (nombreCategoria != null && nombreCategoria.isNotEmpty) {
        final clave = nombreCategoria.toLowerCase();
        categoriaId = categoriaIdPorNombre[clave];
        if (categoriaId == null) {
          final nuevaCategoria = Categoria(
            id: IdGenerator.newId(),
            empresaId: empresaId,
            nombre: nombreCategoria,
            dispositivoId: dispositivoId,
            creadoEn: now,
            actualizadoEn: now,
            syncEstado: SyncEstado.sincronizado,
            sincronizadoEn: now,
          );
          await _categoriaDao.insert(nuevaCategoria);
          categoriaId = nuevaCategoria.id;
          categoriaIdPorNombre[clave] = categoriaId;
        }
      }

      final existente = await _productoDao.porRemotoId(r.id);
      final producto = Producto(
        id: existente?.id ?? IdGenerator.newId(),
        nombre: r.nombre,
        sku: r.sku,
        codigoBarras: r.sku,
        categoriaId: categoriaId,
        unidadMedida: r.unidadMedida,
        precioCompra: r.precioCompra,
        precioVenta: r.precioVenta,
        itbisIncluido: r.itbisIncluido,
        tasaItbis: r.tasaItbis,
        stockMinimo: r.stockMinimo,
        empresaId: empresaId,
        dispositivoId: dispositivoId,
        creadoEn: existente?.creadoEn ?? now,
        actualizadoEn: now,
        version: (existente?.version ?? 0) + 1,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: r.id,
      );
      if (existente != null) {
        await _productoDao.update(producto);
      } else {
        await _productoDao.insert(producto);
      }

      await _sincronizarStockLocal(producto.id, sucursal, empresaId, r.stock, r.stockMinimo, dispositivoId, now);
      count++;
    }
    return count;
  }

  Future<void> _sincronizarStockLocal(
    String productoId,
    Sucursal sucursal,
    String empresaId,
    double stock,
    double stockMinimo,
    String? dispositivoId,
    DateTime now,
  ) async {
    final existentes = await _db.query(
      'inventario_sucursal',
      where: 'producto_id = ? AND sucursal_id = ?',
      whereArgs: [productoId, sucursal.id],
      limit: 1,
    );
    if (existentes.isNotEmpty) {
      await _db.update(
        'inventario_sucursal',
        {
          'stock': stock,
          'stock_minimo': stockMinimo,
          'actualizado_en': now.toIso8601String(),
          'version': ((existentes.first['version'] as int?) ?? 0) + 1,
          'sync_estado': 'sincronizado',
          'sincronizado_en': now.toIso8601String(),
        },
        where: 'id = ?',
        whereArgs: [existentes.first['id']],
      );
    } else {
      await _db.insert('inventario_sucursal', {
        'id': IdGenerator.newId(),
        'producto_id': productoId,
        'sucursal_id': sucursal.id,
        'empresa_id': empresaId,
        'stock': stock,
        'stock_minimo': stockMinimo,
        'dispositivo_id': dispositivoId,
        'creado_en': now.toIso8601String(),
        'actualizado_en': now.toIso8601String(),
        'version': 1,
        'sync_estado': 'sincronizado',
        'sincronizado_en': now.toIso8601String(),
        'eliminado': 0,
      });
    }
  }

  Future<int> _sincronizarClientes({required String empresaId, String? dispositivoId}) async {
    final remotos = await _api.clientes();
    final now = DateTime.now();
    var count = 0;
    for (final r in remotos) {
      final existente = await _clienteDao.porRemotoId(r.id);
      final cliente = Cliente(
        id: existente?.id ?? IdGenerator.newId(),
        nombre: r.nombre,
        telefono: r.telefono,
        email: r.email,
        direccion: r.direccion,
        cedulaRnc: r.cedulaRnc,
        limiteCredito: r.limiteCredito,
        balance: r.balance,
        empresaId: empresaId,
        dispositivoId: dispositivoId,
        creadoEn: existente?.creadoEn ?? now,
        actualizadoEn: now,
        version: (existente?.version ?? 0) + 1,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: r.id,
      );
      if (existente != null) {
        await _clienteDao.update(cliente);
      } else {
        await _clienteDao.insert(cliente);
      }
      count++;
    }
    return count;
  }

  Future<int> _sincronizarProveedores({required String empresaId, String? dispositivoId}) async {
    final remotos = await _api.proveedores();
    final now = DateTime.now();
    var count = 0;
    for (final r in remotos) {
      final existente = await _proveedorDao.porRemotoId(r.id);
      final proveedor = Proveedor(
        id: existente?.id ?? IdGenerator.newId(),
        nombre: r.nombre,
        empresaProveedora: r.empresaProveedora,
        telefono: r.telefono,
        email: r.email,
        rnc: r.rnc,
        contacto: r.contacto,
        direccion: r.direccion,
        diasVisita: r.diasVisita,
        terminosPagoDias: r.terminosPagoDias,
        empresaId: empresaId,
        dispositivoId: dispositivoId,
        creadoEn: existente?.creadoEn ?? now,
        actualizadoEn: now,
        version: (existente?.version ?? 0) + 1,
        syncEstado: SyncEstado.sincronizado,
        sincronizadoEn: now,
        remotoId: r.id,
      );
      if (existente != null) {
        await _proveedorDao.update(proveedor);
      } else {
        await _proveedorDao.insert(proveedor);
      }
      count++;
    }
    return count;
  }
}

final catalogSyncRepositoryProvider = Provider<CatalogSyncRepository>((ref) {
  return CatalogSyncRepository(
    ref.watch(mobileSyncApiProvider),
    ref.watch(databaseProvider),
    ref.watch(productoDaoProvider),
    ref.watch(categoriaDaoProvider),
    ref.watch(clienteDaoProvider),
    ref.watch(proveedorDaoProvider),
  );
});
