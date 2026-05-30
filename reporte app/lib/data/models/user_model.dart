import 'package:cloud_firestore/cloud_firestore.dart';

enum UserRole { admin, branchAdmin, supervisor }

extension UserRoleExt on UserRole {
  String get label {
    switch (this) {
      case UserRole.admin:
        return 'Administrador General';
      case UserRole.branchAdmin:
        return 'Administrador de Sucursal';
      case UserRole.supervisor:
        return 'Supervisor';
    }
  }

  bool get canSeeAllBranches => this == UserRole.admin;
}

class UserModel {
  final String id;
  final String displayName;
  final String email;
  final String? photoUrl;
  final UserRole role;
  final String? posRole;
  final String? posRoleCode;
  final int? posUserId;
  final bool isActive;
  final String businessId;
  final List<String> businessIds;
  final List<String> branchIds;
  final List<String> cashRegisterIds;
  final List<String> allowedModules;
  final DateTime createdAt;

  const UserModel({
    required this.id,
    required this.displayName,
    required this.email,
    this.photoUrl,
    required this.role,
    this.posRole,
    this.posRoleCode,
    this.posUserId,
    required this.isActive,
    required this.businessId,
    required this.businessIds,
    required this.branchIds,
    required this.cashRegisterIds,
    required this.allowedModules,
    required this.createdAt,
  });

  List<String> get effectiveBusinessIds =>
      businessIds.isNotEmpty ? businessIds : [businessId];

  List<String> get effectiveCashRegisterIds =>
      cashRegisterIds.where((id) => id.trim().isNotEmpty).toList();

  bool get hasMultipleBusinesses => effectiveBusinessIds.length > 1;

  String? get primaryCashRegisterId =>
      effectiveCashRegisterIds.isEmpty ? null : effectiveCashRegisterIds.first;

  bool get isCashierLike {
    final normalizedRole = (posRoleCode ?? posRole ?? '').trim().toLowerCase();
    return normalizedRole == 'cajero' || normalizedRole == 'cashier';
  }

  String get roleDisplayLabel {
    final label = (posRole ?? '').trim();
    return label.isNotEmpty ? label : role.label;
  }

  bool canAccessModule(String moduleKey) {
    if (!isActive) return false;
    if (role == UserRole.admin || role == UserRole.branchAdmin) return true;
    if (moduleKey == 'dashboard' ||
        moduleKey == 'profile' ||
        moduleKey == 'settings') {
      return true;
    }
    return allowedModules.contains(moduleKey);
  }

  factory UserModel.fromFirestore(DocumentSnapshot doc) {
    final data = (doc.data() as Map<String, dynamic>?) ?? <String, dynamic>{};
    final businesses = _stringList(
      data['businessIds'] ?? data['negocioIds'] ?? data['business_ids'],
      fallback: [data['businessId'] ?? data['negocioId'] ?? data['companyId']],
    );
    final branchIds = _stringList(
      data['branchIds'] ?? data['sucursalIds'] ?? data['branch_ids'],
      fallback: [data['branchId'] ?? data['sucursalId']],
    );
    final cashRegisterIds = _stringList(
      data['cashRegisterIds'] ??
          data['cajaIds'] ??
          data['cash_register_ids'] ??
          data['registerIds'],
      fallback: [
        data['cashRegisterId'],
        data['cajaId'],
        data['cash_register_id'],
        data['registerId'],
      ],
    );
    final businessId =
        _firstNonEmptyString([
          data['businessId'],
          data['negocioId'],
          data['companyId'],
        ]) ??
        (businesses.isNotEmpty ? businesses.first : '');
    final displayName =
        _firstNonEmptyString([
          data['displayName'],
          data['nombre'],
          data['name'],
          data['fullName'],
          data['username'],
        ]) ??
        '';
    final email =
        _firstNonEmptyString([
          data['email'],
          data['emailLower'],
          data['correo'],
          data['correoLower'],
          data['mail'],
        ])?.toLowerCase() ??
        '';
    final allowedModules = _stringList(
      data['allowedModules'] ??
          data['modulosPermitidos'] ??
          data['modules'] ??
          data['allowed_modules'],
    );

    return UserModel(
      id: doc.id,
      displayName: displayName,
      email: email,
      photoUrl: _firstNonEmptyString([
        data['photoUrl'],
        data['fotoUrl'],
        data['avatar'],
      ]),
      role: _roleFromString(
        _firstNonEmptyString([data['role'], data['rol']]) ?? 'supervisor',
      ),
      posRole: _firstNonEmptyString([
        data['posRole'],
        data['rol'],
        data['roleName'],
      ]),
      posRoleCode: _firstNonEmptyString([
        data['posRoleCode'],
        data['rolCodigo'],
        data['roleCode'],
      ]),
      posUserId: _toNullableInt(
        data['posUserId'] ??
            data['usuarioId'] ??
            data['userId'] ??
            data['idUsuario'],
      ),
      isActive: _toBool(
        data['isActive'],
        fallbackValues: [
          data['active'],
          data['activo'],
          data['estado'],
          data['status'],
        ],
      ),
      businessId: businessId,
      businessIds: businesses,
      branchIds: branchIds,
      cashRegisterIds: cashRegisterIds,
      allowedModules: allowedModules,
      createdAt: _toDateTime(
        data['createdAt'] ?? data['fechaCreacion'] ?? data['created_at'],
      ),
    );
  }

  static UserRole _roleFromString(String role) {
    switch (role.trim().toLowerCase()) {
      case 'admin':
      case 'administrador':
        return UserRole.admin;
      case 'branch_admin':
      case 'branchadmin':
      case 'admin_sucursal':
      case 'administrador_sucursal':
        return UserRole.branchAdmin;
      default:
        return UserRole.supervisor;
    }
  }

  static int? _toNullableInt(dynamic value) {
    if (value == null) return null;
    if (value is int) return value;
    return int.tryParse(value.toString());
  }

  static bool _toBool(
    dynamic value, {
    List<dynamic> fallbackValues = const [],
  }) {
    final candidates = [value, ...fallbackValues];
    for (final candidate in candidates) {
      if (candidate == null) continue;
      if (candidate is bool) return candidate;
      if (candidate is num) return candidate != 0;
      final normalized = candidate.toString().trim().toLowerCase();
      if (normalized.isEmpty) continue;
      if (normalized == 'true' ||
          normalized == '1' ||
          normalized == 'activo' ||
          normalized == 'active') {
        return true;
      }
      if (normalized == 'false' ||
          normalized == '0' ||
          normalized == 'inactivo' ||
          normalized == 'inactive') {
        return false;
      }
    }
    return true;
  }

  static DateTime _toDateTime(dynamic value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    if (value is String) {
      return DateTime.tryParse(value) ?? DateTime.now();
    }
    return DateTime.now();
  }

  static String? _firstNonEmptyString(List<dynamic> values) {
    for (final value in values) {
      final normalized = value?.toString().trim() ?? '';
      if (normalized.isNotEmpty) return normalized;
    }
    return null;
  }

  static List<String> _stringList(
    dynamic value, {
    List<dynamic> fallback = const [],
  }) {
    final raw = value ?? fallback;
    final values = raw is List ? raw : [raw];
    final result = <String>[];
    for (final entry in values) {
      final normalized = entry?.toString().trim() ?? '';
      if (normalized.isNotEmpty && !result.contains(normalized)) {
        result.add(normalized);
      }
    }
    return result;
  }
}
