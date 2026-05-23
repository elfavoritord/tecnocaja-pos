import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/repartidor_model.dart';
import '../../../data/repositories/auth_repository.dart';

final authRepositoryProvider = Provider<AuthDeliveryRepository>(
  (_) => AuthDeliveryRepository(),
);

final authStateProvider = StreamProvider<RepartidorModel?>((ref) async* {
  final repo = ref.watch(authRepositoryProvider);
  yield* repo.authStateChanges.asyncMap((user) async {
    if (user == null) return null;
    return repo.getCurrentRepartidor();
  });
});

class AuthNotifier extends AsyncNotifier<RepartidorModel?> {
  @override
  Future<RepartidorModel?> build() async {
    return ref.watch(authRepositoryProvider).getCurrentRepartidor();
  }

  Future<void> signIn(String email, String password) async {
    final repo = ref.read(authRepositoryProvider);
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => repo.signIn(email, password).timeout(
        const Duration(seconds: 15),
        onTimeout: () => throw const AuthDeliveryException(
          'La conexión tardó demasiado. Verifica tu internet e intenta de nuevo.',
        ),
      ),
    );
  }

  Future<void> signOut() async {
    await ref.read(authRepositoryProvider).signOut();
    state = const AsyncData(null);
  }
}

final authNotifierProvider =
    AsyncNotifierProvider<AuthNotifier, RepartidorModel?>(AuthNotifier.new);
