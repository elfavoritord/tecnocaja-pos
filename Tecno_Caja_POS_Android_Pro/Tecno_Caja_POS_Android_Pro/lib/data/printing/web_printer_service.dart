import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../../core/errors/app_exception.dart';
import '../../core/utils/formatters.dart';
import '../../domain/entities/empresa.dart';
import '../../domain/entities/producto.dart';
import '../../domain/entities/venta.dart';

class WebPrinterService {
  PdfPageFormat thermalFormat(int widthMm, {double heightMm = 110}) =>
      PdfPageFormat(
        widthMm * PdfPageFormat.mm,
        heightMm * PdfPageFormat.mm,
        marginAll: 3 * PdfPageFormat.mm,
      );

  Future<Uint8List> _receipt({
    required Venta sale,
    required List<VentaItem> items,
    required Empresa company,
    required String cashier,
    required int widthMm,
    String? customer,
  }) async {
    final document = pw.Document();
    final is80 = widthMm >= 80;
    final height = 125.0 + (items.length * (is80 ? 11 : 16));
    final businessName = _nonEmpty(company.nombreComercial) ?? company.nombre;
    final invoiceNumber = _invoiceNumber(sale);
    final taxName = _taxName(company);
    final currency = sale.moneda;
    pw.ImageProvider? logo;
    final logoPath = _nonEmpty(company.logoPath);
    if (logoPath != null &&
        (logoPath.startsWith('https://') || logoPath.startsWith('http://'))) {
      try {
        logo = await networkImage(logoPath);
      } catch (_) {
        // Una imagen inaccesible no debe impedir imprimir la factura.
      }
    }
    document.addPage(pw.Page(
      pageFormat: thermalFormat(widthMm, heightMm: height),
      build: (_) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: [
          if (logo != null) ...[
            pw.Center(
                child: pw.Image(logo,
                    width: is80 ? 70 : 50,
                    height: is80 ? 42 : 32,
                    fit: pw.BoxFit.contain)),
            pw.SizedBox(height: 3),
          ],
          pw.Text(businessName,
              textAlign: pw.TextAlign.center,
              style: pw.TextStyle(
                  fontSize: is80 ? 16 : 13, fontWeight: pw.FontWeight.bold)),
          if (_nonEmpty(company.nombreComercial) != null &&
              company.nombre.trim() != businessName.trim())
            pw.Text(company.nombre,
                textAlign: pw.TextAlign.center,
                style: const pw.TextStyle(fontSize: 8)),
          if (company.rncCedula?.isNotEmpty == true)
            _center('RNC/ID fiscal: ${company.rncCedula}'),
          if (_nonEmpty(company.direccion) != null) _center(company.direccion!),
          if (_nonEmpty(company.telefono) != null)
            _center('Tel: ${company.telefono}'),
          if (_nonEmpty(company.email) != null) _center(company.email!),
          pw.SizedBox(height: 5),
          pw.Container(
            padding: const pw.EdgeInsets.symmetric(vertical: 3),
            decoration: const pw.BoxDecoration(
              border: pw.Border(
                top: pw.BorderSide(),
                bottom: pw.BorderSide(),
              ),
            ),
            child: pw.Text(
              sale.estado == EstadoVenta.anulada
                  ? 'FACTURA ANULADA'
                  : 'FACTURA DE VENTA',
              textAlign: pw.TextAlign.center,
              style: pw.TextStyle(
                  fontSize: is80 ? 12 : 10, fontWeight: pw.FontWeight.bold),
            ),
          ),
          pw.SizedBox(height: 4),
          _info('Número', invoiceNumber),
          if (_nonEmpty(sale.encf) != null) _info('e-NCF', sale.encf!),
          _info('Fecha', Formatters.dateTime(sale.creadoEn)),
          _info('Caja', _shortId(sale.cajaId)),
          _info('Turno', _shortId(sale.sesionCajaId)),
          _info('Cajero', cashier),
          _info('Condición',
              sale.metodoPago == MetodoPago.credito ? 'Crédito' : 'Contado'),
          _info('Moneda', currency),
          pw.SizedBox(height: 3),
          pw.Text(
            'Cliente: ${_nonEmpty(customer) ?? 'Consumidor final'}',
            style: const pw.TextStyle(fontSize: 8),
          ),
          pw.Divider(),
          if (is80) _productHeader80(),
          ...items.map((item) =>
              is80 ? _product80(item, currency) : _product58(item, currency)),
          pw.Divider(),
          _total('Subtotal', sale.subtotal, currency),
          if (sale.descuentoMonto > 0)
            _total('Descuento', -sale.descuentoMonto, currency),
          if (sale.itbis > 0) _total(taxName, sale.itbis, currency),
          if (sale.redondeoAplicado != 0)
            _total('Redondeo', sale.redondeoAplicado, currency),
          pw.Divider(),
          _total('TOTAL', sale.total, currency, bold: true, large: true),
          pw.Divider(),
          _info('Forma de pago', _paymentName(sale.metodoPago)),
          if (sale.montoRecibido != null)
            _total('Efectivo recibido', sale.montoRecibido!, currency),
          if (sale.cambio != null) _total('Cambio', sale.cambio!, currency),
          if (_nonEmpty(sale.ecfQrUrl) != null) ...[
            pw.SizedBox(height: 5),
            pw.Center(
              child: pw.BarcodeWidget(
                barcode: pw.Barcode.qrCode(),
                data: sale.ecfQrUrl!,
                width: is80 ? 75 : 58,
                height: is80 ? 75 : 58,
              ),
            ),
          ],
          pw.SizedBox(height: 8),
          pw.Text('Gracias por su compra.',
              textAlign: pw.TextAlign.center,
              style: pw.TextStyle(fontWeight: pw.FontWeight.bold)),
          pw.Text('Conserve este comprobante.',
              textAlign: pw.TextAlign.center,
              style: const pw.TextStyle(fontSize: 7)),
        ],
      ),
    ));
    return document.save();
  }

  pw.Widget _center(String text) => pw.Text(
        text,
        textAlign: pw.TextAlign.center,
        style: const pw.TextStyle(fontSize: 8),
      );

  pw.Widget _info(String label, String value) => pw.Row(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          pw.SizedBox(
            width: 48,
            child: pw.Text('$label:',
                style:
                    pw.TextStyle(fontSize: 8, fontWeight: pw.FontWeight.bold)),
          ),
          pw.Expanded(
              child: pw.Text(value, style: const pw.TextStyle(fontSize: 8))),
        ],
      );

  pw.Widget _productHeader80() => pw.Container(
        padding: const pw.EdgeInsets.only(bottom: 2),
        child: pw.Row(children: [
          pw.SizedBox(
              width: 28,
              child: pw.Text('CANT.',
                  style: pw.TextStyle(
                      fontSize: 7, fontWeight: pw.FontWeight.bold))),
          pw.Expanded(
              child: pw.Text('DESCRIPCIÓN',
                  style: pw.TextStyle(
                      fontSize: 7, fontWeight: pw.FontWeight.bold))),
          pw.SizedBox(
              width: 42,
              child: pw.Text('PRECIO',
                  textAlign: pw.TextAlign.right,
                  style: pw.TextStyle(
                      fontSize: 7, fontWeight: pw.FontWeight.bold))),
          pw.SizedBox(
              width: 46,
              child: pw.Text('TOTAL',
                  textAlign: pw.TextAlign.right,
                  style: pw.TextStyle(
                      fontSize: 7, fontWeight: pw.FontWeight.bold))),
        ]),
      );

  pw.Widget _product80(VentaItem item, String currency) => pw.Padding(
        padding: const pw.EdgeInsets.only(bottom: 4),
        child: pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.SizedBox(
                width: 28,
                child: pw.Text(_quantity(item.cantidad),
                    style: const pw.TextStyle(fontSize: 8))),
            pw.Expanded(
                child: pw.Text(item.nombreProductoSnapshot,
                    style: const pw.TextStyle(fontSize: 8))),
            pw.SizedBox(
                width: 42,
                child: pw.Text(_money(item.precioUnitario, currency),
                    textAlign: pw.TextAlign.right,
                    style: const pw.TextStyle(fontSize: 8))),
            pw.SizedBox(
                width: 46,
                child: pw.Text(_money(item.subtotalLinea, currency),
                    textAlign: pw.TextAlign.right,
                    style: const pw.TextStyle(fontSize: 8))),
          ],
        ),
      );

  pw.Widget _product58(VentaItem item, String currency) => pw.Padding(
        padding: const pw.EdgeInsets.only(bottom: 5),
        child: pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.stretch,
          children: [
            pw.Text(
                '${_quantity(item.cantidad)}  '
                '${item.nombreProductoSnapshot}',
                style:
                    pw.TextStyle(fontSize: 8, fontWeight: pw.FontWeight.bold)),
            pw.Row(
              mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
              children: [
                pw.Text(
                    '${_quantity(item.cantidad)} x '
                    '${_money(item.precioUnitario, currency)}',
                    style: const pw.TextStyle(fontSize: 8)),
                pw.Text(_money(item.subtotalLinea, currency),
                    style: const pw.TextStyle(fontSize: 8)),
              ],
            ),
            if (item.descuentoMonto > 0)
              pw.Text('Descuento: -${_money(item.descuentoMonto, currency)}',
                  style: const pw.TextStyle(fontSize: 7)),
          ],
        ),
      );

  pw.Widget _total(String label, double amount, String currency,
      {bool bold = false, bool large = false}) {
    final style = bold ? pw.TextStyle(fontWeight: pw.FontWeight.bold) : null;
    return pw.Row(
      mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
      children: [
        pw.Text(label,
            style: large
                ? pw.TextStyle(fontSize: 13, fontWeight: pw.FontWeight.bold)
                : style),
        pw.Text(_money(amount, currency),
            style: large
                ? pw.TextStyle(fontSize: 13, fontWeight: pw.FontWeight.bold)
                : style),
      ],
    );
  }

  String _money(double value, String currency) =>
      Formatters.currency(value, currency: currency);

  String _quantity(double value) => value.truncateToDouble() == value
      ? value.toStringAsFixed(0)
      : value.toStringAsFixed(2);

  String _invoiceNumber(Venta sale) =>
      _nonEmpty(sale.numeroFactura) ??
      sale.id
          .substring(0, sale.id.length < 8 ? sale.id.length : 8)
          .toUpperCase();

  String _shortId(String? value) {
    final safe = _nonEmpty(value);
    if (safe == null) return 'N/D';
    return safe.length <= 8 ? safe : safe.substring(0, 8).toUpperCase();
  }

  String? _nonEmpty(String? value) {
    final clean = value?.trim();
    return clean == null || clean.isEmpty ? null : clean;
  }

  String _taxName(Empresa company) =>
      company.pais.toUpperCase() == 'RD' ? 'ITBIS' : 'Impuesto';

  String _paymentName(String method) => switch (method) {
        MetodoPago.efectivo => 'Efectivo',
        MetodoPago.tarjeta => 'Tarjeta',
        MetodoPago.transferencia => 'Transferencia',
        MetodoPago.credito => 'Crédito',
        MetodoPago.combinado => 'Pago combinado',
        _ => method,
      };

  Future<void> printSale({
    required Venta sale,
    required List<VentaItem> items,
    required Empresa company,
    required String cashier,
    required int widthMm,
    String? customer,
  }) {
    final format = thermalFormat(
      widthMm,
      heightMm: 125 + (items.length * (widthMm >= 80 ? 11 : 16)),
    );
    return _withPrintGuard(() => Printing.layoutPdf(
          name: 'Factura ${sale.numeroFactura}',
          format: format,
          onLayout: (_) => _receipt(
            sale: sale,
            items: items,
            company: company,
            cashier: cashier,
            widthMm: widthMm,
            customer: customer,
          ),
        ));
  }

  Future<void> printTest(int widthMm) async {
    final document = pw.Document();
    document.addPage(pw.Page(
      pageFormat: thermalFormat(widthMm),
      build: (_) => pw.Column(children: [
        pw.Text('Tecno Caja POS',
            style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold)),
        pw.Text('Prueba de impresora web'),
        pw.Text('Papel configurado: $widthMm mm'),
        pw.Divider(),
        pw.Text('La impresora de esta PC esta lista.'),
      ]),
    ));
    await _withPrintGuard(() => Printing.layoutPdf(
          name: 'Prueba Tecno Caja POS',
          format: thermalFormat(widthMm),
          onLayout: (_) => document.save(),
        ));
  }

  Future<void> printLabels({
    required Producto product,
    required int quantity,
    required int widthMm,
    required int heightMm,
  }) async {
    final document = pw.Document();
    final format = PdfPageFormat(
      widthMm * PdfPageFormat.mm,
      heightMm * PdfPageFormat.mm,
      marginAll: 2 * PdfPageFormat.mm,
    );
    for (var index = 0; index < quantity; index++) {
      document.addPage(pw.Page(
        pageFormat: format,
        build: (_) => pw.Column(
          mainAxisAlignment: pw.MainAxisAlignment.center,
          children: [
            pw.Text(product.nombre,
                textAlign: pw.TextAlign.center,
                maxLines: 2,
                style: pw.TextStyle(fontWeight: pw.FontWeight.bold)),
            pw.SizedBox(height: 2),
            pw.BarcodeWidget(
              barcode: pw.Barcode.code128(),
              data: product.codigoBarras ?? product.sku ?? product.id,
              height: 24,
              drawText: true,
            ),
            pw.SizedBox(height: 2),
            pw.Text('RD\$ ${product.precioVenta.toStringAsFixed(2)}',
                style: pw.TextStyle(fontWeight: pw.FontWeight.bold)),
          ],
        ),
      ));
    }
    await _withPrintGuard(() => Printing.layoutPdf(
          name: 'Etiquetas ${product.nombre}',
          format: format,
          onLayout: (_) => document.save(),
        ));
  }

  Future<void> _withPrintGuard(Future<bool> Function() action) async {
    try {
      final accepted = await action().timeout(const Duration(seconds: 60));
      if (!accepted) {
        throw const PrinterException(
          message: 'La impresión fue cancelada o rechazada por el navegador.',
        );
      }
    } on PrinterException {
      rethrow;
    } catch (error) {
      throw PrinterException(
        message:
            'No se pudo abrir la impresora de la PC. La venta permanece guardada. $error',
      );
    }
  }
}

final webPrinterServiceProvider =
    Provider<WebPrinterService>((ref) => WebPrinterService());
