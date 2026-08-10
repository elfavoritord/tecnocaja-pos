import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/ncf.dart';
import '../../core/constants/permisos.dart';
import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../data/providers/contexto_operativo_provider.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/fiscal_repository.dart';
import '../../widgets/loading_button.dart';

/// Configuración de facturación fiscal (NCF tradicional en esta fase --
/// e-CF con firma digital y envío a la DGII queda para una fase posterior,
/// ver `functions/fiscal.js`). Reemplaza el redirect vacío que tenía la
/// ruta `/fiscal` hacia Ajustes.
class FiscalConfigScreen extends ConsumerStatefulWidget {
  const FiscalConfigScreen({super.key});

  @override
  ConsumerState<FiscalConfigScreen> createState() =>
      _FiscalConfigScreenState();
}

class _FiscalConfigScreenState extends ConsumerState<FiscalConfigScreen> {
  String? _businessRemoteId;
  FiscalSettings? _settings;
  List<NcfSequenceInfo> _secuencias = const [];
  bool _cargando = true;
  bool _guardandoToggle = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _cargar();
  }

  Future<void> _cargar() async {
    setState(() {
      _cargando = true;
      _error = null;
    });
    try {
      final empresa = await ref.read(empresaRepositoryProvider).actual();
      final remoteId = empresa?.remotoId;
      if (remoteId == null || remoteId.isEmpty) {
        setState(() {
          _businessRemoteId = null;
          _cargando = false;
        });
        return;
      }
      final repo = ref.read(fiscalRepositoryProvider);
      final settings = await repo.obtener(remoteId);
      final secuencias = await repo.listarSecuencias(remoteId);
      if (!mounted) return;
      setState(() {
        _businessRemoteId = remoteId;
        _settings = settings;
        _secuencias = secuencias;
        _cargando = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is AppException ? e.message : 'No se pudo cargar: $e';
        _cargando = false;
      });
    }
  }

  Future<void> _alternarUsaComprobantes(bool activo) async {
    final remoteId = _businessRemoteId;
    if (remoteId == null) return;
    setState(() => _guardandoToggle = true);
    try {
      final modo = activo ? 'ncf_tradicional' : 'sin_comprobantes';
      await ref
          .read(fiscalRepositoryProvider)
          .actualizarUsaComprobantes(remoteId, activo: activo, modo: modo);
      await ref.read(configuracionControllerProvider.notifier).actualizar(
            (c) => c.copyWith(
              fiscalUsaComprobantes: activo,
              fiscalModoComprobante: modo,
            ),
          );
      if (!mounted) return;
      setState(() {
        _settings = FiscalSettings(
          usaComprobantesFiscales: activo,
          modoComprobante: modo,
          ambiente: _settings?.ambiente ?? 'certificacion',
          eCfActivo: _settings?.eCfActivo ?? false,
          eCfValidado: _settings?.eCfValidado ?? false,
        );
      });
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(e is AppException ? e.message : 'No se pudo guardar: $e'),
          backgroundColor: AppColors.danger,
        ));
      }
    } finally {
      if (mounted) setState(() => _guardandoToggle = false);
    }
  }

  Future<void> _abrirFormularioSecuencia() async {
    final remoteId = _businessRemoteId;
    if (remoteId == null) return;
    final creada = await showDialog<bool>(
      context: context,
      builder: (context) => _DialogoNuevaSecuencia(businessId: remoteId),
    );
    if (creada == true) await _cargar();
  }

  @override
  Widget build(BuildContext context) {
    final permisos =
        ref.watch(permisosUsuarioActualProvider).valueOrNull ?? <Permiso>{};
    final tieneAcceso = permisos.contains(Permiso.accederECF);

    return Scaffold(
      appBar: AppBar(title: const Text('Facturación fiscal')),
      body: !tieneAcceso
          ? const _SinAcceso()
          : _cargando
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? _ErrorCarga(mensaje: _error!, onReintentar: _cargar)
                  : _businessRemoteId == null
                      ? const _SinNegocioEnLaNube()
                      : _contenido(),
    );
  }

  Widget _contenido() {
    final settings = _settings;
    final activo = settings?.usaComprobantesFiscales ?? false;
    return RefreshIndicator(
      onRefresh: _cargar,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: SwitchListTile(
              title: const Text('Usar comprobantes fiscales (NCF)'),
              subtitle: const Text(
                  'Permite elegir Crédito Fiscal o Consumidor Final al cobrar.'),
              value: activo,
              onChanged: _guardandoToggle ? null : _alternarUsaComprobantes,
            ),
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.info.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline, color: AppColors.info),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'La facturación electrónica (e-CF) con firma digital y '
                    'envío a la DGII todavía no está disponible en la app — '
                    'próximamente. Por ahora se emiten NCF tradicionales.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
          if (activo) ...[
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Secuencias NCF',
                    style: Theme.of(context).textTheme.titleMedium),
                TextButton.icon(
                  onPressed: _abrirFormularioSecuencia,
                  icon: const Icon(Icons.add),
                  label: const Text('Agregar'),
                ),
              ],
            ),
            if (_secuencias.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(
                    'No hay secuencias configuradas todavía. Agrega el rango '
                    'que te autorizó la DGII para poder emitir NCF.'),
              )
            else
              ..._secuencias.map((s) => Card(
                    child: ListTile(
                      leading: Icon(
                        s.agotada
                            ? Icons.warning_amber_rounded
                            : Icons.confirmation_number_outlined,
                        color: s.agotada ? AppColors.danger : AppColors.success,
                      ),
                      title:
                          Text('${s.ncfType} — ${NcfType.etiquetaDe(s.ncfType)}'),
                      subtitle: Text(
                        'Ambiente: ${s.ambiente} · Próximo: ${s.siguienteNumero} '
                        'de ${s.maximo}${s.agotada ? " (agotada)" : ""}'
                        '${s.activa ? "" : " · inactiva"}',
                      ),
                    ),
                  )),
          ],
        ],
      ),
    );
  }
}

class _SinAcceso extends StatelessWidget {
  const _SinAcceso();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 48, color: AppColors.danger),
            SizedBox(height: 12),
            Text(
              'No tienes permiso para configurar la facturación fiscal. '
              'Pide a un administrador que te lo otorgue.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _SinNegocioEnLaNube extends StatelessWidget {
  const _SinNegocioEnLaNube();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_outlined, size: 48),
            SizedBox(height: 12),
            Text(
              'Necesitas estar sincronizado con la nube para usar la '
              'facturación fiscal (el NCF se reserva de forma centralizada '
              'para que nunca se repita entre dispositivos).',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorCarga extends StatelessWidget {
  const _ErrorCarga({required this.mensaje, required this.onReintentar});
  final String mensaje;
  final VoidCallback onReintentar;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppColors.danger),
            const SizedBox(height: 12),
            Text(mensaje, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
                onPressed: onReintentar, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}

class _DialogoNuevaSecuencia extends ConsumerStatefulWidget {
  const _DialogoNuevaSecuencia({required this.businessId});
  final String businessId;

  @override
  ConsumerState<_DialogoNuevaSecuencia> createState() =>
      _DialogoNuevaSecuenciaState();
}

class _DialogoNuevaSecuenciaState
    extends ConsumerState<_DialogoNuevaSecuencia> {
  String _tipo = NcfType.b02;
  String _ambiente = 'certificacion';
  final _desdeCtrl = TextEditingController(text: '1');
  final _maximoCtrl = TextEditingController();
  bool _guardando = false;
  String? _error;

  @override
  void dispose() {
    _desdeCtrl.dispose();
    _maximoCtrl.dispose();
    super.dispose();
  }

  Future<void> _guardar() async {
    final desde = int.tryParse(_desdeCtrl.text.trim());
    final maximo = int.tryParse(_maximoCtrl.text.trim());
    if (desde == null || maximo == null || desde < 1 || maximo < desde) {
      setState(() => _error =
          'Verifica que "desde" y "hasta" sean números válidos (hasta >= desde).');
      return;
    }
    setState(() {
      _guardando = true;
      _error = null;
    });
    try {
      await ref.read(fiscalRepositoryProvider).configurarSecuencia(
            businessId: widget.businessId,
            ncfType: _tipo,
            desde: desde,
            maximo: maximo,
            ambiente: _ambiente,
          );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is AppException ? e.message : 'No se pudo guardar: $e';
          _guardando = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Agregar secuencia NCF'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              initialValue: _tipo,
              decoration: const InputDecoration(labelText: 'Tipo de NCF'),
              items: NcfType.etiquetas.entries
                  .map((e) => DropdownMenuItem(
                        value: e.key,
                        child: Text('${e.key} — ${e.value}'),
                      ))
                  .toList(),
              onChanged: (v) => setState(() => _tipo = v ?? _tipo),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _ambiente,
              decoration: const InputDecoration(labelText: 'Ambiente'),
              items: const [
                DropdownMenuItem(
                    value: 'certificacion', child: Text('Certificación')),
                DropdownMenuItem(
                    value: 'produccion', child: Text('Producción')),
              ],
              onChanged: (v) => setState(() => _ambiente = v ?? _ambiente),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _desdeCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Desde'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _maximoCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Hasta'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: AppColors.danger)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed:
              _guardando ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancelar'),
        ),
        LoadingButton(
          label: 'Guardar',
          isLoading: _guardando,
          onPressed: _guardar,
        ),
      ],
    );
  }
}
