import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../data/models/user_model.dart';
import '../../../data/repositories/auth_repository.dart';

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(),
);

final authStateProvider = StreamProvider<User?>((ref) {
  return ref.watch(authRepositoryProvider).authStateChanges;
});

final currentUserProfileProvider = StreamProvider<UserModel?>((ref) {
  final user = ref.watch(authStateProvider).valueOrNull;
  if (user == null) {
    return Stream.value(null);
  }

  return ref
      .watch(authRepositoryProvider)
      .watchUserProfile(user.uid, email: user.email);
});

final selectedBusinessIdProvider = StateProvider<String?>((ref) => null);
final selectedBranchIdsProvider = StateProvider<List<String>?>((ref) => null);

final activeBusinessIdProvider = Provider<String?>((ref) {
  final selectedBusinessId = ref.watch(selectedBusinessIdProvider);
  final profile = ref.watch(currentUserProfileProvider).valueOrNull;
  return selectedBusinessId ?? profile?.businessId;
});

final activeBranchIdsProvider = Provider<List<String>?>((ref) {
  final selectedBranchIds = ref.watch(selectedBranchIdsProvider);
  if (selectedBranchIds != null && selectedBranchIds.isNotEmpty) {
    return selectedBranchIds;
  }

  final profile = ref.watch(currentUserProfileProvider).valueOrNull;
  if (profile == null || profile.role.canSeeAllBranches) return null;
  return profile.branchIds;
});

class AuthNotifier extends StateNotifier<AsyncValue<void>> {
  final AuthRepository _repo;

  AuthNotifier(this._repo) : super(const AsyncValue.data(null));

  Future<void> signIn(String email, String password) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() => _repo.signIn(email, password));
  }

  Future<void> signOut() async {
    await _repo.signOut();
  }

  Future<void> sendPasswordReset(String email) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() => _repo.sendPasswordReset(email));
  }
}

final authNotifierProvider =
    StateNotifierProvider<AuthNotifier, AsyncValue<void>>((ref) {
      return AuthNotifier(ref.watch(authRepositoryProvider));
    });
