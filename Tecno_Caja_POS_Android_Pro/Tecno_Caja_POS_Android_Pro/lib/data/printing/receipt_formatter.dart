import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:intl/intl.dart';

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
    final lineWidth = anchoMm >= 80 ? 48 : 32;

    final subtotal = _redondearMoneda(venta.subtotal, 'Subtotal');
    final descuento = _redondearMoneda(venta.descuentoMonto, 'Descuento');
    final impuesto = _redondearMoneda(venta.itbis, 'Impuesto');
    final redondeo = _redondearMoneda(venta.redondeoAplicado, 'Redondeo');
    final total = _redondearMoneda(venta.total, 'Total');
    final recibido = venta.montoRecibido == null
        ? null
        : _redondearMoneda(venta.montoRecibido!, 'Monto recibido');
    final cambio = recibido == null
        ? null
        : _redondearMoneda(
            (recibido - total).clamp(0, double.infinity).toDouble(),
            'Cambio',
          );

    List<int> bytes = [];

    bytes += generator.text(
      empresa.nombreComercial ?? empresa.nombre,
      styles: const PosStyles(
          align: PosAlign.center,
          bold: true,
          height: PosTextSize.size2,
          width: PosTextSize.size2),
    );
    if (empresa.nombreComercial != null &&
        empresa.nombreComercial!.trim().isNotEmpty &&
        empresa.nombreComercial!.trim() != empresa.nombre.trim()) {
      bytes += generator.text(empresa.nombre,
          styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.rncCedula != null && empresa.rncCedula!.isNotEmpty) {
      bytes += generator.text('RNC: ${empresa.rncCedula}',
          styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.direccion != null && empresa.direccion!.isNotEmpty) {
      bytes += generator.text(empresa.direccion!,
          styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.telefono != null && empresa.telefono!.isNotEmpty) {
      bytes += generator.text('Tel: ${empresa.telefono}',
          styles: const PosStyles(align: PosAlign.center));
    }
    if (empresa.email != null && empresa.email!.isNotEmpty) {
      bytes += generator.text(empresa.email!,
          styles: const PosStyles(align: PosAlign.center));
    }
    bytes += generator.hr();

    bytes += generator.text(
      venta.estado == EstadoVenta.anulada
          ? 'FACTURA ANULADA'
          : 'FACTURA DE VENTA',
      styles: const PosStyles(align: PosAlign.center, bold: true),
    );
    bytes += generator.text('Numero: ${_numeroFactura(venta)}');
    if (venta.encf != null && venta.encf!.isNotEmpty) {
      // NCF tradicional en esta fase (no e-CF: sin firma digital ni envío a
      // la DGII todavía, ver functions/fiscal.js).
      bytes += generator.text('NCF: ${venta.encf}');
    }
    bytes += generator.text('Fecha: ${Formatters.dateTime(venta.creadoEn)}');
    if (venta.cajaId != null && venta.cajaId!.isNotEmpty) {
      bytes += generator.text('Caja: ${_idCorto(venta.cajaId!)}');
    }
    if (venta.sesionCajaId != null && venta.sesionCajaId!.isNotEmpty) {
      bytes += generator.text('Turno: ${_idCorto(venta.sesionCajaId!)}');
    }
    bytes += generator.text('Cajero: $nombreCajero');
    bytes += generator.text(
        'Condicion: ${venta.metodoPago == MetodoPago.credito ? "Credito" : "Contado"}');
    bytes += generator.text('Moneda: $moneda');
    bytes += generator.text(
        'Cliente: ${nombreCliente?.trim().isNotEmpty == true ? nombreCliente : "Consumidor final"}');
    bytes += generator.hr();

    if (anchoMm >= 80) {
      bytes += generator.row([
        PosColumn(text: 'CANT', width: 2, styles: const PosStyles(bold: true)),
        PosColumn(
            text: 'DESCRIPCION', width: 5, styles: const PosStyles(bold: true)),
        PosColumn(
            text: 'PRECIO',
            width: 2,
            styles: const PosStyles(align: PosAlign.right, bold: true)),
        PosColumn(
            text: 'TOTAL',
            width: 3,
            styles: const PosStyles(align: PosAlign.right, bold: true)),
      ]);
      for (final item in items) {
        bytes += generator.row([
          PosColumn(text: _cantidad(item.cantidad), width: 2),
          PosColumn(text: item.nombreProductoSnapshot, width: 5),
          PosColumn(
            text: _importe(item.precioUnitario),
            width: 2,
            styles: const PosStyles(align: PosAlign.right),
          ),
          PosColumn(
            text: _importe(item.subtotalLinea),
            width: 3,
            styles: const PosStyles(align: PosAlign.right),
          ),
        ]);
      }
    } else {
      for (final item in items) {
        bytes += generator.text(
            '${_cantidad(item.cantidad)}  ${item.nombreProductoSnapshot}',
            styles: const PosStyles(bold: true));
        bytes += generator.row([
          PosColumn(
              text:
                  '${_cantidad(item.cantidad)} x ${_importe(item.precioUnitario)}',
              width: 8),
          PosColumn(
            text: _importe(item.subtotalLinea),
            width: 4,
            styles: const PosStyles(align: PosAlign.right),
          ),
        ]);
        if (item.descuentoMonto > 0) {
          bytes += generator.text(
              'Descuento: -${Formatters.currency(item.descuentoMonto, currency: moneda)}');
        }
      }
    }
    bytes += generator.hr();

    bytes += generator.text(
      _lineaMonto('Subtotal:', subtotal, lineWidth),
    );
    if (descuento > 0) {
      bytes += generator.text(
        _lineaMonto('Descuento:', -descuento, lineWidth),
      );
    }
    if (impuesto > 0) {
      bytes += generator.text(
        _lineaMonto(_etiquetaImpuesto(empresa), impuesto, lineWidth),
      );
    }
    if (redondeo != 0) {
      bytes += generator.text(
        _lineaMonto('Redondeo:', redondeo, lineWidth),
      );
    }

    bytes += generator.text('=' * lineWidth);
    bytes += generator.text(
      _lineaMonto('TOTAL:', total, lineWidth),
      styles: const PosStyles(bold: true),
    );
    bytes += generator.text('=' * lineWidth);

    bytes += generator.text(
      'Forma de pago: ${_etiquetaMetodoPago(venta.metodoPago)}',
    );
    if (recibido != null) {
      bytes += generator.text(
        _lineaMonto('Recibido:', recibido, lineWidth),
      );
      bytes += generator.text(
        _lineaMonto('Cambio:', cambio ?? 0, lineWidth),
      );
    }
    bytes += generator.hr();

    if (venta.ecfQrUrl != null && venta.ecfQrUrl!.isNotEmpty) {
      bytes += generator.feed(1);
      bytes += generator.qrcode(venta.ecfQrUrl!);
    }

    bytes += generator.feed(1);
    bytes += generator.text('Gracias por su compra.',
        styles: const PosStyles(align: PosAlign.center));
    bytes += generator.text('Conserve este comprobante.',
        styles: const PosStyles(align: PosAlign.center));
    bytes += generator.feed(2);
    bytes += generator.cut();

    return bytes;
  }

  static final NumberFormat _moneyFormat = NumberFormat('#,##0.00', 'en_US');

  static double _redondearMoneda(double valor, String campo) {
    if (!valor.isFinite) {
      throw StateError('El valor de $campo no es válido.');
    }
    return (valor * 100).round() / 100;
  }

  static String _formatearMonto(double valor) {
    final seguro = valor.isFinite ? _redondearMoneda(valor, 'importe') : 0.0;
    return _moneyFormat.format(seguro);
  }

  static String _lineaMonto(String etiqueta, double valor, int ancho) {
    final limpia = etiqueta.trim();
    final monto = _formatearMonto(valor);
    final espacios = ancho - limpia.length - monto.length;
    if (espacios < 1) {
      final maxLabel = (ancho - monto.length - 1).clamp(0, ancho).toInt();
      return '${limpia.substring(0, maxLabel)} $monto';
    }
    return '$limpia${' ' * espacios}$monto';
  }

  static String _cantidad(double cantidad) {
    return cantidad.truncateToDouble() == cantidad
        ? cantidad.toStringAsFixed(0)
        : cantidad.toStringAsFixed(2);
  }

  static String _importe(double value) => value.toStringAsFixed(2);

  static String _numeroFactura(Venta venta) {
    final numero = venta.numeroFactura?.trim();
    if (numero != null && numero.isNotEmpty) return numero;
    return _idCorto(venta.id);
  }

  static String _idCorto(String id) {
    final length = id.length < 8 ? id.length : 8;
    return id.substring(0, length).toUpperCase();
  }

  static String _etiquetaImpuesto(Empresa empresa) {
    if (empresa.pais.toUpperCase() != 'RD') return 'Impuesto:';
    final porcentaje = (empresa.tasaItbisDefault * 100).round();
    return 'ITBIS $porcentaje%:';
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
