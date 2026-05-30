import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/reports_dashboard_model.dart';
import '../../../data/repositories/firestore_dashboard_repository.dart';
import '../../../data/repositories/sales_repository.dart';
import '../../auth/providers/auth_provider.dart';

/// Repositorio de dashboard usando Firestore directamente (sin servidor HTTP).
final firestoreDashboardRepositoryProvider =
    Provider<FirestoreDashboardRepository>(
  (_) => FirestoreDashboardRepository(),
);

final salesRepositoryProvider = Provider<SalesRepository>(
  (_) => SalesRepository(),
);

/// Stream en tiempo real: número de ventas completadas hoy desde Firestore.
/// Emite automáticamente cuando NovaPOS sincroniza una nueva venta.
final liveTodaySalesCountProvider = StreamProvider.autoDispose<int>((ref) {
  // keepAlive: el stream se mantiene vivo mientras la app está abierta
  // para no perder la conexión al volver al dashboard.
  ref.keepAlive();
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) return const Stream.empty();
  return ref.watch(salesRepositoryProvider).watchTodaySalesCount(businessId);
});

/// Stream en tiempo real: monto total de ventas de hoy desde Firestore.
final liveTodayRevenueProvider = StreamProvider.autoDispose<double>((ref) {
  ref.keepAlive();
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) return const Stream.empty();
  return ref.watch(salesRepositoryProvider).watchTodayRevenue(businessId);
});

final dashboardRangePresetProvider = StateProvider<ReportsRangePreset>(
  (ref) => ReportsRangePreset.today,
);

final dashboardSelectedBranchIdProvider = StateProvider<String?>((ref) => null);
final dashboardSelectedCashRegisterIdProvider = StateProvider<String?>(
  (ref) => null,
);
final dashboardSelectedCashierIdProvider = StateProvider<String?>(
  (ref) => null,
);

final dashboardDataProvider = FutureProvider.autoDispose<ReportsDashboardData>((
  ref,
) async {
  final businessId = ref.watch(activeBusinessIdProvider);
  if (businessId == null || businessId.isEmpty) {
    throw StateError('No hay una sesión activa para cargar reportes.');
  }

  final branchId = ref.watch(dashboardSelectedBranchIdProvider);
  final cashRegisterId =
      ref.watch(dashboardSelectedCashRegisterIdProvider);
  final cashierId = ref.watch(dashboardSelectedCashierIdProvider);

  final repository = ref.watch(firestoreDashboardRepositoryProvider);
  return repository.getDashboard(
    preset: ref.watch(dashboardRangePresetProvider),
    businessId: businessId,
    branchIds:
        branchId != null && branchId.isNotEmpty ? [branchId] : null,
    cashRegisterId: cashRegisterId,
    cashierName: cashierId,
  );
});
