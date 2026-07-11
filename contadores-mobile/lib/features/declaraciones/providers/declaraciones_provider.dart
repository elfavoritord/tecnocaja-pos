import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/declaracion_model.dart';
import '../../../data/services/declaracion_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../../dashboard/providers/dashboard_provider.dart';

final declaracionesProvider = StreamProvider<List<DeclaracionModel>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(declaracionServiceProvider).watchDeclaraciones(profile.contadorDocId);
});

final declaracionFiltroEstadoProvider = StateProvider<String?>((ref) => null);
final declaracionFiltroTipoProvider = StateProvider<String?>((ref) => null);

final declaracionesFiltradas = Provider<AsyncValue<List<DeclaracionModel>>>((ref) {
  final async = ref.watch(declaracionesProvider);
  final estado = ref.watch(declaracionFiltroEstadoProvider);
  final tipo = ref.watch(declaracionFiltroTipoProvider);

  return async.whenData((list) {
    var r = list;
    if (estado != null) r = r.where((d) => d.estado == estado).toList();
    if (tipo != null) r = r.where((d) => d.tipo == tipo).toList();
    return r;
  });
});

class DeclaracionFormNotifier extends StateNotifier<AsyncValue<void>> {
  final DeclaracionService _service;
  final String _contadorDocId;

  DeclaracionFormNotifier(this._service, this._contadorDocId) : super(const AsyncValue.data(null));

  Future<bool> save(DeclaracionModel d, {String? id}) async {
    state = const AsyncValue.loading();
    try {
      if (id != null) {
        await _service.update(_contadorDocId, id, d.toFirestore());
      } else {
        await _service.create(_contadorDocId, d);
      }
      state = const AsyncValue.data(null);
      return true;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      return false;
    }
  }

  Future<bool> marcarEnviada(String id, {String? numeroConfirmacion, String? obs}) async {
    state = const AsyncValue.loading();
    try {
      await _service.marcarEnviada(_contadorDocId, id, numeroConfirmacion: numeroConfirmacion, observaciones: obs);
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
      await _service.delete(_contadorDocId, id);
      state = const AsyncValue.data(null);
      return true;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      return false;
    }
  }
}

final declaracionFormProvider = StateNotifierProvider.autoDispose<DeclaracionFormNotifier, AsyncValue<void>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  return DeclaracionFormNotifier(ref.read(declaracionServiceProvider), profile?.contadorDocId ?? '');
});
