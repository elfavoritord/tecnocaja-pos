import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/user_model.dart';
import '../../../data/services/cliente_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/providers/dashboard_provider.dart';

final clientesProvider = StreamProvider<List<ClienteModel>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(clienteServiceProvider).watchClientes(profile.contadorDocId);
});

final clienteDetailProvider = StreamProvider.family<ClienteModel?, String>((ref, id) {
  return ref.read(clienteServiceProvider).watchCliente(id);
});

final clienteSearchProvider = StateProvider<String>((ref) => '');
final clienteFilterProvider = StateProvider<String?>((ref) => null);

final clientesFiltradosProvider = Provider<AsyncValue<List<ClienteModel>>>((ref) {
  final clientesAsync = ref.watch(clientesProvider);
  final query = ref.watch(clienteSearchProvider);
  final filter = ref.watch(clienteFilterProvider);

  return clientesAsync.whenData((clientes) {
    var result = clientes;
    if (filter != null) {
      result = result.where((c) => c.status.toLowerCase() == filter.toLowerCase()).toList();
    }
    if (query.isNotEmpty) {
      final q = query.toLowerCase();
      result = result.where((c) =>
        c.businessName.toLowerCase().contains(q) ||
        (c.rnc ?? '').toLowerCase().contains(q) ||
        (c.propietario ?? '').toLowerCase().contains(q) ||
        (c.correo ?? '').toLowerCase().contains(q)
      ).toList();
    }
    return result;
  });
});

class ClienteFormNotifier extends StateNotifier<AsyncValue<void>> {
  final ClienteService _service;
  final String contadorDocId;

  ClienteFormNotifier(this._service, this.contadorDocId) : super(const AsyncValue.data(null));

  Future<bool> save(ClienteModel cliente, {String? id}) async {
    state = const AsyncValue.loading();
    try {
      if (id != null) {
        await _service.updateCliente(id, cliente.toFirestore());
      } else {
        await _service.createCliente(cliente);
      }
      state = const AsyncValue.data(null);
      return true;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      return false;
    }
  }

  Future<bool> delete(String id) async {
    state = const AsyncValue.loading();
    try {
      await _service.deleteCliente(id);
      state = const AsyncValue.data(null);
      return true;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      return false;
    }
  }
}

final clienteFormProvider = StateNotifierProvider.autoDispose<ClienteFormNotifier, AsyncValue<void>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  return ClienteFormNotifier(ref.read(clienteServiceProvider), profile?.contadorDocId ?? '');
});
