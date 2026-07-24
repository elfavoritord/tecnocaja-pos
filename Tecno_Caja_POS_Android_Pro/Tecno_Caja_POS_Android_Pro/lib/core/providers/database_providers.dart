import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../data/local/daos/catalogo_dao.dart';
import '../../data/local/daos/cliente_dao.dart';
import '../../data/local/daos/configuracion_dao.dart';
import '../../data/local/daos/empresa_dao.dart';
import '../../data/local/daos/proveedor_dao.dart';
import '../../data/local/daos/sucursal_caja_dao.dart';
import '../../data/local/daos/usuario_dao.dart';
import '../../data/local/daos/ventas_dao.dart';

/// Se sobreescribe en main() con la instancia ya abierta de sqflite antes de
/// levantar la UI -- ver AppDatabase.database. Ningun widget deberia abrir la
/// base por su cuenta.
final databaseProvider = Provider<Database>((ref) {
  throw UnimplementedError('databaseProvider debe sobreescribirse en main() antes de runApp.');
});

final empresaDaoProvider = Provider<EmpresaDao>((ref) => EmpresaDao(ref.watch(databaseProvider)));
final sucursalDaoProvider = Provider<SucursalDao>((ref) => SucursalDao(ref.watch(databaseProvider)));
final cajaDaoProvider = Provider<CajaDao>((ref) => CajaDao(ref.watch(databaseProvider)));
final usuarioDaoProvider = Provider<UsuarioDao>((ref) => UsuarioDao(ref.watch(databaseProvider)));
final configuracionDaoProvider = Provider<ConfiguracionDao>((ref) => ConfiguracionDao(ref.watch(databaseProvider)));

final categoriaDaoProvider = Provider<CategoriaDao>((ref) => CategoriaDao(ref.watch(databaseProvider)));
final productoDaoProvider = Provider<ProductoDao>((ref) => ProductoDao(ref.watch(databaseProvider)));
final inventarioSucursalDaoProvider = Provider<InventarioSucursalDao>((ref) => InventarioSucursalDao(ref.watch(databaseProvider)));
final movimientoInventarioDaoProvider = Provider<MovimientoInventarioDao>((ref) => MovimientoInventarioDao(ref.watch(databaseProvider)));

final ventaDaoProvider = Provider<VentaDao>((ref) => VentaDao(ref.watch(databaseProvider)));
final ventaItemDaoProvider = Provider<VentaItemDao>((ref) => VentaItemDao(ref.watch(databaseProvider)));
final sesionCajaDaoProvider = Provider<SesionCajaDao>((ref) => SesionCajaDao(ref.watch(databaseProvider)));
final movimientoCajaDaoProvider = Provider<MovimientoCajaDao>((ref) => MovimientoCajaDao(ref.watch(databaseProvider)));

final clienteDaoProvider = Provider<ClienteDao>((ref) => ClienteDao(ref.watch(databaseProvider)));
final proveedorDaoProvider = Provider<ProveedorDao>((ref) => ProveedorDao(ref.watch(databaseProvider)));
