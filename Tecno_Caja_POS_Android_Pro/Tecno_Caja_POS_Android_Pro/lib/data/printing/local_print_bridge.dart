import 'dart:convert';

import 'package:dio/dio.dart';

import '../../core/errors/app_exception.dart';

/// Envía ESC/POS directamente al servicio local de Windows.
///
/// El navegador no puede escribir bytes RAW en una impresora instalada. Este
/// puente evita el diálogo PDF y, especialmente, los controladores gráficos
/// que deforman los recibos térmicos.
class LocalPrintBridge {
  LocalPrintBridge()
      : _client = Dio(
          BaseOptions(
            baseUrl: 'http://127.0.0.1:17840',
            connectTimeout: const Duration(seconds: 2),
            receiveTimeout: const Duration(seconds: 8),
            sendTimeout: const Duration(seconds: 8),
          ),
        );

  final Dio _client;

  Future<void> printRaw(
    List<int> bytes, {
    String printer = '80mm Series Printer',
  }) async {
    try {
      final response = await _client.post<Map<String, dynamic>>(
        '/print',
        data: {
          'printer': printer,
          'data': base64Encode(bytes),
        },
      );
      if (response.data?['ok'] != true) {
        throw PrinterException(
          message: response.data?['error']?.toString() ??
              'El servicio local rechazó la impresión.',
        );
      }
    } on PrinterException {
      rethrow;
    } catch (_) {
      throw const PrinterException(
        message:
            'No se encontró Tecno Caja Print Service en esta PC. Inicia el '
            'servicio local para imprimir directamente en la térmica.',
      );
    }
  }
}
