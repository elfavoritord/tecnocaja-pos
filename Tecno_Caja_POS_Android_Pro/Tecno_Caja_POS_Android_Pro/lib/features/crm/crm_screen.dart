import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/cliente_repository.dart';
import '../../data/repositories/crm_repository.dart';
import '../../domain/entities/cliente.dart';

class CrmScreen extends ConsumerStatefulWidget {
  const CrmScreen({super.key});

  @override
  ConsumerState<CrmScreen> createState() => _CrmScreenState();
}

class _CrmScreenState extends ConsumerState<CrmScreen> {
  List<ClienteSeguimiento> _seguimientos = [];
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
    final items = await ref.read(crmRepositoryProvider).deEmpresa(empresaId);
    if (mounted) {
      setState(() {
        _seguimientos = items;
        _cargando = false;
      });
    }
  }

  Future<void> _nuevo() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _SeguimientoFormSheet(),
    );
    if (saved == true) await _cargar();
  }

  Future<void> _toggle(ClienteSeguimiento seguimiento) async {
    await ref
        .read(crmRepositoryProvider)
        .completar(seguimiento, !seguimiento.completado);
    await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final pendientes = _seguimientos.where((item) => !item.completado).length;
    return Scaffold(
      appBar: AppBar(title: const Text('CRM')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _nuevo,
        icon: const Icon(Icons.add_task),
        label: const Text('Seguimiento'),
      ),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            Card(
              color: AppColors.info.withValues(alpha: 0.08),
              child: ListTile(
                leading: const Icon(Icons.people_alt_outlined),
                title: const Text('Seguimientos pendientes'),
                trailing: Text(
                  '$pendientes',
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (_cargando)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_seguimientos.isEmpty)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: Text('No hay seguimientos todavía')),
              )
            else
              for (final item in _seguimientos) ...[
                Card(
                  margin: EdgeInsets.zero,
                  child: CheckboxListTile(
                    value: item.completado,
                    onChanged: (_) => _toggle(item),
                    title: Text(item.titulo),
                    subtitle: Text(
                      [
                        item.clienteNombre,
                        item.tipo,
                        if (item.fechaProgramada != null)
                          Formatters.dateTime(item.fechaProgramada!),
                        if (item.detalle?.isNotEmpty == true) item.detalle,
                      ].whereType<String>().join(' · '),
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

class _SeguimientoFormSheet extends ConsumerStatefulWidget {
  const _SeguimientoFormSheet();

  @override
  ConsumerState<_SeguimientoFormSheet> createState() =>
      _SeguimientoFormSheetState();
}

class _SeguimientoFormSheetState extends ConsumerState<_SeguimientoFormSheet> {
  final _tituloCtrl = TextEditingController();
  final _detalleCtrl = TextEditingController();
  Cliente? _cliente;
  String _tipo = 'nota';
  bool _guardando = false;

  @override
  void dispose() {
    _tituloCtrl.dispose();
    _detalleCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    final titulo = _tituloCtrl.text.trim();
    if (auth.empresaId == null ||
        usuario == null ||
        _cliente == null ||
        titulo.isEmpty) {
      return;
    }
    setState(() => _guardando = true);
    try {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(crmRepositoryProvider).crear(
            empresaId: auth.empresaId!,
            usuarioId: usuario.id,
            clienteId: _cliente!.id,
            tipo: _tipo,
            titulo: titulo,
            detalle: _detalleCtrl.text.trim().isEmpty
                ? null
                : _detalleCtrl.text.trim(),
            fechaProgramada: DateTime.now().add(const Duration(days: 1)),
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
    final clientesFuture = empresaId == null
        ? Future<List<Cliente>>.value(const [])
        : ref.watch(clienteRepositoryProvider).deEmpresa(empresaId);
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: FutureBuilder<List<Cliente>>(
        future: clientesFuture,
        builder: (context, snapshot) {
          final clientes = snapshot.data ?? const <Cliente>[];
          return SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Nuevo seguimiento',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                DropdownButtonFormField<Cliente>(
                  initialValue: _cliente,
                  decoration: const InputDecoration(labelText: 'Cliente'),
                  items: [
                    for (final cliente in clientes)
                      DropdownMenuItem(
                          value: cliente, child: Text(cliente.nombre)),
                  ],
                  onChanged: (value) => setState(() => _cliente = value),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _tipo,
                  decoration: const InputDecoration(labelText: 'Tipo'),
                  items: const [
                    DropdownMenuItem(value: 'nota', child: Text('Nota')),
                    DropdownMenuItem(value: 'llamada', child: Text('Llamada')),
                    DropdownMenuItem(value: 'cobro', child: Text('Cobro')),
                    DropdownMenuItem(value: 'visita', child: Text('Visita')),
                    DropdownMenuItem(
                        value: 'recordatorio', child: Text('Recordatorio')),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _tipo = value);
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _tituloCtrl,
                  decoration: const InputDecoration(labelText: 'Título'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _detalleCtrl,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(labelText: 'Detalle'),
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
