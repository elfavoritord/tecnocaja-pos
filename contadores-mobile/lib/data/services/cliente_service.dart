import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/user_model.dart';

class ClienteService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  static const _col = 'licencias';

  // ── Listar clientes del contador ───────────────────────────────────────────
  Stream<List<ClienteModel>> watchClientes(String contadorDocId) {
    return _db
        .collection(_col)
        .where('contadorId', isEqualTo: contadorDocId)
        .snapshots()
        .map((snap) => snap.docs
            .map(ClienteModel.fromFirestore)
            .toList()
          ..sort((a, b) => a.businessName.compareTo(b.businessName)));
  }

  Future<List<ClienteModel>> getClientes(String contadorDocId) async {
    final snap = await _db
        .collection(_col)
        .where('contadorId', isEqualTo: contadorDocId)
        .get();

    return snap.docs
        .map(ClienteModel.fromFirestore)
        .toList()
      ..sort((a, b) => a.businessName.compareTo(b.businessName));
  }

  // ── Obtener un cliente ─────────────────────────────────────────────────────
  Future<ClienteModel?> getCliente(String clienteId) async {
    final doc = await _db.collection(_col).doc(clienteId).get();
    if (!doc.exists) return null;
    return ClienteModel.fromFirestore(doc);
  }

  Stream<ClienteModel?> watchCliente(String clienteId) {
    return _db.collection(_col).doc(clienteId).snapshots().map(
          (doc) => doc.exists ? ClienteModel.fromFirestore(doc) : null,
        );
  }

  // ── Estadísticas del dashboard ─────────────────────────────────────────────
  Future<Map<String, dynamic>> getDashboardStats(String contadorDocId) async {
    final clientes = await getClientes(contadorDocId);
    final now = DateTime.now();

    int activos = 0, prueba = 0, vencidos = 0, suspendidos = 0;
    final proximosVencer = <ClienteModel>[];

    for (final c in clientes) {
      final s = c.status.toLowerCase();
      if (s == 'active') activos++;
      else if (s == 'trial') prueba++;
      else if (s == 'expired' || s == 'cancelled') vencidos++;
      else if (s == 'suspended') suspendidos++;

      final vence = c.vencimiento;
      if (vence != null) {
        final dias = vence.difference(now).inDays;
        if (dias >= 0 && dias <= 30) proximosVencer.add(c);
      }
    }

    proximosVencer.sort((a, b) {
      final da = a.vencimiento?.difference(now).inDays ?? 999;
      final db = b.vencimiento?.difference(now).inDays ?? 999;
      return da.compareTo(db);
    });

    return {
      'total': clientes.length,
      'activos': activos,
      'prueba': prueba,
      'vencidos': vencidos,
      'suspendidos': suspendidos,
      'proximosVencer': proximosVencer,
      'recientes': clientes.take(8).toList(),
    };
  }

  // ── Buscar clientes ────────────────────────────────────────────────────────
  List<ClienteModel> filtrarClientes(List<ClienteModel> clientes, String query) {
    if (query.isEmpty) return clientes;
    final q = query.toLowerCase();
    return clientes.where((c) {
      return c.businessName.toLowerCase().contains(q) ||
          (c.rnc ?? '').toLowerCase().contains(q) ||
          (c.propietario ?? '').toLowerCase().contains(q) ||
          (c.correo ?? '').toLowerCase().contains(q);
    }).toList();
  }

  // ── Crear cliente ──────────────────────────────────────────────────────────
  Future<ClienteModel> createCliente(ClienteModel cliente) async {
    final data = cliente.toFirestore();
    data['createdAt'] = FieldValue.serverTimestamp();
    data['status'] = 'trial';
    data['trialEndsAt'] = Timestamp.fromDate(DateTime.now().add(const Duration(days: 30)));

    final ref = await _db.collection(_col).add(data);
    final doc = await ref.get();
    return ClienteModel.fromFirestore(doc);
  }

  // ── Editar cliente ─────────────────────────────────────────────────────────
  Future<void> updateCliente(String id, Map<String, dynamic> updates) async {
    updates['updatedAt'] = FieldValue.serverTimestamp();
    await _db.collection(_col).doc(id).update(updates);
  }

  // ── Eliminar cliente ───────────────────────────────────────────────────────
  Future<void> deleteCliente(String id) async {
    await _db.collection(_col).doc(id).delete();
  }
}
