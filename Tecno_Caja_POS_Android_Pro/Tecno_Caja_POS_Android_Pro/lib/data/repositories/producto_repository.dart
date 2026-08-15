import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/categoria.dart';
import '../../domain/entities/inventario.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/producto_lote.dart';
import '../local/daos/catalogo_dao.dart';
import 'inventario_repository.dart';

class ProductoRepository {
  ProductoRepository(
      this._db, this._productoDao, this._categoriaDao, this._inventarioRepo);

  final Database _db;
  final ProductoDao _productoDao;
  final CategoriaDao _categoriaDao;
  final InventarioRepository _inventarioRepo;

  Future<List<Producto>> deEmpresa(String empresaId,
      {bool soloActivos = true}) async {
    return _sinDuplicados(
      await _productoDao.deEmpresa(empresaId, soloActivos: soloActivos),
    );
  }

  Future<Producto?> porId(String id) => _productoDao.findById(id);

  Future<Producto?> porCodigoBarras(String empresaId, String codigo) =>
      _productoDao.porCodigoBarras(empresaId, codigo);

  Future<List<Producto>> buscar(String empresaId, String termino) async =>
      _sinDuplicados(await _productoDao.buscar(empresaId, termino));

  Future<List<Producto>> favoritos(String empresaId) async =>
      _sinDuplicados(await _productoDao.favoritos(empresaId));

  List<Producto> _sinDuplicados(List<Producto> productos) {
    final vistos = <String>{};
    return productos.where((producto) {
      final barcode = producto.codigoBarras?.trim().toLowerCase();
      final sku = producto.sku?.trim().toLowerCase();
      final nombre = producto.nombre.trim().toLowerCase();
      final clave = barcode?.isNotEmpty == true
          ? 'barcode:$barcode'
          : sku?.isNotEmpty == true
              ? 'sku:$sku'
              : 'producto:$nombre|${producto.precioVenta.toStringAsFixed(2)}|'
                  '${producto.unidadMedida.trim().toLowerCase()}';
      return vistos.add(clave);
    }).toList();
  }

  Future<Producto> crear({
    required String empresaId,
    String? sucursalId,
    required String nombre,
    String? descripcion,
    String? sku,
    String? codigoBarras,
    String? categoriaId,
    String? marca,
    String unidadMedida = 'unidad',
    required double precioVenta,
    double precioCompra = 0,
    double? precioMinimo,
    double tasaItbis = 0.18,
    bool itbisIncluido = true,
    double stockMinimo = 0,
    String? proveedorId,
    String? dispositivoId,
    double stockInicial = 0,
    String? sucursalParaStock,
    String? usuarioId,
    bool controlaVencimiento = false,
    String? laboratorio,
    String? principioActivo,
    String? presentacion,
    String? concentracion,
    String? registroSanitario,
    bool esControlado = false,
    String? numeroLoteInicial,
    DateTime? fechaFabricacionInicial,
    DateTime? fechaVencimientoInicial,
  }) async {
    if (controlaVencimiento &&
        stockInicial > 0 &&
        fechaVencimientoInicial == null) {
      throw const ValidationException(
        message: 'Indica la fecha de vencimiento del lote inicial.',
      );
    }
    final now = DateTime.now();
    final producto = Producto(
      id: IdGenerator.newId(),
      empresaId: empresaId,
      sucursalId: sucursalId,
      nombre: nombre,
      descripcion: descripcion,
      sku: sku,
      codigoBarras: codigoBarras,
      categoriaId: categoriaId,
      marca: marca,
      unidadMedida: unidadMedida,
      precioVenta: precioVenta,
      precioCompra: precioCompra,
      precioMinimo: precioMinimo,
      tasaItbis: tasaItbis,
      itbisIncluido: itbisIncluido,
      stockMinimo: stockMinimo,
      proveedorId: proveedorId,
      dispositivoId: dispositivoId,
      tieneLotes: controlaVencimiento,
      controlaVencimiento: controlaVencimiento,
      laboratorio: laboratorio,
      principioActivo: principioActivo,
      presentacion: presentacion,
      concentracion: concentracion,
      registroSanitario: registroSanitario,
      esControlado: esControlado,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _productoDao.insert(producto);

    if (sucursalParaStock != null && stockInicial != 0) {
      await _inventarioRepo.registrarMovimiento(
        productoId: producto.id,
        sucursalId: sucursalParaStock,
        empresaId: empresaId,
        tipoMovimiento: TipoMovimientoInventario.entradaManual,
        cantidad: stockInicial,
        costoUnitario: precioCompra,
        nota: 'Stock inicial al crear el producto',
        dispositivoId: dispositivoId,
      );
    }

    if (controlaVencimiento && stockInicial > 0) {
      await crearLote(
        producto: producto,
        cantidad: stockInicial,
        numeroLote: numeroLoteInicial,
        fechaFabricacion: fechaFabricacionInicial,
        fechaVencimiento: fechaVencimientoInicial!,
        costoUnitario: precioCompra,
        proveedorId: proveedorId,
        sucursalId: sucursalParaStock,
        dispositivoId: dispositivoId,
        registrarInventario: false,
      );
    }

    return producto;
  }

  Future<void> actualizar(Producto producto) => _productoDao.update(producto);

  Future<void> desactivar(String id) =>
      _productoDao.softDelete(id, nowIso: DateTime.now().toIso8601String());

  Future<List<ProductoLote>> lotesDe(
    String productoId, {
    String? sucursalId,
    bool incluirAgotados = true,
  }) async {
    final conditions = <String>['producto_id = ?', 'eliminado = 0'];
    final args = <Object?>[productoId];
    if (sucursalId != null) {
      conditions.add('(sucursal_id = ? OR sucursal_id IS NULL)');
      args.add(sucursalId);
    }
    if (!incluirAgotados) conditions.add('cantidad > 0');
    final rows = await _db.query(
      'producto_lotes',
      where: conditions.join(' AND '),
      whereArgs: args,
      orderBy:
          'CASE WHEN fecha_vencimiento IS NULL THEN 1 ELSE 0 END, fecha_vencimiento ASC, creado_en ASC',
    );
    return rows.map(ProductoLote.fromMap).toList();
  }

  Future<ProductoLote> crearLote({
    required Producto producto,
    required double cantidad,
    String? numeroLote,
    DateTime? fechaFabricacion,
    required DateTime fechaVencimiento,
    double? costoUnitario,
    String? proveedorId,
    String? sucursalId,
    String? dispositivoId,
    bool registrarInventario = true,
  }) async {
    if (cantidad <= 0) {
      throw const ValidationException(
        message: 'La cantidad del lote debe ser mayor que cero.',
      );
    }
    final now = DateTime.now();
    final lote = ProductoLote(
      id: IdGenerator.newId(),
      productoId: producto.id,
      numeroLote:
          numeroLote?.trim().isEmpty == true ? null : numeroLote?.trim(),
      fechaFabricacion: fechaFabricacion,
      fechaVencimiento: fechaVencimiento,
      cantidad: cantidad,
      costoUnitario: costoUnitario,
      proveedorId: proveedorId,
      empresaId: producto.empresaId,
      sucursalId: sucursalId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _db.insert('producto_lotes', lote.toMap());
    if (!producto.tieneLotes || !producto.controlaVencimiento) {
      await _productoDao.update(producto.copyWith(
        tieneLotes: true,
        controlaVencimiento: true,
      ));
    }
    if (registrarInventario && sucursalId != null) {
      await _inventarioRepo.registrarMovimiento(
        productoId: producto.id,
        sucursalId: sucursalId,
        empresaId: producto.empresaId,
        tipoMovimiento: TipoMovimientoInventario.entradaManual,
        cantidad: cantidad,
        costoUnitario: costoUnitario,
        nota: 'Entrada de lote ${lote.numeroLote ?? lote.id}',
        dispositivoId: dispositivoId,
      );
    }
    return lote;
  }

  Future<void> validarDisponibleParaVenta(
    Producto producto, {
    double cantidad = 1,
    String? sucursalId,
  }) async {
    if (!producto.controlaVencimiento) return;
    final today = _dateOnly(DateTime.now());
    final conditions = <String>[
      'producto_id = ?',
      'eliminado = 0',
      'cantidad > 0',
    ];
    final args = <Object?>[producto.id];
    if (sucursalId != null) {
      conditions.add('(sucursal_id = ? OR sucursal_id IS NULL)');
      args.add(sucursalId);
    }
    final rows = await _db.query(
      'producto_lotes',
      columns: ['cantidad', 'fecha_vencimiento'],
      where: conditions.join(' AND '),
      whereArgs: args,
    );
    final valid = rows.where((row) {
      final expiry = row['fecha_vencimiento']?.toString();
      return expiry != null && expiry.compareTo(today) >= 0;
    }).fold<double>(0, (sum, row) => sum + (row['cantidad'] as num).toDouble());
    if (valid >= cantidad) return;
    final hasExpired = rows.any((row) {
      final expiry = row['fecha_vencimiento']?.toString();
      return expiry != null && expiry.compareTo(today) < 0;
    });
    if (valid <= 0 && hasExpired) {
      throw const ValidationException(
        message: 'PRODUCTO VENCIDO — NO SE PUEDE VENDER',
      );
    }
    throw ValidationException(
      message:
          'Existencia válida insuficiente. Disponible sin vencer: ${valid.toStringAsFixed(2)}.',
    );
  }

  static String _dateOnly(DateTime value) =>
      value.toIso8601String().substring(0, 10);

  Future<Producto> duplicar(Producto original,
      {required String dispositivoId}) async {
    final now = DateTime.now();
    final copia = Producto(
      id: IdGenerator.newId(),
      empresaId: original.empresaId,
      sucursalId: original.sucursalId,
      nombre: '${original.nombre} (copia)',
      descripcion: original.descripcion,
      sku: null,
      codigoBarras: null,
      categoriaId: original.categoriaId,
      marca: original.marca,
      unidadMedida: original.unidadMedida,
      precioVenta: original.precioVenta,
      precioCompra: original.precioCompra,
      precioMinimo: original.precioMinimo,
      tasaItbis: original.tasaItbis,
      itbisIncluido: original.itbisIncluido,
      stockMinimo: original.stockMinimo,
      proveedorId: original.proveedorId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _productoDao.insert(copia);
    return copia;
  }

  // Categorias

  Future<List<Categoria>> categoriasDe(String empresaId) =>
      _categoriaDao.deEmpresa(empresaId);

  Future<Categoria> crearCategoria(
      {required String empresaId,
      required String nombre,
      String? color,
      String? dispositivoId}) async {
    final now = DateTime.now();
    final categoria = Categoria(
      id: IdGenerator.newId(),
      empresaId: empresaId,
      nombre: nombre,
      color: color,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _categoriaDao.insert(categoria);
    return categoria;
  }
}

final productoRepositoryProvider = Provider<ProductoRepository>((ref) {
  return ProductoRepository(
    ref.watch(databaseProvider),
    ref.watch(productoDaoProvider),
    ref.watch(categoriaDaoProvider),
    ref.watch(inventarioRepositoryProvider),
  );
});
