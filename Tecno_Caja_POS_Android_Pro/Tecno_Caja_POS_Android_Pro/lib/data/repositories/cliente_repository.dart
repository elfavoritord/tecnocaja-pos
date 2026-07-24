import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sqflite/sqflite.dart';

import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/cliente.dart';
import '../local/daos/cliente_dao.dart';

class ClienteRepository {
  ClienteRepository(this._dao, this._db);

  final ClienteDao _dao;
  final Database _db;

  Future<List<Cliente>> deEmpresa(String empresaId) => _dao.deEmpresa(empresaId);

  Future<List<Cliente>> buscar(String empresaId, String termino) => _dao.buscar(empresaId, termino);

  Future<List<Cliente>> conBalancePendiente(String empresaId) => _dao.conBalancePendiente(empresaId);

  Future<Cliente?> porId(String id) => _dao.findById(id);

  Future<Cliente> crear({
    required String empresaId,
    required String nombre,
    String? telefono,
    String? whatsapp,
    String? email,
    String? direccion,
    String? cedulaRnc,
    double limiteCredito = 0,
    String? notas,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final cliente = Cliente(
      id: IdGenerator.newId(),
      nombre: nombre,
      telefono: telefono,
      whatsapp: whatsapp,
      email: email,
      direccion: direccion,
      cedulaRnc: cedulaRnc,
      limiteCredito: limiteCredito,
      notas: notas,
      empresaId: empresaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _dao.insert(cliente);
    return cliente;
  }

  Future<void> actualizar(Cliente cliente) => _dao.update(cliente);

  Future<void> desactivar(String id) => _dao.softDelete(id, nowIso: DateTime.now().toIso8601String());

  /// Abono a cuenta por cobrar: registra el pago y baja el balance en la
  /// misma transaccion. El historial de pagos (tabla cliente_pagos) se
  /// completa en la pantalla de Clientes -- aqui solo el movimiento minimo
  /// para que el balance nunca quede inconsistente con lo cobrado.
  Future<void> registrarAbono({
    required String clienteId,
    required String idPago,
    required double monto,
    required String metodoPago,
    String? nota,
    String? dispositivoId,
  }) async {
    final now = DateTime.now().toIso8601String();
    await _db.transaction((txn) async {
      await txn.rawUpdate(
        'UPDATE clientes SET balance = balance - ?, actualizado_en = ?, sync_estado = ? WHERE id = ?',
        [monto, now, 'pendiente', clienteId],
      );
      final clienteRows = await txn.query('clientes', columns: ['empresa_id'], where: 'id = ?', whereArgs: [clienteId], limit: 1);
      final empresaId = clienteRows.isEmpty ? null : clienteRows.first['empresa_id'] as String?;
      await txn.insert('cliente_pagos', {
        'id': idPago,
        'cliente_id': clienteId,
        'monto': monto,
        'metodo_pago': metodoPago,
        'fecha_pago': now,
        'nota': nota,
        'empresa_id': empresaId,
        'dispositivo_id': dispositivoId,
        'creado_en': now,
        'actualizado_en': now,
        'version': 1,
        'sync_estado': 'pendiente',
        'eliminado': 0,
      });
    });
  }

  Future<List<Map<String, Object?>>> historialPagos(String clienteId, {int limit = 50}) {
    return _db.query(
      'cliente_pagos',
      where: 'cliente_id = ? AND eliminado = 0',
      whereArgs: [clienteId],
      orderBy: 'fecha_pago DESC',
      limit: limit,
    );
  }
}

final clienteRepositoryProvider = Provider<ClienteRepository>((ref) {
  return ClienteRepository(ref.watch(clienteDaoProvider), ref.watch(databaseProvider));
});
