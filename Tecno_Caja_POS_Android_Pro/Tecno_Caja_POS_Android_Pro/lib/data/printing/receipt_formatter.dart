import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';

import '../../core/utils/formatters.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/venta.dart';

/// Arma los bytes ESC/POS del recibo de una venta. Separado del servicio de
/// impresion para poder probar el formato sin un dispositivo Bluetooth real.
class ReceiptFormatter {
  ReceiptFormatter._();

  static Future<List<int>> ticketDeVenta({
    required Venta venta,
    required List<VentaItem> items,
    required Empresa empresa,
    required String nombreCajero,
    String? nombreCliente,
    required int anchoMm,
  }) async {
    final profile = await CapabilityProfile.load();
    final paperSize = anchoMm >= 80 ? PaperSize.mm80 : PaperSize.mm58;
    final generator = Generator(paperSize, profile);
    final moneda = venta.moneda;

    List<int> bytes = [];

    bytes += generator.text(
      empresa.nombreComercial ?? empresa.nombre,
      styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size2, width: PosTextSize.size2),
    );
    if (empresa.rncCedula != null && empresa.rncCedula!.isNotEmpty) {
      bytes += generator.text('RNC: ${empresa.rncCedula}', styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.direccion != null && empresa.direccion!.isNotEmpty) {
      bytes += generator.text(empresa.direccion!, styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.telefono != null && empresa.telefono!.isNotEmpty) {
      bytes += generator.text('Tel: ${empresa.telefono}', styles: const PosStyles(align: PosAlign.center));
    }
    bytes += generator.hr();

    bytes += generator.text('Ticket: ${venta.numeroFactura ?? venta.id.substring(0, 8).toUpperCase()}');
    if (venta.encf != null && venta.encf!.isNotEmpty) {
      bytes += generator.text('e-NCF: ${venta.encf}');
    }
    bytes += generator.text('Fecha: ${Formatters.dateTime(venta.creadoEn)}');
    bytes += generator.text('Cajero: $nombreCajero');
    bytes += generator.text('Cliente: ${nombreCliente ?? "Venta anónima"}');
    if (venta.estado == EstadoVenta.anulada) {
      bytes += generator.text('*** ANULADA ***', styles: const PosStyles(align: PosAlign.center, bold: true));
    }
    bytes += generator.hr();

    for (final item in items) {
      bytes += generator.text(item.nombreProductoSnapshot, styles: const PosStyles(bold: true));
      bytes += generator.row([
        PosColumn(text: '${_cantidad(item.cantidad)} x ${Formatters.currency(item.precioUnitario, currency: moneda)}', width: 8),
        PosColumn(
          text: Formatters.currency(item.subtotalLinea, currency: moneda),
          width: 4,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]);
    }
    bytes += generator.hr();

    bytes += _fila(generator, 'Subtotal', venta.subtotal, moneda);
    if (venta.descuentoMonto > 0) bytes += _fila(generator, 'Descuento', -venta.descuentoMonto, moneda);
    bytes += _fila(generator, 'ITBIS', venta.itbis, moneda);
    if (venta.redondeoAplicado != 0) bytes += _fila(generator, 'Redondeo', venta.redondeoAplicado, moneda);

    bytes += generator.row([
      PosColumn(text: 'TOTAL', width: 6, styles: const PosStyles(bold: true, height: PosTextSize.size2)),
      PosColumn(
        text: Formatters.currency(venta.total, currency: moneda),
        width: 6,
        styles: const PosStyles(bold: true, align: PosAlign.right, height: PosTextSize.size2),
      ),
    ]);
    bytes += generator.hr();

    bytes += generator.text('Método de pago: ${_etiquetaMetodoPago(venta.metodoPago)}');
    if (venta.montoRecibido != null) {
      bytes += _fila(generator, 'Recibido', venta.montoRecibido!, moneda);
      bytes += _fila(generator, 'Devuelta', venta.cambio ?? 0, moneda);
    }

    if (venta.ecfQrUrl != null && venta.ecfQrUrl!.isNotEmpty) {
      bytes += generator.feed(1);
      bytes += generator.qrcode(venta.ecfQrUrl!);
    }

    bytes += generator.feed(1);
    bytes += generator.text('¡Gracias por su compra!', styles: const PosStyles(align: PosAlign.center));
    bytes += generator.text('Tecno Caja POS', styles: const PosStyles(align: PosAlign.center));
    bytes += generator.feed(2);
    bytes += generator.cut();

    return bytes;
  }

  static List<int> _fila(Generator generator, String etiqueta, double monto, String moneda) {
    return generator.row([
      PosColumn(text: etiqueta, width: 6),
      PosColumn(text: Formatters.currency(monto, currency: moneda), width: 6, styles: const PosStyles(align: PosAlign.right)),
    ]);
  }

  static String _cantidad(double cantidad) {
    return cantidad.truncateToDouble() == cantidad ? cantidad.toStringAsFixed(0) : cantidad.toStringAsFixed(2);
  }

  static String _etiquetaMetodoPago(String metodo) => switch (metodo) {
        MetodoPago.efectivo => 'Efectivo',
        MetodoPago.tarjeta => 'Tarjeta',
        MetodoPago.transferencia => 'Transferencia',
        MetodoPago.credito => 'Crédito',
        MetodoPago.combinado => 'Combinado',
        _ => metodo,
      };
}
