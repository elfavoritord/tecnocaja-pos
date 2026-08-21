import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../cloud/cloud_functions_service.dart';

/// Configuración fiscal de la empresa (`businesses/{id}/settings/fiscal`).
/// Lectura permitida a cualquier empleado y escritura solo a admin/owner por
/// las reglas de Firestore -- ver `firestore.rules`.
class FiscalSettings {
  const FiscalSettings({
    required this.usaComprobantesFiscales,
    required this.modoComprobante,
    required this.ambiente,
    required this.eCfActivo,
    required this.eCfValidado,
    this.actividadEconomica = '',
  });

  final bool usaComprobantesFiscales;
  final String modoComprobante;
  final String ambiente;
  final bool eCfActivo;
  final bool eCfValidado;
  final String actividadEconomica;

  factory FiscalSettings.fromMap(Map<String, dynamic> map) => FiscalSettings(
        usaComprobantesFiscales:
            map['usaComprobantesFiscales'] as bool? ?? false,
        modoComprobante:
            map['modoComprobante'] as String? ?? 'sin_comprobantes',
        ambiente: map['ambiente'] as String? ?? 'certificacion',
        eCfActivo: map['eCfActivo'] as bool? ?? false,
        eCfValidado: map['eCfValidado'] as bool? ?? false,
        actividadEconomica: map['actividadEconomica'] as String? ?? '',
      );
}

/// Estado de una secuencia NCF autorizada por la DGII
/// (`businesses/{id}/ncfSequences/{ncfType}_{ambiente}`). Solo visible via
/// `listNcfSequences` -- las reglas bloquean la lectura directa de la
/// colección a cualquier cliente.
class NcfSequenceInfo {
  const NcfSequenceInfo({
    required this.ncfType,
    required this.ambiente,
    required this.siguienteNumero,
    required this.maximo,
    required this.activa,
  });

  final String ncfType;
  final String ambiente;
  final int siguienteNumero;
  final int maximo;
  final bool activa;

  int get restantes => (maximo - siguienteNumero + 1).clamp(0, maximo);
  bool get agotada => siguienteNumero > maximo;

  factory NcfSequenceInfo.fromMap(Map<String, dynamic> map) => NcfSequenceInfo(
        ncfType: map['ncfType'] as String? ?? '',
        ambiente: map['ambiente'] as String? ?? 'certificacion',
        siguienteNumero: (map['siguienteNumero'] as num?)?.toInt() ?? 0,
        maximo: (map['maximo'] as num?)?.toInt() ?? 0,
        activa: map['activa'] as bool? ?? false,
      );
}

class EcfCertificationStep {
  const EcfCertificationStep({
    required this.id,
    required this.key,
    required this.label,
    required this.verification,
    required this.status,
    this.completedAt,
    this.evidence = const {},
  });

  final int id;
  final String key;
  final String label;
  final String verification;
  final String status;
  final DateTime? completedAt;
  final Map<String, dynamic> evidence;

  bool get completed => status == 'completed';

  factory EcfCertificationStep.fromMap(Map<String, dynamic> map) {
    final evidence = map['evidence'];
    return EcfCertificationStep(
      id: (map['id'] as num?)?.toInt() ?? 0,
      key: map['key']?.toString() ?? '',
      label: map['label']?.toString() ?? '',
      verification: map['verification']?.toString() ?? 'engine',
      status: map['status']?.toString() ?? 'pending',
      completedAt: DateTime.tryParse(map['completedAt']?.toString() ?? ''),
      evidence: evidence is Map
          ? Map<String, dynamic>.from(evidence)
          : const <String, dynamic>{},
    );
  }
}

class EcfCertificationProcess {
  const EcfCertificationProcess({
    required this.status,
    required this.environment,
    required this.rnc,
    required this.razonSocial,
    required this.progress,
    required this.currentStep,
    required this.steps,
    required this.portalUrl,
    required this.recommendedServiceBaseUrl,
    required this.certificateStatus,
    this.certificateSubject,
    this.certificateValidTo,
    this.startedAt,
    this.finishedAt,
  });

  final String status;
  final String environment;
  final String rnc;
  final String razonSocial;
  final int progress;
  final int currentStep;
  final List<EcfCertificationStep> steps;
  final String portalUrl;
  final String recommendedServiceBaseUrl;
  final String certificateStatus;
  final String? certificateSubject;
  final DateTime? certificateValidTo;
  final DateTime? startedAt;
  final DateTime? finishedAt;

  bool get completed => status == 'completed';

  factory EcfCertificationProcess.fromMap(Map<String, dynamic> map) {
    final rawSteps = map['steps'];
    final steps = <EcfCertificationStep>[];
    if (rawSteps is Map) {
      for (final value in rawSteps.values) {
        if (value is Map) {
          steps.add(
              EcfCertificationStep.fromMap(Map<String, dynamic>.from(value)));
        }
      }
    }
    steps.sort((a, b) => a.id.compareTo(b.id));
    final rawCertificate = map['certificate'];
    final certificate = rawCertificate is Map
        ? Map<String, dynamic>.from(rawCertificate)
        : const <String, dynamic>{};
    return EcfCertificationProcess(
      status: map['status']?.toString() ?? 'in_progress',
      environment: map['environment']?.toString() ?? 'certecf',
      rnc: map['rnc']?.toString() ?? '',
      razonSocial: map['razonSocial']?.toString() ?? '',
      progress: (map['progress'] as num?)?.toInt() ?? 0,
      currentStep: (map['currentStep'] as num?)?.toInt() ?? 1,
      steps: steps,
      portalUrl: map['portalUrl']?.toString() ?? '',
      recommendedServiceBaseUrl:
          map['recommendedServiceBaseUrl']?.toString() ?? '',
      certificateStatus: certificate['status']?.toString() ?? 'not_configured',
      certificateSubject: certificate['subject']?.toString(),
      certificateValidTo:
          DateTime.tryParse(certificate['validTo']?.toString() ?? ''),
      startedAt: DateTime.tryParse(map['startedAt']?.toString() ?? ''),
      finishedAt: DateTime.tryParse(map['finishedAt']?.toString() ?? ''),
    );
  }
}

/// Puente a la facturación fiscal (NCF tradicional en esta fase; e-CF con
/// firma/envío a DGII queda para una fase posterior -- ver
/// `functions/fiscal.js`). `settings/fiscal` se lee/escribe directo por
/// Firestore (mismo patrón que `CloudBusinessSyncRepository`); las
/// secuencias y la reserva de NCF pasan siempre por Cloud Functions porque
/// las reglas no permiten tocarlas directo desde el cliente.
class FiscalRepository {
  FiscalRepository(this._cloud);

  final CloudFunctionsService _cloud;

  Future<FiscalSettings?> obtener(String businessRemoteId) async {
    final result = await _cloud.getFiscalSettings(businessRemoteId);
    final raw = result['settings'];
    if (raw is! Map) return null;
    return FiscalSettings.fromMap(Map<String, dynamic>.from(raw));
  }

  Future<void> actualizarUsaComprobantes(
    String businessRemoteId, {
    required bool activo,
    required String modo,
  }) {
    return _cloud.updateFiscalSettings(
      businessId: businessRemoteId,
      enabled: activo,
      mode: modo,
    );
  }

  Future<List<NcfSequenceInfo>> listarSecuencias(
      String businessRemoteId) async {
    final result = await _cloud.listNcfSequences(businessRemoteId);
    final raw = result['sequences'] as List? ?? const [];
    return raw
        .map(
            (e) => NcfSequenceInfo.fromMap(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<void> configurarSecuencia({
    required String businessId,
    required String ncfType,
    required int desde,
    required int maximo,
    String ambiente = 'certificacion',
  }) {
    return _cloud.configureNcfSequence(
      businessId: businessId,
      ncfType: ncfType,
      desde: desde,
      maximo: maximo,
      ambiente: ambiente,
    );
  }

  Future<Map<String, dynamic>> solicitarNcf({
    required String businessId,
    required String branchId,
    required String saleId,
    required String ncfType,
    String ambiente = 'certificacion',
  }) {
    return _cloud.requestNcf(
      businessId: businessId,
      branchId: branchId,
      saleId: saleId,
      ncfType: ncfType,
      ambiente: ambiente,
    );
  }

  Future<EcfCertificationProcess?> obtenerCertificacion(
      String businessId) async {
    final result = await _cloud.getEcfCertificationStatus(businessId);
    final raw = result['process'];
    if (raw is! Map) return null;
    return EcfCertificationProcess.fromMap(Map<String, dynamic>.from(raw));
  }

  Future<EcfCertificationProcess> iniciarCertificacion(
      String businessId) async {
    final result = await _cloud.startEcfCertification(businessId);
    return _certificationFromResult(result);
  }

  Future<EcfCertificationProcess> confirmarPasoCertificacion({
    required String businessId,
    required int stepId,
    required String reference,
  }) async {
    final result = await _cloud.confirmEcfCertificationStep(
      businessId: businessId,
      stepId: stepId,
      reference: reference,
    );
    return _certificationFromResult(result);
  }

  Future<EcfCertificationProcess> validarUrlsCertificacion({
    required String businessId,
    required int stepId,
    required String baseUrl,
  }) async {
    final result = await _cloud.validateEcfServiceUrls(
      businessId: businessId,
      stepId: stepId,
      baseUrl: baseUrl,
    );
    return _certificationFromResult(result);
  }

  /// Firma y envía a DGII el e-CF que `solicitarNcf` dejó en
  /// PENDIENTE_FIRMA -- ver `functions/sign-and-send.js`. Devuelve
  /// `estadoFiscal`, `trackId` y `ecfQrUrl` cuando el envío se completa.
  Future<Map<String, dynamic>> firmarYEnviar({
    required String businessId,
    required String branchId,
    required String saleId,
  }) {
    return _cloud.signAndSend(
      businessId: businessId,
      branchId: branchId,
      saleId: saleId,
    );
  }

  /// Consulta el estado real en DGII de un e-CF ya enviado (botón
  /// "Consultar estado en DGII"). No re-firma ni reenvía.
  Future<Map<String, dynamic>> consultarEstadoEcf({
    required String businessId,
    required String saleId,
  }) {
    return _cloud.consultarEstadoEcf(businessId: businessId, saleId: saleId);
  }

  Future<void> actualizarActividadEconomica({
    required String businessId,
    required String actividadEconomica,
  }) {
    return _cloud.updateActividadEconomica(
      businessId: businessId,
      actividadEconomica: actividadEconomica,
    );
  }

  Future<EcfCertificationProcess> cargarCertificado({
    required String businessId,
    required String fileName,
    required String certificateBase64,
    required String password,
  }) async {
    final result = await _cloud.uploadEcfCertificate(
      businessId: businessId,
      fileName: fileName,
      certificateBase64: certificateBase64,
      password: password,
    );
    return _certificationFromResult(result);
  }

  EcfCertificationProcess _certificationFromResult(
      Map<String, dynamic> result) {
    final raw = result['process'];
    if (raw is! Map) {
      throw const FormatException(
          'El servidor no devolvió el proceso de certificación.');
    }
    return EcfCertificationProcess.fromMap(Map<String, dynamic>.from(raw));
  }
}

final fiscalRepositoryProvider = Provider<FiscalRepository>((ref) {
  return FiscalRepository(ref.watch(cloudFunctionsServiceProvider));
});
