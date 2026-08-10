import 'package:cloud_firestore/cloud_firestore.dart' hide Transaction;
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
  });

  final bool usaComprobantesFiscales;
  final String modoComprobante;
  final String ambiente;
  final bool eCfActivo;
  final bool eCfValidado;

  factory FiscalSettings.fromMap(Map<String, dynamic> map) => FiscalSettings(
        usaComprobantesFiscales:
            map['usaComprobantesFiscales'] as bool? ?? false,
        modoComprobante:
            map['modoComprobante'] as String? ?? 'sin_comprobantes',
        ambiente: map['ambiente'] as String? ?? 'certificacion',
        eCfActivo: map['eCfActivo'] as bool? ?? false,
        eCfValidado: map['eCfValidado'] as bool? ?? false,
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

/// Puente a la facturación fiscal (NCF tradicional en esta fase; e-CF con
/// firma/envío a DGII queda para una fase posterior -- ver
/// `functions/fiscal.js`). `settings/fiscal` se lee/escribe directo por
/// Firestore (mismo patrón que `CloudBusinessSyncRepository`); las
/// secuencias y la reserva de NCF pasan siempre por Cloud Functions porque
/// las reglas no permiten tocarlas directo desde el cliente.
class FiscalRepository {
  FiscalRepository(this._firestore, this._cloud);

  final FirebaseFirestore _firestore;
  final CloudFunctionsService _cloud;

  DocumentReference<Map<String, dynamic>> _fiscalDoc(String businessId) =>
      _firestore
          .collection('businesses')
          .doc(businessId)
          .collection('settings')
          .doc('fiscal');

  Future<FiscalSettings?> obtener(String businessRemoteId) async {
    final snap = await _fiscalDoc(businessRemoteId).get();
    if (!snap.exists) return null;
    return FiscalSettings.fromMap(snap.data()!);
  }

  Future<void> actualizarUsaComprobantes(
    String businessRemoteId, {
    required bool activo,
    required String modo,
  }) {
    return _fiscalDoc(businessRemoteId).set({
      'usaComprobantesFiscales': activo,
      'modoComprobante': modo,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<List<NcfSequenceInfo>> listarSecuencias(
      String businessRemoteId) async {
    final result = await _cloud.listNcfSequences(businessRemoteId);
    final raw = result['sequences'] as List? ?? const [];
    return raw
        .map((e) => NcfSequenceInfo.fromMap(Map<String, dynamic>.from(e as Map)))
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
}

final fiscalRepositoryProvider = Provider<FiscalRepository>((ref) {
  return FiscalRepository(
    FirebaseFirestore.instance,
    ref.watch(cloudFunctionsServiceProvider),
  );
});
