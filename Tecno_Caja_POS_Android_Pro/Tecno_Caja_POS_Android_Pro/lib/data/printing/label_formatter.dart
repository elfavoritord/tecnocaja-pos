import 'dart:convert';

import '../../domain/entities/producto.dart';

class LabelFormatter {
  static List<int> tspl({
    required Producto product,
    required int quantity,
    required int widthMm,
    required int heightMm,
    required int gapMm,
  }) {
    final name = _safe(product.nombre, 28);
    final code = _safe(
      product.codigoBarras?.trim().isNotEmpty == true
          ? product.codigoBarras!
          : (product.sku ?? product.id),
      32,
    );
    final price = 'RD\$ ${product.precioVenta.toStringAsFixed(2)}';
    final command = '''
SIZE $widthMm mm,$heightMm mm
GAP $gapMm mm,0 mm
DIRECTION 1
REFERENCE 0,0
CLS
TEXT 20,15,"3",0,1,1,"$name"
BARCODE 20,55,"128",60,1,0,2,2,"$code"
TEXT 20,130,"3",0,1,1,"$price"
PRINT 1,$quantity
''';
    return latin1.encode(command);
  }

  static String _safe(String value, int max) {
    final normalized = value
        .replaceAll('"', "'")
        .replaceAll('á', 'a')
        .replaceAll('é', 'e')
        .replaceAll('í', 'i')
        .replaceAll('ó', 'o')
        .replaceAll('ú', 'u')
        .replaceAll('ñ', 'n');
    return normalized.length <= max ? normalized : normalized.substring(0, max);
  }
}
