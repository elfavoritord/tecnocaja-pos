import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/repositories/reports_api_repository.dart';

final reportsApiRepositoryProvider = Provider<ReportsApiRepository>((ref) {
  final repository = ReportsApiRepository();
  ref.onDispose(repository.dispose);
  return repository;
});
