import 'package:sqflite/sqflite.dart';

import '../../../domain/entities/configuracion_app.dart';

/// Fila unica (id=1) -- no usa BaseDao porque no tiene `eliminado`/multiples
/// filas, es la configuracion del dispositivo.
class ConfiguracionDao {
  ConfiguracionDao(this.db);

  final Database db;

  Future<ConfiguracionApp> obtener() async {
    final rows = await db.query('configuracion', where: 'id = 1', limit: 1);
    if (rows.isEmpty) {
      final inicial = ConfiguracionApp.inicial();
      await db.insert('configuracion', inicial.toMap(), conflictAlgorithm: ConflictAlgorithm.replace);
      return inicial;
    }
    return ConfiguracionApp.fromMap(rows.first);
  }

  Future<void> guardar(ConfiguracionApp config) async {
    await db.insert('configuracion', config.toMap(), conflictAlgorithm: ConflictAlgorithm.replace);
  }
}
