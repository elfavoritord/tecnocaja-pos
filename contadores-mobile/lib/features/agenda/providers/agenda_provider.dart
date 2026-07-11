import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/agenda_model.dart';
import '../../../data/services/agenda_service.dart';
import '../../auth/providers/auth_provider.dart';

final agendaServiceProvider = Provider<AgendaService>((ref) => AgendaService());

final agendaEventosProvider = StreamProvider<List<AgendaEventModel>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  final desde = DateTime.now().subtract(const Duration(days: 7));
  final hasta = DateTime.now().add(const Duration(days: 90));
  return ref.read(agendaServiceProvider).watchEventos(profile.contadorDocId, desde: desde, hasta: hasta);
});

class AgendaFormNotifier extends StateNotifier<AsyncValue<void>> {
  final AgendaService _service;
  final String _contadorDocId;

  AgendaFormNotifier(this._service, this._contadorDocId) : super(const AsyncValue.data(null));

  Future<bool> save(AgendaEventModel evento, {String? id}) async {
    state = const AsyncValue.loading();
    try {
      if (id != null) {
        await _service.updateEvento(_contadorDocId, id, evento.toFirestore());
      } else {
        await _service.createEvento(_contadorDocId, evento);
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
      await _service.deleteEvento(_contadorDocId, id);
      state = const AsyncValue.data(null);
      return true;
    } catch (e, st) {
      state = AsyncValue.error(e, st);
      return false;
    }
  }
}

final agendaFormProvider = StateNotifierProvider.autoDispose<AgendaFormNotifier, AsyncValue<void>>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  return AgendaFormNotifier(ref.read(agendaServiceProvider), profile?.contadorDocId ?? '');
});
