import '../core/utils/formatters.dart';

/// Una linea del carrito para efectos de calculo. No depende de Producto ni
/// de nada de Flutter/DB -- 100% puro para poder probarse con unit tests
/// simples (ITBIS, descuentos, redondeo son la logica mas sensible del POS).
class ItemCalculo {
  const ItemCalculo({
    required this.productoId,
    required this.cantidad,
    required this.precioUnitario,
    this.tasaItbis = 0.18,
    this.itbisIncluido = true,
    this.descuentoMonto = 0,
    this.descuentoPorcentaje = 0,
  });

  final String productoId;
  final double cantidad;

  /// Precio de venta tal cual esta en Producto (con o sin ITBIS segun
  /// [itbisIncluido]).
  final double precioUnitario;
  final double tasaItbis;
  final bool itbisIncluido;
  final double descuentoMonto;
  final double descuentoPorcentaje;

  double get subtotalBruto => precioUnitario * cantidad;

  double get descuentoTotal => descuentoMonto + (subtotalBruto * descuentoPorcentaje / 100);

  /// Total de la linea (con ITBIS si corresponde) despues de descuento.
  double get totalLinea {
    final valor = subtotalBruto - descuentoTotal;
    return valor < 0 ? 0 : valor;
  }

  double get baseSinItbis => itbisIncluido ? totalLinea / (1 + tasaItbis) : totalLinea;

  double get itbisLinea => itbisIncluido ? totalLinea - baseSinItbis : totalLinea * tasaItbis;

  /// Lo que efectivamente se cobra por esta linea (base + ITBIS).
  double get totalConItbis => itbisIncluido ? totalLinea : totalLinea + itbisLinea;
}

class ResultadoCalculoVenta {
  const ResultadoCalculoVenta({
    required this.subtotal,
    required this.itbis,
    required this.descuentoTotal,
    required this.totalAntesDeRedondeo,
    required this.redondeoAplicado,
    required this.total,
  });

  /// Suma de bases SIN ITBIS de todas las lineas.
  final double subtotal;
  final double itbis;
  final double descuentoTotal;
  final double totalAntesDeRedondeo;
  final double redondeoAplicado;
  final double total;
}

class CalculadoraVenta {
  const CalculadoraVenta._();

  static ResultadoCalculoVenta calcular({
    required List<ItemCalculo> items,
    double descuentoGlobalMonto = 0,
    double descuentoGlobalPorcentaje = 0,
    bool redondeoActivo = false,
    double redondeoPaso = 1.0,
  }) {
    var subtotal = 0.0;
    var itbis = 0.0;
    var descuentoItems = 0.0;

    for (final item in items) {
      subtotal += item.baseSinItbis;
      itbis += item.itbisLinea;
      descuentoItems += item.descuentoTotal;
    }

    final totalConItbisSinDescuentoGlobal = subtotal + itbis;
    final descuentoGlobal =
        descuentoGlobalMonto + (totalConItbisSinDescuentoGlobal * descuentoGlobalPorcentaje / 100);
    final totalAntesRedondeoBruto = totalConItbisSinDescuentoGlobal - descuentoGlobal;
    final totalAntesRedondeo = totalAntesRedondeoBruto < 0 ? 0.0 : totalAntesRedondeoBruto;

    final totalRedondeado =
        redondeoActivo ? Formatters.roundUpToStep(totalAntesRedondeo, redondeoPaso) : totalAntesRedondeo;
    final redondeoAplicado = totalRedondeado - totalAntesRedondeo;

    return ResultadoCalculoVenta(
      subtotal: subtotal,
      itbis: itbis,
      descuentoTotal: descuentoItems + descuentoGlobal,
      totalAntesDeRedondeo: totalAntesRedondeo,
      redondeoAplicado: redondeoAplicado,
      total: totalRedondeado,
    );
  }

  /// Nunca puede ser negativo, y la devuelta NUNCA se suma al total (regla
  /// explicita del negocio: si recibio de menos, el cambio es 0, no negativo).
  static double calcularCambio(double montoRecibido, double total) {
    final cambio = montoRecibido - total;
    return cambio < 0 ? 0 : cambio;
  }
}
