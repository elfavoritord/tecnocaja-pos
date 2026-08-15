import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/gasto_repository.dart';
import '../../data/repositories/proveedor_repository.dart';
import '../../domain/entities/proveedor.dart';

class GastosScreen extends ConsumerStatefulWidget {
  const GastosScreen({super.key});

  @override
  ConsumerState<GastosScreen> createState() => _GastosScreenState();
}

class _GastosScreenState extends ConsumerState<GastosScreen> {
  List<GastoOperativo> _gastos = [];
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;
    setState(() => _cargando = true);
    final gastos = await ref.read(gastoRepositoryProvider).deEmpresa(empresaId);
    if (mounted) {
      setState(() {
        _gastos = gastos;
        _cargando = false;
      });
    }
  }

  Future<void> _nuevo() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _GastoFormSheet(),
    );
    if (saved == true) await _cargar();
  }

  Future<void> _anular(GastoOperativo gasto) async {
    await ref.read(gastoRepositoryProvider).anular(gasto);
    await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final total = _gastos
        .where((gasto) => gasto.estado != 'anulado')
        .fold<double>(0, (sum, gasto) => sum + gasto.montoTotal);
    return Scaffold(
      appBar: AppBar(title: const Text('Gastos')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _nuevo,
        icon: const Icon(Icons.add_card),
        label: const Text('Gasto'),
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            Card(
              color: AppColors.warning.withValues(alpha: 0.08),
              child: ListTile(
                leading: const Icon(Icons.receipt_long_outlined),
                title: const Text('Gastos registrados'),
                subtitle: Text('${_gastos.length} movimiento(s)'),
                trailing: Text(
                  Formatters.currency(total),
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (_cargando)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_gastos.isEmpty)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: Text('No hay gastos registrados')),
              )
            else
              for (final gasto in _gastos) ...[
                Card(
                  margin: EdgeInsets.zero,
                  child: ListTile(
                    leading: CircleAvatar(
                      child: Icon(gasto.estado == 'anulado'
                          ? Icons.cancel_outlined
                          : Icons.payments_outlined),
                    ),
                    title: Text(gasto.descripcion),
                    subtitle: Text(
                      [
                        gasto.categoria,
                        gasto.proveedorNombre,
                        Formatters.date(gasto.fechaComprobante),
                        if (gasto.ncf?.isNotEmpty == true) gasto.ncf,
                      ].whereType<String>().join(' · '),
                    ),
                    trailing: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          Formatters.currency(gasto.montoTotal),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        if (gasto.estado != 'anulado')
                          InkWell(
                            onTap: () => _anular(gasto),
                            child: const Text('Anular',
                                style: TextStyle(color: AppColors.danger)),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 8),
              ],
          ],
        ),
      ),
    );
  }
}

class _GastoFormSheet extends ConsumerStatefulWidget {
  const _GastoFormSheet();

  @override
  ConsumerState<_GastoFormSheet> createState() => _GastoFormSheetState();
}

class _GastoFormSheetState extends ConsumerState<_GastoFormSheet> {
  final _descripcionCtrl = TextEditingController();
  final _montoCtrl = TextEditingController();
  final _itbisCtrl = TextEditingController(text: '0');
  final _ncfCtrl = TextEditingController();
  String _categoria = 'operativo';
  String _metodoPago = 'efectivo';
  Proveedor? _proveedor;
  bool _guardando = false;

  @override
  void dispose() {
    _descripcionCtrl.dispose();
    _montoCtrl.dispose();
    _itbisCtrl.dispose();
    _ncfCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final monto = double.tryParse(_montoCtrl.text.replaceAll(',', '.')) ?? 0;
    final itbis = double.tryParse(_itbisCtrl.text.replaceAll(',', '.')) ?? 0;
    final descripcion = _descripcionCtrl.text.trim();
    if (auth.empresaId == null ||
        usuario == null ||
        monto <= 0 ||
        descripcion.isEmpty) {
      return;
    }
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(gastoRepositoryProvider).crear(
            empresaId: auth.empresaId!,
            usuarioId: usuario.id,
            categoria: _categoria,
            descripcion: descripcion,
            fechaComprobante: DateTime.now(),
            montoTotal: monto,
            itbis: itbis,
            metodoPago: _metodoPago,
            proveedorId: _proveedor?.id,
            ncf: _ncfCtrl.text.trim().isEmpty ? null : _ncfCtrl.text.trim(),
            sucursalId: sucursal?.id,
            cajaId: caja?.id,
            dispositivoId: deviceId,
          );
      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final empresaId = ref.watch(authControllerProvider).empresaId;
    final proveedoresFuture = empresaId == null
        ? Future<List<Proveedor>>.value(const [])
        : ref.watch(proveedorRepositoryProvider).deEmpresa(empresaId);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: FutureBuilder<List<Proveedor>>(
        future: proveedoresFuture,
        builder: (context, snapshot) {
          final proveedores = snapshot.data ?? const <Proveedor>[];
          return SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Registrar gasto',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                TextField(
                  controller: _descripcionCtrl,
                  decoration: const InputDecoration(labelText: 'Descripción'),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _categoria,
                  decoration: const InputDecoration(labelText: 'Categoría'),
                  items: const [
                    DropdownMenuItem(
                        value: 'operativo', child: Text('Operativo')),
                    DropdownMenuItem(
                        value: 'servicio', child: Text('Servicio')),
                    DropdownMenuItem(value: 'nomina', child: Text('Nómina')),
                    DropdownMenuItem(
                        value: 'transporte', child: Text('Transporte')),
                    DropdownMenuItem(value: 'otro', child: Text('Otro')),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _categoria = value);
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<Proveedor>(
                  initialValue: _proveedor,
                  decoration: const InputDecoration(labelText: 'Proveedor'),
                  items: [
                    for (final proveedor in proveedores)
                      DropdownMenuItem(
                          value: proveedor, child: Text(proveedor.nombre)),
                  ],
                  onChanged: (value) => setState(() => _proveedor = value),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _ncfCtrl,
                  decoration: const InputDecoration(labelText: 'NCF / e-CF'),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _montoCtrl,
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
                        decoration: const InputDecoration(
                            labelText: 'Monto', prefixText: 'RD\$ '),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextField(
                        controller: _itbisCtrl,
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
                        decoration: const InputDecoration(
                            labelText: 'ITBIS', prefixText: 'RD\$ '),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _metodoPago,
                  decoration: const InputDecoration(labelText: 'Método'),
                  items: const [
                    DropdownMenuItem(
                        value: 'efectivo', child: Text('Efectivo')),
                    DropdownMenuItem(value: 'tarjeta', child: Text('Tarjeta')),
                    DropdownMenuItem(
                        value: 'transferencia', child: Text('Transferencia')),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _metodoPago = value);
                  },
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _guardando ? null : _guardar,
                    icon: const Icon(Icons.save_outlined),
                    label: Text(_guardando ? 'Guardando...' : 'Guardar'),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
