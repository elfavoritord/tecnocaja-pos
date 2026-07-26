import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../auth/auth_controller.dart';
import '../cloud/cloud_functions_service.dart';

enum LicenseStatus { trial, active, suspended, expired, unknown }

class BusinessLicense {
  const BusinessLicense({
    required this.status,
    this.planCode,
    this.planName,
    this.trialEndsAt,
    this.expiresAt,
    this.message,
    this.maxUsers,
    this.maxDevices,
    this.maxBranches,
    this.maxRegisters,
    this.modules = const [],
    this.fromCache = false,
  });

  final LicenseStatus status;
  final String? planCode;
  final String? planName;
  final DateTime? trialEndsAt;
  final DateTime? expiresAt;
  final String? message;
  final int? maxUsers;
  final int? maxDevices;
  final int? maxBranches;
  final int? maxRegisters;
  final List<String> modules;
  final bool fromCache;

  bool get allowsOperations =>
      status == LicenseStatus.trial || status == LicenseStatus.active;

  int? get remainingTrialDays {
    if (status != LicenseStatus.trial || trialEndsAt == null) return null;
    final difference = trialEndsAt!.difference(DateTime.now());
    return difference.isNegative ? 0 : (difference.inHours / 24).ceil();
  }

  factory BusinessLicense.fromJson(
    Map<String, dynamic> json, {
    bool fromCache = false,
  }) {
    final rawStatus = json['status']?.toString().toLowerCase();
    return BusinessLicense(
      status: LicenseStatus.values.firstWhere(
        (value) => value.name == rawStatus,
        orElse: () => LicenseStatus.unknown,
      ),
      planCode: json['planCode']?.toString(),
      planName: json['planName']?.toString(),
      trialEndsAt: DateTime.tryParse(json['trialEndsAt']?.toString() ?? ''),
      expiresAt: DateTime.tryParse(json['expiresAt']?.toString() ?? ''),
      message: json['message']?.toString(),
      maxUsers: (json['maxUsers'] as num?)?.toInt(),
      maxDevices: (json['maxDevices'] as num?)?.toInt(),
      maxBranches: (json['maxBranches'] as num?)?.toInt(),
      maxRegisters: (json['maxRegisters'] as num?)?.toInt(),
      modules: (json['modules'] as List? ?? const [])
          .map((value) => value.toString())
          .toList(),
      fromCache: fromCache,
    );
  }
}

final businessLicenseProvider =
    FutureProvider.autoDispose<BusinessLicense>((ref) async {
  final auth = ref.watch(authControllerProvider);
  final businessId = auth.empresaId;
  if (auth.status != AuthStatus.autenticado || businessId == null) {
    return const BusinessLicense(status: LicenseStatus.unknown);
  }
  final database = ref.watch(databaseProvider);
  try {
    final json =
        await ref.read(cloudFunctionsServiceProvider).getMyBusinessLicense();
    await database.insert(
      'licencia_cache',
      {
        'id': 1,
        'empresa_id': businessId,
        'estado': json['status']?.toString() ?? 'unknown',
        'plan_code': json['planCode']?.toString(),
        'plan_name': json['planName']?.toString(),
        'fecha_expiracion':
            json['expiresAt']?.toString() ?? json['trialEndsAt']?.toString(),
        'limite_usuarios': json['maxUsers'],
        'limite_dispositivos': json['maxDevices'],
        'limite_sucursales': json['maxBranches'],
        'limite_cajas': json['maxRegisters'],
        'ultima_validacion_en': DateTime.now().toIso8601String(),
        'blob_cifrado': jsonEncode(json),
        'actualizado_en': DateTime.now().toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
    return BusinessLicense.fromJson(json);
  } catch (_) {
    final rows = await database.query(
      'licencia_cache',
      where: 'id = 1 AND empresa_id = ?',
      whereArgs: [businessId],
      limit: 1,
    );
    if (rows.isEmpty) {
      return const BusinessLicense(
        status: LicenseStatus.unknown,
        message: 'No fue posible validar la licencia.',
        fromCache: true,
      );
    }
    final raw = rows.first['blob_cifrado']?.toString();
    if (raw != null && raw.isNotEmpty) {
      return BusinessLicense.fromJson(
        Map<String, dynamic>.from(jsonDecode(raw) as Map),
        fromCache: true,
      );
    }
    return BusinessLicense(
      status: LicenseStatus.values.firstWhere(
        (value) => value.name == rows.first['estado']?.toString(),
        orElse: () => LicenseStatus.unknown,
      ),
      planCode: rows.first['plan_code']?.toString(),
      planName: rows.first['plan_name']?.toString(),
      expiresAt:
          DateTime.tryParse(rows.first['fecha_expiracion']?.toString() ?? ''),
      fromCache: true,
    );
  }
});
