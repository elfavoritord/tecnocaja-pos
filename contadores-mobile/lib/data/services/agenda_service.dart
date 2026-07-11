import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/agenda_model.dart';

class AgendaService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  CollectionReference _colAgenda(String contadorDocId) =>
      _db.collection('contadores').doc(contadorDocId).collection('agenda_eventos');

  CollectionReference _colDocs(String contadorDocId) =>
      _db.collection('contadores').doc(contadorDocId).collection('documentos');

  // ── Agenda ─────────────────────────────────────────────────────────────────
  Stream<List<AgendaEventModel>> watchEventos(String contadorDocId, {DateTime? desde, DateTime? hasta}) {
    Query q = _colAgenda(contadorDocId).orderBy('fechaInicio');
    if (desde != null) q = q.where('fechaInicio', isGreaterThanOrEqualTo: Timestamp.fromDate(desde));
    if (hasta != null) q = q.where('fechaInicio', isLessThanOrEqualTo: Timestamp.fromDate(hasta));
    return q.snapshots().map((s) => s.docs.map(AgendaEventModel.fromFirestore).toList());
  }

  Future<List<AgendaEventModel>> getEventosDelMes(String contadorDocId, int mes, int year) async {
    final desde = DateTime(year, mes, 1);
    final hasta = DateTime(year, mes + 1, 0, 23, 59, 59);

    final snap = await _colAgenda(contadorDocId)
        .where('fechaInicio', isGreaterThanOrEqualTo: Timestamp.fromDate(desde))
        .where('fechaInicio', isLessThanOrEqualTo: Timestamp.fromDate(hasta))
        .orderBy('fechaInicio')
        .get();

    return snap.docs.map(AgendaEventModel.fromFirestore).toList();
  }

  Future<AgendaEventModel> createEvento(String contadorDocId, AgendaEventModel evento) async {
    final data = evento.toFirestore();
    data['createdAt'] = FieldValue.serverTimestamp();
    final ref = await _colAgenda(contadorDocId).add(data);
    final doc = await ref.get();
    return AgendaEventModel.fromFirestore(doc);
  }

  Future<void> updateEvento(String contadorDocId, String id, Map<String, dynamic> updates) async {
    updates['updatedAt'] = FieldValue.serverTimestamp();
    await _colAgenda(contadorDocId).doc(id).update(updates);
  }

  Future<void> deleteEvento(String contadorDocId, String id) async {
    await _colAgenda(contadorDocId).doc(id).delete();
  }

  // ── Documentos ─────────────────────────────────────────────────────────────
  Stream<List<DocumentoModel>> watchDocumentos(String contadorDocId, {String? clienteId}) {
    Query q = _colDocs(contadorDocId).orderBy('createdAt', descending: true);
    if (clienteId != null) q = q.where('clienteId', isEqualTo: clienteId);
    return q.snapshots().map((s) => s.docs.map(DocumentoModel.fromFirestore).toList());
  }

  Future<List<DocumentoModel>> getDocumentos(String contadorDocId, {String? clienteId, String? categoria}) async {
    Query q = _colDocs(contadorDocId).orderBy('createdAt', descending: true);
    if (clienteId != null) q = q.where('clienteId', isEqualTo: clienteId);
    if (categoria != null) q = q.where('categoria', isEqualTo: categoria);
    final snap = await q.get();
    return snap.docs.map(DocumentoModel.fromFirestore).toList();
  }

  Future<DocumentoModel> saveDocumento(String contadorDocId, DocumentoModel doc) async {
    final data = doc.toFirestore();
    final ref = await _colDocs(contadorDocId).add(data);
    final saved = await ref.get();
    return DocumentoModel.fromFirestore(saved);
  }

  Future<void> deleteDocumento(String contadorDocId, String id) async {
    await _colDocs(contadorDocId).doc(id).delete();
  }
}
