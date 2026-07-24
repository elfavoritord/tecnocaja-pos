import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_providers.dart';
import '../../domain/entities/configuracion_app.dart';
import '../local/daos/configuracion_dao.dart';

class ConfiguracionRepository {
  ConfiguracionRepository(this._dao);

  final ConfiguracionDao _dao;

  Future<ConfiguracionApp> obtener() => _dao.obtener();

  Future<void> guardar(ConfiguracionApp config) => _dao.guardar(config);
}

final configuracionRepositoryProvider = Provider<ConfiguracionRepository>((ref) {
  return ConfiguracionRepository(ref.watch(configuracionDaoProvider));
});

/// Estado observable de la configuracion para que la UI reaccione a cambios
/// (tema, redondeo, vinculacion con Windows, etc.) sin recargar toda la app.
final configuracionControllerProvider = AsyncNotifierProvider<ConfiguracionController, ConfiguracionApp>(
  ConfiguracionController.new,
);

class ConfiguracionController extends AsyncNotifier<ConfiguracionApp> {
  @override
  Future<ConfiguracionApp> build() {
    return ref.watch(configuracionRepositoryProvider).obtener();
  }

  Future<void> actualizar(ConfiguracionApp Function(ConfiguracionApp actual) transformar) async {
    final actual = state.valueOrNull ?? await ref.read(configuracionRepositoryProvider).obtener();
    final nueva = transformar(actual);
    await ref.read(configuracionRepositoryProvider).guardar(nueva);
    state = AsyncData(nueva);
  }
}
