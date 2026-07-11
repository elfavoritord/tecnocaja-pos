import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/providers/auth_provider.dart';

class PerfilFormState {
  final bool isSaving;
  final bool saved;
  final String? error;

  const PerfilFormState({this.isSaving = false, this.saved = false, this.error});

  PerfilFormState copyWith({bool? isSaving, bool? saved, String? error, bool clearError = false}) =>
      PerfilFormState(
        isSaving: isSaving ?? this.isSaving,
        saved: saved ?? this.saved,
        error: clearError ? null : (error ?? this.error),
      );
}

class PerfilFormNotifier extends StateNotifier<PerfilFormState> {
  final Ref _ref;

  PerfilFormNotifier(this._ref) : super(const PerfilFormState());

  Future<bool> save(Map<String, dynamic> updates) async {
    state = state.copyWith(isSaving: true, clearError: true, saved: false);
    try {
      await _ref.read(userProfileProvider.notifier).updateProfile(updates);
      state = state.copyWith(isSaving: false, saved: true);
      return true;
    } catch (e) {
      state = state.copyWith(isSaving: false, error: e.toString());
      return false;
    }
  }
}

final perfilFormProvider = StateNotifierProvider.autoDispose<PerfilFormNotifier, PerfilFormState>((ref) {
  return PerfilFormNotifier(ref);
});
