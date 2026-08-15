import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/database_providers.dart';
import '../../data/auth/auth_controller.dart';
import '../../domain/entities/producto_lote.dart';

class ExpirationAlertsScreen extends ConsumerStatefulWidget {
  const ExpirationAlertsScreen({super.key});

  @override
  ConsumerState<ExpirationAlertsScreen> createState() =>
      _ExpirationAlertsScreenState();
}

class _ExpirationAlertsScreenState
    extends ConsumerState<ExpirationAlertsScreen> {
  late Future<List<_ExpirationRow>> _future = _load();

  Future<List<_ExpirationRow>> _load() async {
    final businessId = ref.read(authControllerProvider).empresaId;
    if (businessId == null) return const [];
    final limit = DateTime.now().add(const Duration(days: 90));
    final limitDate = limit.toIso8601String().substring(0, 10);
    final rows = await ref.read(databaseProvider).rawQuery(
      '''
      SELECT l.*, p.nombre AS producto_nombre
      FROM producto_lotes l
      INNER JOIN productos p ON p.id = l.producto_id
      WHERE l.empresa_id = ? AND l.eliminado = 0 AND p.eliminado = 0
        AND l.cantidad > 0 AND l.fecha_vencimiento IS NOT NULL
        AND l.fecha_vencimiento <= ?
      ORDER BY l.fecha_vencimiento ASC, p.nombre ASC
      ''',
      [businessId, limitDate],
    );
    return rows.map(_ExpirationRow.fromMap).toList();
  }

  Future<void> _refresh() async {
    setState(() => _future = _load());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Alertas de vencimiento')),
      body: FutureBuilder<List<_ExpirationRow>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Text('No se pudieron cargar los lotes: ${snapshot.error}'),
            );
          }
          final rows = snapshot.data ?? const [];
          if (rows.isEmpty) {
            return RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                children: const [
                  SizedBox(height: 180),
                  Center(child: Text('No hay lotes que venzan en 90 días.')),
                ],
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final row = rows[index];
                final expired = row.lot.expired;
                return ListTile(
                  leading: Icon(
                    expired ? Icons.block : Icons.event_busy_outlined,
                    color: expired
                        ? Theme.of(context).colorScheme.error
                        : _statusColor(row.lot.daysUntilExpiration),
                  ),
                  title: Text(row.productName),
                  subtitle: Text(
                    '${row.lot.expirationStatus} · Lote ${row.lot.numeroLote ?? "sin número"}\n'
                    'Vence ${row.lot.fechaVencimiento!.toIso8601String().substring(0, 10)}',
                  ),
                  isThreeLine: true,
                  trailing: Text(row.lot.cantidad.toStringAsFixed(2)),
                );
              },
            ),
          );
        },
      ),
    );
  }

  Color _statusColor(int? days) {
    if (days == null) return Colors.grey;
    if (days <= 7) return Colors.red;
    if (days <= 30) return Colors.deepOrange;
    if (days <= 60) return Colors.amber.shade800;
    return Colors.blue;
  }
}

class _ExpirationRow {
  const _ExpirationRow({required this.productName, required this.lot});

  final String productName;
  final ProductoLote lot;

  factory _ExpirationRow.fromMap(Map<String, Object?> map) => _ExpirationRow(
        productName: map['producto_nombre']?.toString() ?? 'Producto',
        lot: ProductoLote.fromMap(map),
      );
}
