import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/network/network_info.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../cloud/cloud_functions_service.dart';

class DgiiTaxpayer {
  const DgiiTaxpayer({
    required this.document,
    required this.found,
    this.name,
    this.commercialName,
    this.status,
    this.taxpayerType,
    this.category,
    this.address,
  });

  final String document;
  final bool found;
  final String? name;
  final String? commercialName;
  final String? status;
  final String? taxpayerType;
  final String? category;
  final String? address;

  factory DgiiTaxpayer.fromMap(Map<String, dynamic> map) => DgiiTaxpayer(
        document: map['rnc']?.toString() ?? '',
        found: map['found'] == true,
        name: _string(map['nombre']),
        commercialName: _string(map['nombreComercial']),
        status: _string(map['estado']),
        taxpayerType: _string(map['tipo']),
        category: _string(map['categoria']),
        address: _string(map['direccion']),
      );

  static String? _string(Object? value) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? null : text;
  }
}

class DgiiRepository {
  DgiiRepository(this._cloud, this._networkInfo);

  final CloudFunctionsService _cloud;
  final NetworkInfo _networkInfo;

  Future<DgiiTaxpayer> lookup(String document) async {
    final digits = document.replaceAll(RegExp(r'\D'), '');
    final formatError = Validators.cedulaORnc(digits);
    if (formatError != null) {
      throw ValidationException(message: formatError);
    }
    if (!await _networkInfo.isConnected) {
      throw const NetworkException(
        message: 'Sin Internet. Verifica la conexión antes de consultar DGII.',
      );
    }
    final result = await _cloud.dgiiLookup(digits);
    return DgiiTaxpayer.fromMap(result);
  }
}

final dgiiRepositoryProvider = Provider<DgiiRepository>((ref) {
  return DgiiRepository(
    ref.watch(cloudFunctionsServiceProvider),
    ref.watch(networkInfoProvider),
  );
});
