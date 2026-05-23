import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import '../repositories/ubicacion_repository.dart';
import '../services/location_service.dart';
import '../../features/auth/providers/auth_provider.dart';

class TrackingState {
  final bool activo;
  final Position? ultimaPosicion;
  final String? error;

  const TrackingState({
    this.activo = false,
    this.ultimaPosicion,
    this.error,
  });

  TrackingState copyWith({bool? activo, Position? ultimaPosicion, String? error}) =>
      TrackingState(
        activo: activo ?? this.activo,
        ultimaPosicion: ultimaPosicion ?? this.ultimaPosicion,
        error: error,
      );
}

class UbicacionNotifier extends Notifier<TrackingState> {
  final _repo = UbicacionRepository();
  StreamSubscription<Position>? _sub;
  String? _activeUid;

  @override
  TrackingState build() {
    ref.onDispose(detener);
    return const TrackingState();
  }

  Future<void> iniciar() async {
    final repartidor = ref.read(authStateProvider).valueOrNull;
    if (repartidor == null) {
      detener();
      return;
    }

    if (_sub != null && state.activo && _activeUid == repartidor.uid) {
      return;
    }

    final granted = await LocationService.requestPermission();
    if (!granted) {
      state = state.copyWith(
        error: 'Permiso de ubicación denegado. Actívalo en la configuración del navegador o dispositivo.',
      );
      return;
    }

    _sub?.cancel();
    _activeUid = repartidor.uid;
    _sub = LocationService.positionStream().listen(
      (pos) async {
        state = state.copyWith(activo: true, ultimaPosicion: pos, error: null);
        try {
          await _repo.actualizarUbicacion(repartidor.uid, pos);
        } catch (_) {}
      },
      onError: (e) {
        state = state.copyWith(error: e.toString(), activo: false);
        _sub?.cancel();
        _sub = null;
      },
    );

    state = state.copyWith(activo: true);
  }

  void detener() {
    _sub?.cancel();
    _sub = null;
    _activeUid = null;
    state = state.copyWith(activo: false);
  }
}

final ubicacionProvider = NotifierProvider<UbicacionNotifier, TrackingState>(
  UbicacionNotifier.new,
);
