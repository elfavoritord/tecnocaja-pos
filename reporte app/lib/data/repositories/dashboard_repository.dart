import 'dart:convert';
import 'dart:async';

import 'package:http/http.dart' as http;

import '../models/reports_dashboard_model.dart';
import '../services/novapos_api_settings_service.dart';
import '../services/pos_session_service.dart';

class DashboardRepository {
  DashboardRepository({http.Client? client})
    : _client = client ?? http.Client();

  final http.Client _client;
  static const Duration _requestTimeout = Duration(seconds: 15);

  Future<ReportsDashboardData> getDashboard({
    required ReportsRangePreset preset,
    String? branchId,
    String? cashRegisterId,
    String? cashierId,
  }) async {
    final range = preset.resolveRange(DateTime.now());
    final desde = _formatDate(range.from);
    final hasta = _formatDate(range.to);

    final filtersPayload =
        await _getJson('/api/reports/advanced/filtros') as Map<String, dynamic>;

    final branches = _parseBranches(filtersPayload['sucursales']);
    final cashRegisters = _parseCashRegisters(filtersPayload['cajas']);
    final cashiers = _parseCashiers(filtersPayload['usuarios']);

    final baseQuery = <String, String>{
      'desde': desde,
      'hasta': hasta,
      if (_hasValue(branchId)) 'branchId': branchId!.trim(),
      if (_hasValue(cashRegisterId)) 'cajaId': cashRegisterId!.trim(),
      if (_hasValue(cashierId)) 'userId': cashierId!.trim(),
    };

    final responses = await Future.wait<dynamic>([
      _getJson('/api/reports/advanced/kpis', queryParameters: baseQuery),
      _getJson('/api/reports/advanced/ventas-dia', queryParameters: baseQuery),
      _getJson(
        '/api/reports/advanced/metodos-pago',
        queryParameters: baseQuery,
      ),
      _getJson(
        '/api/reports/advanced/productos',
        queryParameters: {...baseQuery, 'limit': '8'},
      ),
    ]);

    return ReportsDashboardData(
      preset: preset,
      desde: desde,
      hasta: hasta,
      kpis: ReportsDashboardKpis.fromJson(_asMap(responses[0])),
      trend: _asList(
        responses[1],
      ).map(_asMap).map(ReportsTrendPoint.fromJson).toList(),
      paymentMethods: _asList(
        responses[2],
      ).map(_asMap).map(ReportsPaymentMethod.fromJson).toList(),
      topProducts: _asList(
        responses[3],
      ).map(_asMap).map(ReportsTopProduct.fromJson).toList(),
      branches: branches,
      cashRegisters: cashRegisters,
      cashiers: cashiers,
    );
  }

  void dispose() {
    _client.close();
  }

  Future<dynamic> _getJson(
    String path, {
    Map<String, String>? queryParameters,
    bool retryOnUnauthorized = true,
  }) async {
    final baseUrl = await NovaposApiSettingsService.instance.getBaseUrl();
    final sessionToken = await PosSessionService.instance.ensureSession();
    final uri = Uri.parse('$baseUrl$path').replace(
      queryParameters: queryParameters?.isEmpty == true
          ? null
          : queryParameters,
    );

    try {
      final response = await _client
          .get(uri, headers: _buildHeaders(sessionToken))
          .timeout(_requestTimeout);

      if (response.statusCode == 401 && retryOnUnauthorized) {
        await PosSessionService.instance.clearSession();
        final freshToken = await PosSessionService.instance.ensureSession(
          forceRefresh: true,
        );
        final retryResponse = await _client
            .get(uri, headers: _buildHeaders(freshToken))
            .timeout(_requestTimeout);
        return _decodeResponse(retryResponse);
      }

      return _decodeResponse(response);
    } on TimeoutException {
      throw StateError(
        'El servidor tardó demasiado en responder. Revisa la URL configurada y tu conexión.',
      );
    } on http.ClientException catch (error) {
      throw StateError(_friendlyClientError(error));
    }
  }

  Map<String, String> _buildHeaders(String token) {
    return <String, String>{
      'Accept': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  dynamic _decodeResponse(http.Response response) {
    final body = response.body.trim();
    final payload = body.isEmpty ? null : jsonDecode(body);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(_extractErrorMessage(payload, response.statusCode));
    }

    return payload;
  }

  String _extractErrorMessage(dynamic payload, int statusCode) {
    if (payload is Map<String, dynamic>) {
      final error = payload['error']?.toString().trim() ?? '';
      if (error.isNotEmpty) {
        return error;
      }
    }

    if (statusCode == 401) {
      return 'La sesión venció. Vuelve a intentar.';
    }

    return 'No se pudo cargar el panel de reportes. Código $statusCode.';
  }

  String _friendlyClientError(http.ClientException error) {
    final raw = error.message.toLowerCase();
    if (raw.contains('xmlhttprequest') ||
        raw.contains('cors') ||
        raw.contains('origin')) {
      return 'El servidor bloqueó esta app por CORS. Debes permitir el dominio desde donde abriste Tecno Reporte.';
    }

    return 'No se pudo conectar con el servidor. Revisa la URL configurada en Ajustes.';
  }

  List<DashboardFilterOption> _parseBranches(dynamic rawValue) {
    return _asList(rawValue)
        .map(_asMap)
        .map((item) {
          return DashboardFilterOption(
            id: item['id']?.toString() ?? '',
            label: item['nombre']?.toString() ?? 'Sucursal',
          );
        })
        .where((item) => item.id.isNotEmpty)
        .toList();
  }

  List<DashboardFilterOption> _parseCashRegisters(dynamic rawValue) {
    return _asList(rawValue)
        .map(_asMap)
        .map((item) {
          return DashboardFilterOption(
            id: item['id']?.toString() ?? '',
            label: item['nombre']?.toString() ?? 'Caja',
            parentId: item['branch_id']?.toString(),
          );
        })
        .where((item) => item.id.isNotEmpty)
        .toList();
  }

  List<DashboardFilterOption> _parseCashiers(dynamic rawValue) {
    return _asList(rawValue)
        .map(_asMap)
        .map((item) {
          final name = item['nombre']?.toString().trim() ?? '';
          final username = item['usuario']?.toString().trim() ?? '';
          return DashboardFilterOption(
            id: item['id']?.toString() ?? '',
            label: name.isNotEmpty
                ? name
                : (username.isNotEmpty ? username : 'Usuario'),
          );
        })
        .where((item) => item.id.isNotEmpty)
        .toList();
  }
}

List<dynamic> _asList(dynamic value) {
  if (value is List<dynamic>) {
    return value;
  }
  return const <dynamic>[];
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((key, entryValue) => MapEntry(key.toString(), entryValue));
  }
  return <String, dynamic>{};
}

bool _hasValue(String? value) => value != null && value.trim().isNotEmpty;

String _formatDate(DateTime value) {
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');
  return '$year-$month-$day';
}
