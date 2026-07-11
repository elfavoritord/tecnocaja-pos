import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/services/cliente_service.dart';
import '../../../data/services/declaracion_service.dart';
import '../../../features/auth/providers/auth_provider.dart';

final clienteServiceProvider = Provider<ClienteService>((ref) => ClienteService());
final declaracionServiceProvider = Provider<DeclaracionService>((ref) => DeclaracionService());

final dashboardStatsProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return {};

  final clienteService = ref.read(clienteServiceProvider);
  final declaracionService = ref.read(declaracionServiceProvider);

  final results = await Future.wait([
    clienteService.getDashboardStats(profile.contadorDocId),
    declaracionService.getStats(profile.contadorDocId),
    declaracionService.getProximosVencimientos(profile.contadorDocId),
  ]);

  return {
    ...results[0] as Map<String, dynamic>,
    'declaraciones': results[1],
    'proximosVencimientos': results[2],
  };
});

final clientesStreamProvider = StreamProvider((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(clienteServiceProvider).watchClientes(profile.contadorDocId);
});

final declaracionesStreamProvider = StreamProvider((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(declaracionServiceProvider).watchDeclaraciones(profile.contadorDocId);
});

final declaracionesPendientesProvider = StreamProvider((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(declaracionServiceProvider).watchDeclaraciones(
        profile.contadorDocId,
        estado: 'pendiente',
      );
});
