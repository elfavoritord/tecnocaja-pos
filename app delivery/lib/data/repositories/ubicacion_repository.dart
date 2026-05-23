import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';
import '../services/location_service.dart';

class UbicacionRepository {
  final FirebaseFirestore _db;
  UbicacionRepository() : _db = FirebaseFirestore.instance;

  Future<void> actualizarUbicacion(String uid, Position position) async {
    await _db.collection('repartidores').doc(uid).update({
      'ultimaUbicacion': {
        'lat': position.latitude,
        'lng': position.longitude,
        'timestamp': FieldValue.serverTimestamp(),
      },
    });
  }

  Future<void> actualizarPedidoActual(String uid, String? pedidoId) async {
    await _db.collection('repartidores').doc(uid).update({
      'pedidoActual': pedidoId,
    });
  }

  Stream<Position> iniciarTracking(
    String uid, {
    void Function(Position)? onPosition,
  }) {
    final stream = LocationService.positionStream();
    stream.listen((pos) async {
      onPosition?.call(pos);
      try {
        await actualizarUbicacion(uid, pos);
      } catch (_) {}
    });
    return stream;
  }
}
