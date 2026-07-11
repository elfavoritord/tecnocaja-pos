import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/declaracion_model.dart';

class DeclaracionService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  CollectionReference _col(String contadorDocId) =>
      _db.collection('contadores').doc(contadorDocId).collection('declaraciones');

  // ── Stream de declaraciones ────────────────────────────────────────────────
  Stream<List<DeclaracionModel>> watchDeclaraciones(
    String contadorDocId, {
    String? clienteId,
    String? estado,
    String? tipo,
  }) {
    Query query = _col(contadorDocId).orderBy('fechaLimite', descending: false);
    if (clienteId != null) query = query.where('clienteId', isEqualTo: clienteId);
    if (estado != null) query = query.where('estado', isEqualTo: estado);
    if (tipo != null) query = query.where('tipo', isEqualTo: tipo);

    return query.snapshots().map(
        (snap) => snap.docs.map(DeclaracionModel.fromFirestore).toList());
  }

  Future<List<DeclaracionModel>> getDeclaraciones(
    String contadorDocId, {
    String? clienteId,
    String? estado,
  }) async {
    Query query = _col(contadorDocId).orderBy('fechaLimite', descending: false);
    if (clienteId != null) query = query.where('clienteId', isEqualTo: clienteId);
    if (estado != null) query = query.where('estado', isEqualTo: estado);

    final snap = await query.get();
    return snap.docs.map(DeclaracionModel.fromFirestore).toList();
  }

  // ── Stats para dashboard ───────────────────────────────────────────────────
  Future<Map<String, int>> getStats(String contadorDocId) async {
    final snap = await _col(contadorDocId).get();
    final declaraciones = snap.docs.map(DeclaracionModel.fromFirestore).toList();

    final now = DateTime.now();
    int pendientes = 0, enviadas = 0, aprobadas = 0, vencidas = 0, enProceso = 0;

    for (final d in declaraciones) {
      if (d.isAprobada) {
        aprobadas++;
      } else if (d.estado == 'enviada') {
        enviadas++;
      } else if (d.estado == 'en_proceso') {
        enProceso++;
      } else if (d.fechaLimite != null && d.fechaLimite!.isBefore(now)) {
        vencidas++;
      } else {
        pendientes++;
      }
    }

    return {
      'pendientes': pendientes,
      'enProceso': enProceso,
      'enviadas': enviadas,
      'aprobadas': aprobadas,
      'vencidas': vencidas,
      'total': declaraciones.length,
    };
  }

  // ── Próximos vencimientos (30 días) ────────────────────────────────────────
  // Filtra por fecha en Firestore y por estado en Dart para evitar índice compuesto.
  Future<List<DeclaracionModel>> getProximosVencimientos(String contadorDocId) async {
    final now = DateTime.now();
    final limite = now.add(const Duration(days: 30));

    final snap = await _col(contadorDocId)
        .where('fechaLimite', isGreaterThanOrEqualTo: Timestamp.fromDate(now))
        .where('fechaLimite', isLessThanOrEqualTo: Timestamp.fromDate(limite))
        .orderBy('fechaLimite')
        .limit(50)
        .get();

    return snap.docs
        .map(DeclaracionModel.fromFirestore)
        .where((d) => d.estado == 'pendiente' || d.estado == 'en_proceso')
        .take(20)
        .toList();
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────
  Future<DeclaracionModel> create(String contadorDocId, DeclaracionModel declaracion) async {
    final data = declaracion.toFirestore();
    data['createdAt'] = FieldValue.serverTimestamp();
    data['contadorId'] = contadorDocId;

    final ref = await _col(contadorDocId).add(data);
    final doc = await ref.get();
    return DeclaracionModel.fromFirestore(doc);
  }

  Future<void> update(String contadorDocId, String id, Map<String, dynamic> updates) async {
    updates['updatedAt'] = FieldValue.serverTimestamp();
    await _col(contadorDocId).doc(id).update(updates);
  }

  Future<void> marcarEnviada(
    String contadorDocId,
    String id, {
    String? numeroConfirmacion,
    String? observaciones,
  }) async {
    await update(contadorDocId, id, {
      'estado': 'enviada',
      'fechaEnvio': FieldValue.serverTimestamp(),
      if (numeroConfirmacion != null) 'numeroConfirmacion': numeroConfirmacion,
      if (observaciones != null) 'observaciones': observaciones,
    });
  }

  Future<void> delete(String contadorDocId, String id) async {
    await _col(contadorDocId).doc(id).delete();
  }
}
