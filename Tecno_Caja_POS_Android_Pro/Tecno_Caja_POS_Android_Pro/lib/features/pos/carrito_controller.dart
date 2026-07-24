import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../domain/entities/producto.dart';

class LineaCarrito {
  const LineaCarrito({
    required this.producto,
    required this.cantidad,
    this.descuentoMonto = 0,
    this.descuentoPorcentaje = 0,
    this.precioOverride,
    this.nota,
  });

  final Producto producto;
  final double cantidad;
  final double descuentoMonto;
  final double descuentoPorcentaje;
  final double? precioOverride;
  final String? nota;

  double get precioUnitario => precioOverride ?? producto.precioVenta;

  double get subtotalLinea {
    final bruto = precioUnitario * cantidad;
    final descuento = descuentoMonto + (bruto * descuentoPorcentaje / 100);
    final neto = bruto - descuento;
    return neto < 0 ? 0 : neto;
  }

  LineaCarrito copyWith({
    double? cantidad,
    double? descuentoMonto,
    double? descuentoPorcentaje,
    double? precioOverride,
    String? nota,
  }) {
    return LineaCarrito(
      producto: producto,
      cantidad: cantidad ?? this.cantidad,
      descuentoMonto: descuentoMonto ?? this.descuentoMonto,
      descuentoPorcentaje: descuentoPorcentaje ?? this.descuentoPorcentaje,
      precioOverride: precioOverride ?? this.precioOverride,
      nota: nota ?? this.nota,
    );
  }
}

class CarritoState {
  const CarritoState({
    this.lineas = const [],
    this.clienteId,
    this.nombreCliente,
    this.descuentoGlobalMonto = 0,
    this.descuentoGlobalPorcentaje = 0,
  });

  final List<LineaCarrito> lineas;
  final String? clienteId;
  final String? nombreCliente;
  final double descuentoGlobalMonto;
  final double descuentoGlobalPorcentaje;

  bool get estaVacio => lineas.isEmpty;

  double get cantidadUnidades => lineas.fold(0, (s, l) => s + l.cantidad);

  double get subtotalBruto => lineas.fold(0, (s, l) => s + l.subtotalLinea);
}

class CarritoController extends Notifier<CarritoState> {
  @override
  CarritoState build() => const CarritoState();

  void agregarProducto(Producto producto) {
    final index = state.lineas.indexWhere((l) => l.producto.id == producto.id);
    if (index >= 0) {
      _reemplazarLinea(index, state.lineas[index].copyWith(cantidad: state.lineas[index].cantidad + 1));
    } else {
      state = CarritoState(
        lineas: [...state.lineas, LineaCarrito(producto: producto, cantidad: 1)],
        clienteId: state.clienteId,
        nombreCliente: state.nombreCliente,
        descuentoGlobalMonto: state.descuentoGlobalMonto,
        descuentoGlobalPorcentaje: state.descuentoGlobalPorcentaje,
      );
    }
  }

  void cambiarCantidad(String productoId, double nuevaCantidad) {
    final index = state.lineas.indexWhere((l) => l.producto.id == productoId);
    if (index < 0) return;
    if (nuevaCantidad <= 0) {
      _quitarIndice(index);
    } else {
      _reemplazarLinea(index, state.lineas[index].copyWith(cantidad: nuevaCantidad));
    }
  }

  void establecerDescuentoLinea(String productoId, {double? monto, double? porcentaje}) {
    final index = state.lineas.indexWhere((l) => l.producto.id == productoId);
    if (index < 0) return;
    _reemplazarLinea(index, state.lineas[index].copyWith(descuentoMonto: monto, descuentoPorcentaje: porcentaje));
  }

  void sobreescribirPrecio(String productoId, double? nuevoPrecio) {
    final index = state.lineas.indexWhere((l) => l.producto.id == productoId);
    if (index < 0) return;
    final linea = state.lineas[index];
    _reemplazarLinea(
      index,
      LineaCarrito(
        producto: linea.producto,
        cantidad: linea.cantidad,
        descuentoMonto: linea.descuentoMonto,
        descuentoPorcentaje: linea.descuentoPorcentaje,
        precioOverride: nuevoPrecio,
        nota: linea.nota,
      ),
    );
  }

  void quitarProducto(String productoId) {
    final index = state.lineas.indexWhere((l) => l.producto.id == productoId);
    if (index >= 0) _quitarIndice(index);
  }

  void establecerCliente(String? clienteId, String? nombre) {
    state = CarritoState(
      lineas: state.lineas,
      clienteId: clienteId,
      nombreCliente: nombre,
      descuentoGlobalMonto: state.descuentoGlobalMonto,
      descuentoGlobalPorcentaje: state.descuentoGlobalPorcentaje,
    );
  }

  void establecerDescuentoGlobal({double? monto, double? porcentaje}) {
    state = CarritoState(
      lineas: state.lineas,
      clienteId: state.clienteId,
      nombreCliente: state.nombreCliente,
      descuentoGlobalMonto: monto ?? state.descuentoGlobalMonto,
      descuentoGlobalPorcentaje: porcentaje ?? state.descuentoGlobalPorcentaje,
    );
  }

  void limpiar() => state = const CarritoState();

  /// Reemplaza el carrito completo con lineas ya armadas -- usado al
  /// recuperar una venta suspendida (ver VentasSesionScreen).
  void cargarLineas(List<LineaCarrito> lineas, {String? clienteId, String? nombreCliente}) {
    state = CarritoState(lineas: lineas, clienteId: clienteId, nombreCliente: nombreCliente);
  }

  void _reemplazarLinea(int index, LineaCarrito nueva) {
    final nuevas = [...state.lineas];
    nuevas[index] = nueva;
    state = CarritoState(
      lineas: nuevas,
      clienteId: state.clienteId,
      nombreCliente: state.nombreCliente,
      descuentoGlobalMonto: state.descuentoGlobalMonto,
      descuentoGlobalPorcentaje: state.descuentoGlobalPorcentaje,
    );
  }

  void _quitarIndice(int index) {
    final nuevas = [...state.lineas]..removeAt(index);
    state = CarritoState(
      lineas: nuevas,
      clienteId: state.clienteId,
      nombreCliente: state.nombreCliente,
      descuentoGlobalMonto: state.descuentoGlobalMonto,
      descuentoGlobalPorcentaje: state.descuentoGlobalPorcentaje,
    );
  }
}

final carritoControllerProvider = NotifierProvider<CarritoController, CarritoState>(CarritoController.new);
