import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';

/// Puente a las Cloud Functions del backend central (carpeta hermana
/// `functions/`, junto a este proyecto Flutter) — el servicio fiscal y la
/// creación de empresa 100% móvil viven ahí, no en
/// `mobile-auth.routes.js`/`mobile-sync.routes.js`
/// (esas son REST contra Windows, esto es Firestore/Firebase directo, sin
/// pasar por Windows en absoluto). Ver plan de sincronización en memoria del
/// proyecto ("Plataforma móvil multiempresa").
class CloudFunctionsService {
  CloudFunctionsService() : _functions = FirebaseFunctions.instance;

  final FirebaseFunctions _functions;

  Future<Map<String, dynamic>> createMobileCompany(Map<String, dynamic> datos) {
    return _call('createMobileCompany', datos);
  }

  Future<Map<String, dynamic>> getMyCompanyBootstrap() {
    return _call('getMyCompanyBootstrap', const {});
  }

  Future<Map<String, dynamic>> createBusinessUser(Map<String, dynamic> data) {
    return _call('createBusinessUser', data);
  }

  Future<Map<String, dynamic>> updateBusinessUser(Map<String, dynamic> data) {
    return _call('updateBusinessUser', data);
  }

  Future<Map<String, dynamic>> acquireCashRegister({
    required String registerId,
    required String deviceId,
    required double openingAmount,
  }) {
    return _call('acquireCashRegister', {
      'registerId': registerId,
      'deviceId': deviceId,
      'openingAmount': openingAmount,
    });
  }

  Future<Map<String, dynamic>> releaseCashRegister(String registerId) {
    return _call('releaseCashRegister', {'registerId': registerId});
  }

  Future<Map<String, dynamic>> getMyOpenCashRegister() {
    return _call('getMyOpenCashRegister', const {});
  }

  Future<Map<String, dynamic>> syncSales(List<Map<String, dynamic>> sales) {
    return _call('syncSales', {'sales': sales});
  }

  Future<Map<String, dynamic>> getMyBusinessLicense() {
    return _call('getMyBusinessLicense', const {});
  }

  Future<Map<String, dynamic>> requestNcf({
    required String businessId,
    required String branchId,
    required String saleId,
    required String ncfType,
    String ambiente = 'certificacion',
  }) {
    return _call('requestNcf', {
      'businessId': businessId,
      'branchId': branchId,
      'saleId': saleId,
      'ncfType': ncfType,
      'ambiente': ambiente,
    });
  }

  Future<Map<String, dynamic>> _call(
      String nombre, Map<String, dynamic> datos) async {
    // cloud_functions_web ha tenido bugs de interop con valores `null` dentro
    // del mapa de parámetros (lanza un TypeError de casteo ANTES de que la
    // llamada llegue a salir por red -- por eso nunca aparece en
    // `firebase functions:log`). Se limpia el payload por las dudas: no hay
    // ningún campo de esta API donde enviar `null` explícito importe (el
    // backend ya trata ausente == null).
    final datosLimpios = Map<String, dynamic>.fromEntries(
      datos.entries.where((e) => e.value != null),
    );
    final datosParaLog = Map<String, dynamic>.from(datosLimpios);
    for (final key in ['password', 'contrasena', 'token', 'secret']) {
      if (datosParaLog.containsKey(key)) datosParaLog[key] = '[REDACTED]';
    }
    debugPrint('[CloudFunctionsService] -> $nombre: $datosParaLog');
    try {
      // No se parametriza `call<Map<...>>`: en Web el valor llega como un
      // objeto JS y algunas versiones del plugin intentan castear sus campos
      // antes de convertirlo a un Map de Dart.
      final resultado =
          await _functions.httpsCallable(nombre).call<dynamic>(datosLimpios);
      debugPrint('[CloudFunctionsService] <- $nombre ok: ${resultado.data}');
      final data = resultado.data;
      if (data is! Map) {
        throw const FormatException(
            'La respuesta del servidor no es un objeto.');
      }
      return data.map((key, value) => MapEntry(key.toString(), value));
    } on FirebaseFunctionsException catch (e, st) {
      debugPrint(
          '[CloudFunctionsService] <- $nombre FirebaseFunctionsException code=${e.code} message=${e.message} details=${e.details}\n$st');
      throw _mapear(e);
    } catch (e, st) {
      debugPrint(
          '[CloudFunctionsService] <- $nombre error inesperado (${e.runtimeType}): $e\n$st');
      throw UnknownAppException(
          message: 'No se pudo comunicar con el servidor: $e', cause: e);
    }
  }

  AppException _mapear(FirebaseFunctionsException e) {
    final mensaje = e.message ?? 'Ocurrió un error en el servidor.';
    switch (e.code) {
      case 'unauthenticated':
        return UnauthorizedException(message: mensaje, cause: e);
      case 'permission-denied':
        return ForbiddenException(message: mensaje, cause: e);
      case 'invalid-argument':
      case 'failed-precondition':
        return ValidationException(message: mensaje, cause: e);
      case 'not-found':
        return NotFoundException(message: mensaje, cause: e);
      case 'already-exists':
      case 'resource-exhausted':
        return ConflictException(message: mensaje, cause: e);
      case 'unavailable':
      case 'deadline-exceeded':
        return NetworkException(message: mensaje, cause: e);
      default:
        return ServerException(message: mensaje, cause: e);
    }
  }
}

final cloudFunctionsServiceProvider =
    Provider<CloudFunctionsService>((ref) => CloudFunctionsService());
