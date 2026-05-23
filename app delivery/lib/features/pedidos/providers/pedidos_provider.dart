import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/pedido_delivery_model.dart';
import '../../../data/repositories/pedidos_repository.dart';
import '../../auth/providers/auth_provider.dart';

final pedidosRepositoryProvider = Provider<PedidosRepository>(
  (_) => PedidosRepository(),
);

final pedidosActivosProvider =
    StreamProvider<List<PedidoDelivery>>((ref) {
  final auth = ref.watch(authStateProvider).valueOrNull;
  if (auth == null) return const Stream.empty();
  return ref
      .watch(pedidosRepositoryProvider)
      .pedidosActivos(auth.uid);
});

final historialPedidosProvider =
    StreamProvider<List<PedidoDelivery>>((ref) {
  final auth = ref.watch(authStateProvider).valueOrNull;
  if (auth == null) return const Stream.empty();
  return ref
      .watch(pedidosRepositoryProvider)
      .historialPedidos(auth.uid);
});

final pedidoStreamProvider =
    StreamProvider.family<PedidoDelivery?, String>((ref, id) {
  return ref.watch(pedidosRepositoryProvider).pedidoStream(id);
});
