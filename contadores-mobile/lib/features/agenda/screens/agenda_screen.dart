import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../data/models/agenda_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/agenda_provider.dart';

class AgendaScreen extends ConsumerWidget {
  const AgendaScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final eventosAsync = ref.watch(agendaEventosProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Agenda')),
      body: eventosAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(e.toString(), style: const TextStyle(color: AppColors.error))),
        data: (eventos) => eventos.isEmpty
            ? _EmptyView(onAdd: () => _showForm(context, ref, null))
            : ListView.builder(
                padding: const EdgeInsets.all(16),
                itemCount: eventos.length,
                itemBuilder: (_, i) => _EventoTile(
                  evento: eventos[i],
                  onTap: () => _showForm(context, ref, eventos[i]),
                ),
              ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showForm(context, ref, null),
        child: const Icon(Icons.add_rounded),
      ),
    );
  }

  void _showForm(BuildContext context, WidgetRef ref, AgendaEventModel? evento) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => _AgendaForm(evento: evento),
    );
  }
}

class _EventoTile extends StatelessWidget {
  final AgendaEventModel evento;
  final VoidCallback onTap;
  const _EventoTile({required this.evento, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final hoy = DateTime.now();
    final esPasado = evento.fechaInicio.isBefore(DateTime(hoy.year, hoy.month, hoy.day));
    final esHoy = isSameDay(evento.fechaInicio, hoy);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 44, height: 44,
                decoration: BoxDecoration(
                  color: esHoy ? AppColors.primary.withValues(alpha: 0.15) : esPasado ? AppColors.lightSurfaceVariant : AppColors.primary.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(12),
                ),
                alignment: Alignment.center,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      '${evento.fechaInicio.day}',
                      style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: esHoy ? AppColors.primary : esPasado ? AppColors.textTertiary : AppColors.textPrimary),
                    ),
                    Text(
                      AppDateUtils.formatDia(evento.fechaInicio).split(' ').last.toUpperCase(),
                      style: TextStyle(fontSize: 9, fontWeight: FontWeight.w600, color: esHoy ? AppColors.primary : AppColors.textSecondary),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(evento.titulo, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14, color: esPasado ? AppColors.textSecondary : null)),
                    if (evento.clienteNombre != null)
                      Text(evento.clienteNombre!, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    Text(
                      evento.todoElDia ? 'Todo el día' : AppDateUtils.formatHora(evento.fechaInicio),
                      style: TextStyle(fontSize: 11, color: esPasado ? AppColors.textTertiary : AppColors.primary),
                    ),
                  ],
                ),
              ),
              if (esHoy)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                  decoration: BoxDecoration(color: AppColors.primary, borderRadius: BorderRadius.circular(8)),
                  child: const Text('Hoy', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w600)),
                ),
            ],
          ),
        ),
      ),
    );
  }

  bool isSameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;
}

class _AgendaForm extends ConsumerStatefulWidget {
  final AgendaEventModel? evento;
  const _AgendaForm({this.evento});

  @override
  ConsumerState<_AgendaForm> createState() => _AgendaFormState();
}

class _AgendaFormState extends ConsumerState<_AgendaForm> {
  final _tituloCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  DateTime _fecha = DateTime.now().add(const Duration(hours: 1));
  bool _todoElDia = false;
  String _tipo = 'cita';

  bool get _isEdit => widget.evento != null;

  @override
  void initState() {
    super.initState();
    final e = widget.evento;
    if (e != null) {
      _tituloCtrl.text = e.titulo;
      _descCtrl.text = e.descripcion ?? '';
      _fecha = e.fechaInicio;
      _todoElDia = e.todoElDia;
      _tipo = e.tipo;
    }
  }

  @override
  void dispose() {
    _tituloCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_tituloCtrl.text.trim().isEmpty) return;
    final profile = ref.read(userProfileProvider).valueOrNull;
    if (profile == null) return;

    final evento = AgendaEventModel(
      id: widget.evento?.id ?? '',
      contadorId: profile.contadorDocId,
      titulo: _tituloCtrl.text.trim(),
      descripcion: _descCtrl.text.trim().isEmpty ? null : _descCtrl.text.trim(),
      fechaInicio: _fecha,
      todoElDia: _todoElDia,
      tipo: _tipo,
      color: AgendaEventModel.colores.first,
    );

    final ok = await ref.read(agendaFormProvider.notifier).save(evento, id: widget.evento?.id);
    if (ok && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final formState = ref.watch(agendaFormProvider);
    final bottom = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.fromLTRB(24, 24, 24, 24 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(_isEdit ? 'Editar cita' : 'Nueva cita', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
              const Spacer(),
              if (_isEdit)
                IconButton(
                  icon: const Icon(Icons.delete_outline, color: AppColors.error),
                  onPressed: () async {
                    final ok = await ref.read(agendaFormProvider.notifier).delete(widget.evento!.id);
                    if (ok && context.mounted) Navigator.of(context).pop();
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _tituloCtrl,
            decoration: const InputDecoration(labelText: 'Título *', prefixIcon: Icon(Icons.title_rounded)),
            textCapitalization: TextCapitalization.sentences,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _descCtrl,
            decoration: const InputDecoration(labelText: 'Descripción', prefixIcon: Icon(Icons.notes_rounded)),
            maxLines: 2,
          ),
          const SizedBox(height: 12),
          SwitchListTile(
            title: const Text('Todo el día'),
            value: _todoElDia,
            onChanged: (v) => setState(() => _todoElDia = v),
            contentPadding: EdgeInsets.zero,
          ),
          InkWell(
            onTap: () async {
              final d = await showDatePicker(context: context, initialDate: _fecha, firstDate: DateTime(2020), lastDate: DateTime(2030));
              if (d != null && !_todoElDia) {
                final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_fecha));
                if (t != null && mounted) setState(() => _fecha = DateTime(d.year, d.month, d.day, t.hour, t.minute));
              } else if (d != null) {
                setState(() => _fecha = DateTime(d.year, d.month, d.day));
              }
            },
            borderRadius: BorderRadius.circular(12),
            child: InputDecorator(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.event_rounded), labelText: 'Fecha y hora'),
              child: Text(_todoElDia ? AppDateUtils.formatFecha(_fecha) : AppDateUtils.formatFechaHora(_fecha)),
            ),
          ),
          const SizedBox(height: 20),
          ElevatedButton(
            onPressed: formState.isLoading ? null : _submit,
            child: formState.isLoading
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : Text(_isEdit ? 'Actualizar' : 'Crear cita'),
          ),
        ],
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  final VoidCallback onAdd;
  const _EmptyView({required this.onAdd});

  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.event_note_outlined, size: 64, color: AppColors.textTertiary),
            const SizedBox(height: 16),
            const Text('No hay citas en la agenda', style: TextStyle(color: AppColors.textSecondary, fontSize: 15)),
            const SizedBox(height: 16),
            FilledButton.icon(onPressed: onAdd, icon: const Icon(Icons.add_rounded), label: const Text('Agregar cita')),
          ],
        ),
      );
}
