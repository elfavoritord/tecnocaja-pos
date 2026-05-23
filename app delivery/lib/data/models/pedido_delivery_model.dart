import 'package:cloud_firestore/cloud_firestore.dart';

String _normalizeOptionalText(dynamic value) {
  if (value == null) return '';
  final text = value.toString().trim();
  if (text.isEmpty) return '';
  final lowered = text.toLowerCase();
  if (lowered == 'null' || lowered == 'undefined') return '';
  return text;
}

String? _normalizeOptionalUrl(dynamic value) {
  final text = _normalizeOptionalText(value);
  if (text.isEmpty) return null;
  if (text.startsWith('http://') || text.startsWith('https://')) return text;
  return 'https://$text';
}

class ProductoPedido {
  final String nombre;
  final int cantidad;
  final double precio;

  const ProductoPedido({
    required this.nombre,
    required this.cantidad,
    required this.precio,
  });

  factory ProductoPedido.fromMap(Map<String, dynamic> m) => ProductoPedido(
    nombre: m['nombre'] ?? '',
    cantidad: (m['cantidad'] as num?)?.toInt() ?? 1,
    precio: (m['precio'] as num?)?.toDouble() ?? 0,
  );

  Map<String, dynamic> toMap() => {
    'nombre': nombre,
    'cantidad': cantidad,
    'precio': precio,
  };
}

class Incidencia {
  final String tipo;
  final String descripcion;
  final DateTime timestamp;

  const Incidencia({
    required this.tipo,
    required this.descripcion,
    required this.timestamp,
  });

  factory Incidencia.fromMap(Map<String, dynamic> m) => Incidencia(
    tipo: m['tipo'] ?? '',
    descripcion: m['descripcion'] ?? '',
    timestamp: (m['timestamp'] as Timestamp?)?.toDate() ?? DateTime.now(),
  );

  Map<String, dynamic> toMap() => {
    'tipo': tipo,
    'descripcion': descripcion,
    'timestamp': Timestamp.fromDate(timestamp),
  };
}

class PedidoDelivery {
  final String id;
  final String numeroFactura;
  final String clienteNombre;
  final String clienteTelefono;
  final String clienteDireccion;
  final String clienteReferencia;
  final String? clienteLocationLink;
  final double? clienteLat;
  final double? clienteLng;
  final String negocioNombre;
  final String repartidorId;
  final String repartidorNombre;
  final String estado;
  final double total;
  final List<ProductoPedido> productos;
  final String? notasInternas;
  final List<Incidencia> incidencias;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final DateTime? entregadoEn;

  const PedidoDelivery({
    required this.id,
    required this.numeroFactura,
    required this.clienteNombre,
    required this.clienteTelefono,
    required this.clienteDireccion,
    required this.clienteReferencia,
    required this.clienteLocationLink,
    this.clienteLat,
    this.clienteLng,
    required this.negocioNombre,
    required this.repartidorId,
    required this.repartidorNombre,
    required this.estado,
    required this.total,
    required this.productos,
    this.notasInternas,
    required this.incidencias,
    required this.creadoEn,
    required this.actualizadoEn,
    this.entregadoEn,
  });

  factory PedidoDelivery.fromDoc(DocumentSnapshot doc) {
    final m = doc.data() as Map<String, dynamic>;
    return PedidoDelivery(
      id: doc.id,
      numeroFactura: _normalizeOptionalText(m['numeroFactura']),
      clienteNombre: _normalizeOptionalText(m['clienteNombre']),
      clienteTelefono: _normalizeOptionalText(m['clienteTelefono']),
      clienteDireccion: _normalizeOptionalText(
        m['clienteDireccion'] ?? m['address'],
      ),
      clienteReferencia: _normalizeOptionalText(
        m['clienteReferencia'] ?? m['reference'],
      ),
      clienteLocationLink: _normalizeOptionalUrl(
        m['clienteLocationLink'] ?? m['location_link'],
      ),
      clienteLat: (m['clienteLat'] as num?)?.toDouble(),
      clienteLng: (m['clienteLng'] as num?)?.toDouble(),
      negocioNombre: _normalizeOptionalText(m['negocioNombre']),
      repartidorId: _normalizeOptionalText(m['repartidorId']),
      repartidorNombre: _normalizeOptionalText(m['repartidorNombre']),
      estado: _normalizeOptionalText(m['estado']).isEmpty
          ? 'asignado'
          : _normalizeOptionalText(m['estado']),
      total: (m['total'] as num?)?.toDouble() ?? 0,
      productos: ((m['productos'] as List?) ?? [])
          .map((p) => ProductoPedido.fromMap(p as Map<String, dynamic>))
          .toList(),
      notasInternas: _normalizeOptionalText(m['notasInternas']).isEmpty
          ? null
          : _normalizeOptionalText(m['notasInternas']),
      incidencias: ((m['incidencias'] as List?) ?? [])
          .map((i) => Incidencia.fromMap(i as Map<String, dynamic>))
          .toList(),
      creadoEn: (m['creadoEn'] as Timestamp?)?.toDate() ?? DateTime.now(),
      actualizadoEn:
          (m['actualizadoEn'] as Timestamp?)?.toDate() ?? DateTime.now(),
      entregadoEn: (m['entregadoEn'] as Timestamp?)?.toDate(),
    );
  }

  PedidoDelivery copyWith({
    String? clienteDireccion,
    String? clienteReferencia,
    String? clienteLocationLink,
  }) {
    return PedidoDelivery(
      id: id,
      numeroFactura: numeroFactura,
      clienteNombre: clienteNombre,
      clienteTelefono: clienteTelefono,
      clienteDireccion: clienteDireccion ?? this.clienteDireccion,
      clienteReferencia: clienteReferencia ?? this.clienteReferencia,
      clienteLocationLink: clienteLocationLink ?? this.clienteLocationLink,
      clienteLat: clienteLat,
      clienteLng: clienteLng,
      negocioNombre: negocioNombre,
      repartidorId: repartidorId,
      repartidorNombre: repartidorNombre,
      estado: estado,
      total: total,
      productos: productos,
      notasInternas: notasInternas,
      incidencias: incidencias,
      creadoEn: creadoEn,
      actualizadoEn: actualizadoEn,
      entregadoEn: entregadoEn,
    );
  }

  bool get tieneUbicacion => clienteLat != null && clienteLng != null;
  bool get tieneDireccion => clienteDireccion.isNotEmpty;
  bool get tieneReferencia => clienteReferencia.isNotEmpty;
  bool get tieneLocationLink => clienteLocationLink != null;
  bool get tieneDestinoMapa =>
      tieneLocationLink || tieneUbicacion || tieneDireccion;

  String? get googleMapsUrl {
    if (tieneLocationLink) {
      return clienteLocationLink;
    }
    if (tieneUbicacion) {
      return 'https://maps.google.com/?q=$clienteLat,$clienteLng';
    }
    if (!tieneDireccion) return null;
    final encoded = Uri.encodeComponent(clienteDireccion);
    return 'https://maps.google.com/?q=$encoded';
  }

  String get whatsappUrl {
    final phone = clienteTelefono.replaceAll(RegExp(r'[^\d]'), '');
    final msg = Uri.encodeComponent(
      'Hola $clienteNombre, soy el repartidor de $negocioNombre. '
      'Estoy en camino con tu pedido #$numeroFactura.',
    );
    return 'https://wa.me/1809$phone?text=$msg';
  }
}
