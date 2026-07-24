import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/categoria.dart';
import '../../domain/entities/inventario.dart';
import '../../domain/entities/producto.dart';
import '../local/daos/catalogo_dao.dart';
import 'inventario_repository.dart';

class ProductoRepository {
  ProductoRepository(this._productoDao, this._categoriaDao, this._inventarioRepo);

  final ProductoDao _productoDao;
  final CategoriaDao _categoriaDao;
  final InventarioRepository _inventarioRepo;

  Future<List<Producto>> deEmpresa(String empresaId, {bool soloActivos = true}) {
    return _productoDao.deEmpresa(empresaId, soloActivos: soloActivos);
  }

  Future<Producto?> porId(String id) => _productoDao.findById(id);

  Future<Producto?> porCodigoBarras(String empresaId, String codigo) => _productoDao.porCodigoBarras(empresaId, codigo);

  Future<List<Producto>> buscar(String empresaId, String termino) => _productoDao.buscar(empresaId, termino);

  Future<List<Producto>> favoritos(String empresaId) => _productoDao.favoritos(empresaId);

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
  }) async {
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

    return producto;
  }

  Future<void> actualizar(Producto producto) => _productoDao.update(producto);

  Future<void> desactivar(String id) => _productoDao.softDelete(id, nowIso: DateTime.now().toIso8601String());

  Future<Producto> duplicar(Producto original, {required String dispositivoId}) async {
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

  Future<List<Categoria>> categoriasDe(String empresaId) => _categoriaDao.deEmpresa(empresaId);

  Future<Categoria> crearCategoria({required String empresaId, required String nombre, String? color, String? dispositivoId}) async {
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
    ref.watch(productoDaoProvider),
    ref.watch(categoriaDaoProvider),
    ref.watch(inventarioRepositoryProvider),
  );
});
