import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/pedido_delivery_model.dart';

class PedidosRepository {
  final FirebaseFirestore _db;

  PedidosRepository() : _db = FirebaseFirestore.instance;

  Future<PedidoDelivery> _mergeLegacyLocationData(PedidoDelivery pedido) async {
    if (pedido.tieneDestinoMapa && pedido.tieneReferencia) {
      return pedido;
    }
    if (pedido.numeroFactura.isEmpty) {
      return pedido;
    }

    try {
      final legacySnap = await _db
          .collectionGroup('delivery_orders')
          .where('invoice_number', isEqualTo: pedido.numeroFactura)
          .limit(1)
          .get();

      if (legacySnap.docs.isEmpty) {
        return pedido;
      }

      final legacyPedido = PedidoDelivery.fromDoc(legacySnap.docs.first);
      return pedido.copyWith(
        clienteDireccion: pedido.clienteDireccion.isNotEmpty
            ? pedido.clienteDireccion
            : legacyPedido.clienteDireccion,
        clienteReferencia: pedido.clienteReferencia.isNotEmpty
            ? pedido.clienteReferencia
            : legacyPedido.clienteReferencia,
        clienteLocationLink:
            pedido.clienteLocationLink ?? legacyPedido.clienteLocationLink,
      );
    } catch (_) {
      return pedido;
    }
  }

  Stream<List<PedidoDelivery>> pedidosActivos(String repartidorId) {
    return _db
        .collection('pedidos_delivery')
        .where('repartidorId', isEqualTo: repartidorId)
        .where('estado', whereIn: ['asignado', 'en_camino'])
        .snapshots()
        .map((snap) {
          final lista = snap.docs
              .map((d) => PedidoDelivery.fromDoc(d))
              .toList();
          lista.sort((a, b) => b.creadoEn.compareTo(a.creadoEn));
          return lista;
        });
  }

  Stream<List<PedidoDelivery>> historialPedidos(String repartidorId) {
    return _db
        .collection('pedidos_delivery')
        .where('repartidorId', isEqualTo: repartidorId)
        .where('estado', whereIn: ['entregado', 'incidencia'])
        .limit(50)
        .snapshots()
        .map((snap) {
          final lista = snap.docs
              .map((d) => PedidoDelivery.fromDoc(d))
              .toList();
          lista.sort((a, b) => b.actualizadoEn.compareTo(a.actualizadoEn));
          return lista;
        });
  }

  Stream<PedidoDelivery?> pedidoStream(String pedidoId) {
    return _db
        .collection('pedidos_delivery')
        .doc(pedidoId)
        .snapshots()
        .asyncMap((d) async {
          if (!d.exists) return null;
          final pedido = PedidoDelivery.fromDoc(d);
          return _mergeLegacyLocationData(pedido);
        });
  }

  Future<void> iniciarEntrega(String pedidoId) async {
    await _db.collection('pedidos_delivery').doc(pedidoId).update({
      'estado': 'en_camino',
      'actualizadoEn': FieldValue.serverTimestamp(),
    });
  }

  Future<void> confirmarEntrega({
    required String pedidoId,
    String? notas,
  }) async {
    await _db.collection('pedidos_delivery').doc(pedidoId).update({
      'estado': 'entregado',
      'actualizadoEn': FieldValue.serverTimestamp(),
      'entregadoEn': FieldValue.serverTimestamp(),
      if (notas != null && notas.isNotEmpty) 'notasRepartidor': notas,
    });
  }

  Future<void> reportarIncidencia({
    required String pedidoId,
    required String tipo,
    required String descripcion,
  }) async {
    final incidencia = Incidencia(
      tipo: tipo,
      descripcion: descripcion,
      timestamp: DateTime.now(),
    );
    await _db.collection('pedidos_delivery').doc(pedidoId).update({
      'estado': 'incidencia',
      'actualizadoEn': FieldValue.serverTimestamp(),
      'incidencias': FieldValue.arrayUnion([incidencia.toMap()]),
    });
  }
}
