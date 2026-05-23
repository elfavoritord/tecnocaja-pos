import 'package:cloud_firestore/cloud_firestore.dart';

class UbicacionRepartidor {
  final double lat;
  final double lng;
  final DateTime timestamp;

  const UbicacionRepartidor({
    required this.lat,
    required this.lng,
    required this.timestamp,
  });

  factory UbicacionRepartidor.fromMap(Map<String, dynamic> m) =>
      UbicacionRepartidor(
        lat: (m['lat'] as num).toDouble(),
        lng: (m['lng'] as num).toDouble(),
        timestamp: (m['timestamp'] as Timestamp?)?.toDate() ?? DateTime.now(),
      );

  Map<String, dynamic> toMap() => {
        'lat': lat,
        'lng': lng,
        'timestamp': Timestamp.fromDate(timestamp),
      };
}

class RepartidorModel {
  final String uid;
  final String nombre;
  final String email;
  final String? telefono;
  final bool activo;
  final UbicacionRepartidor? ultimaUbicacion;
  final String? pedidoActual;
  final String rol;

  const RepartidorModel({
    required this.uid,
    required this.nombre,
    required this.email,
    this.telefono,
    required this.activo,
    this.ultimaUbicacion,
    this.pedidoActual,
    this.rol = 'repartidor',
  });

  factory RepartidorModel.fromDoc(DocumentSnapshot doc) {
    final m = doc.data() as Map<String, dynamic>;
    final ubMap = m['ultimaUbicacion'] as Map<String, dynamic>?;
    return RepartidorModel(
      uid: doc.id,
      nombre: m['nombre'] ?? '',
      email: m['email'] ?? '',
      telefono: m['telefono'] as String?,
      activo: m['activo'] as bool? ?? true,
      ultimaUbicacion:
          ubMap != null ? UbicacionRepartidor.fromMap(ubMap) : null,
      pedidoActual: m['pedidoActual'] as String?,
      rol: m['rol'] ?? 'repartidor',
    );
  }

  Map<String, dynamic> toMap() => {
        'uid': uid,
        'nombre': nombre,
        'email': email,
        'telefono': telefono,
        'activo': activo,
        'rol': rol,
        if (ultimaUbicacion != null)
          'ultimaUbicacion': ultimaUbicacion!.toMap(),
        'pedidoActual': pedidoActual,
      };
}
