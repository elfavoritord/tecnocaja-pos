import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers/service_providers.dart';
import '../../core/theme/app_colors.dart';
import '../../core/utils/formatters.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/rrhh_repository.dart';

class RrhhScreen extends ConsumerStatefulWidget {
  const RrhhScreen({super.key});

  @override
  ConsumerState<RrhhScreen> createState() => _RrhhScreenState();
}

class _RrhhScreenState extends ConsumerState<RrhhScreen> {
  List<AsistenciaRrhh> _asistencias = [];
  AsistenciaRrhh? _abierta;
  bool _cargando = true;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    final auth = ref.read(authControllerProvider);
    if (auth.empresaId == null || auth.usuario == null) return;
    setState(() => _cargando = true);
    final repo = ref.read(rrhhRepositoryProvider);
    final results = await Future.wait([
      repo.asistencias(auth.empresaId!),
      repo.abierta(auth.usuario!.id),
    ]);
    if (mounted) {
      setState(() {
        _asistencias = results[0] as List<AsistenciaRrhh>;
        _abierta = results[1] as AsistenciaRrhh?;
        _cargando = false;
      });
    }
  }

  Future<void> _marcar() async {
    final auth = ref.read(authControllerProvider);
    final usuario = auth.usuario;
    if (auth.empresaId == null || usuario == null) return;
    final repo = ref.read(rrhhRepositoryProvider);
    if (_abierta == null) {
      final sucursal = await ref.read(sucursalActivaProvider.future);
      final caja = await ref.read(cajaActivaProvider.future);
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await repo.entrada(
        empresaId: auth.empresaId!,
        usuarioId: usuario.id,
        sucursalId: sucursal?.id,
        cajaId: caja?.id,
        dispositivoId: deviceId,
      );
    } else {
      await repo.salida(_abierta!);
    }
    await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('RRHH')),
      body: RefreshIndicator(
        onRefresh: _cargar,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              color: (_abierta == null ? AppColors.info : AppColors.success)
                  .withValues(alpha: 0.08),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _abierta == null ? 'Fuera de turno' : 'Turno activo',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    if (_abierta != null)
                      Text(
                          'Entrada ${Formatters.dateTime(_abierta!.entradaEn)}'),
                    const SizedBox(height: 12),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _marcar,
                        icon:
                            Icon(_abierta == null ? Icons.login : Icons.logout),
                        label: Text(_abierta == null
                            ? 'Marcar entrada'
                            : 'Marcar salida'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('Asistencia reciente',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_cargando)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_asistencias.isEmpty)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: Text('No hay asistencia registrada')),
              )
            else
              for (final asistencia in _asistencias)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(asistencia.salidaEn == null
                      ? Icons.timer
                      : Icons.check_circle_outline),
                  title: Text(asistencia.usuarioNombre),
                  subtitle: Text(
                    [
                      'Entrada ${Formatters.dateTime(asistencia.entradaEn)}',
                      if (asistencia.salidaEn != null)
                        'Salida ${Formatters.dateTime(asistencia.salidaEn!)}',
                    ].join(' · '),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}
