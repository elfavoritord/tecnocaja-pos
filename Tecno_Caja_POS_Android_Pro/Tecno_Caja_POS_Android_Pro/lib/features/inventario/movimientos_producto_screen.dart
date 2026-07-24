import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/repositories/inventario_repository.dart';
import '../../domain/entities/inventario.dart';

class MovimientosProductoScreen extends ConsumerStatefulWidget {
  const MovimientosProductoScreen({super.key, required this.productoId, required this.nombreProducto});

  final String productoId;
  final String nombreProducto;

  @override
  ConsumerState<MovimientosProductoScreen> createState() => _MovimientosProductoScreenState();
}

class _MovimientosProductoScreenState extends ConsumerState<MovimientosProductoScreen> {
  List<MovimientoInventario> _movimientos = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final movimientos = await ref.read(inventarioRepositoryProvider).historialDe(widget.productoId);
    if (mounted) setState(() { _movimientos = movimientos; _cargando = false; });
  }

  IconData _iconoDe(String tipo) {
    switch (tipo) {
      case TipoMovimientoInventario.venta:
        return Icons.point_of_sale_outlined;
      case TipoMovimientoInventario.compra:
        return Icons.local_shipping_outlined;
      case TipoMovimientoInventario.devolucion:
        return Icons.undo;
      case TipoMovimientoInventario.transferenciaSalida:
      case TipoMovimientoInventario.transferenciaEntrada:
        return Icons.swap_horiz;
      case TipoMovimientoInventario.perdida:
      case TipoMovimientoInventario.vencimiento:
        return Icons.report_gmailerrorred_outlined;
      default:
        return Icons.tune;
    }
  }

  String _etiquetaDe(String tipo) {
    switch (tipo) {
      case TipoMovimientoInventario.venta:
        return 'Venta';
      case TipoMovimientoInventario.compra:
        return 'Compra';
      case TipoMovimientoInventario.devolucion:
        return 'Devolución';
      case TipoMovimientoInventario.ajuste:
        return 'Ajuste';
      case TipoMovimientoInventario.transferenciaSalida:
        return 'Transferencia (salida)';
      case TipoMovimientoInventario.transferenciaEntrada:
        return 'Transferencia (entrada)';
      case TipoMovimientoInventario.perdida:
        return 'Pérdida';
      case TipoMovimientoInventario.vencimiento:
        return 'Vencimiento';
      case TipoMovimientoInventario.entradaManual:
        return 'Entrada manual';
      case TipoMovimientoInventario.salidaManual:
        return 'Salida manual';
      default:
        return tipo;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.nombreProducto)),
      body: _cargando
          ? const Center(child: CircularProgressIndicator())
          : _movimientos.isEmpty
              ? const Center(child: Text('Sin movimientos registrados todavía'))
              : ListView.builder(
                  itemCount: _movimientos.length,
                  itemBuilder: (context, index) {
                    final m = _movimientos[index];
                    final positivo = m.cantidad >= 0;
                    return ListTile(
                      leading: CircleAvatar(
                        backgroundColor: (positivo ? AppColors.success : AppColors.danger).withValues(alpha: 0.12),
                        child: Icon(_iconoDe(m.tipoMovimiento), color: positivo ? AppColors.success : AppColors.danger, size: 20),
                      ),
                      title: Text(_etiquetaDe(m.tipoMovimiento)),
                      subtitle: Text(
                        '${Formatters.dateTime(m.creadoEn)}${m.nota != null && m.nota!.isNotEmpty ? ' · ${m.nota}' : ''}',
                      ),
                      trailing: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '${positivo ? '+' : ''}${m.cantidad.toStringAsFixed(2)}',
                            style: TextStyle(fontWeight: FontWeight.bold, color: positivo ? AppColors.success : AppColors.danger),
                          ),
                          Text('→ ${m.stockNuevo.toStringAsFixed(2)}', style: Theme.of(context).textTheme.bodySmall),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
