import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:table_calendar/table_calendar.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/fiscal_calendar.dart';
import '../../../core/utils/app_date_utils.dart';

class CalendarioScreen extends ConsumerStatefulWidget {
  const CalendarioScreen({super.key});

  @override
  ConsumerState<CalendarioScreen> createState() => _CalendarioScreenState();
}

class _CalendarioScreenState extends ConsumerState<CalendarioScreen> {
  DateTime _focused = DateTime.now();
  DateTime? _selected;
  late List<FiscalEvent> _eventos;

  @override
  void initState() {
    super.initState();
    _eventos = FiscalCalendar.getEventsForYear(DateTime.now().year);
  }

  List<FiscalEvent> _eventosDelDia(DateTime day) {
    return _eventos.where((e) => e.mes == day.month && e.dia == day.day).toList();
  }

  @override
  Widget build(BuildContext context) {
    final eventosDia = _selected != null ? _eventosDelDia(_selected!) : <FiscalEvent>[];
    final proximosVencer = _getProximos();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Calendario Fiscal'),
        actions: [
          IconButton(
            icon: const Icon(Icons.event_rounded),
            tooltip: 'Agenda',
            onPressed: () => context.push('/agenda'),
          ),
        ],
      ),
      body: Column(
        children: [
          TableCalendar<FiscalEvent>(
            firstDay: DateTime(2020),
            lastDay: DateTime(2030),
            focusedDay: _focused,
            selectedDayPredicate: (day) => isSameDay(_selected, day),
            onDaySelected: (sel, foc) => setState(() { _selected = sel; _focused = foc; }),
            onPageChanged: (foc) {
              setState(() {
                _focused = foc;
                _eventos = FiscalCalendar.getEventsForYear(foc.year);
              });
            },
            eventLoader: _eventosDelDia,
            calendarStyle: CalendarStyle(
              markerDecoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle),
              todayDecoration: BoxDecoration(color: AppColors.primary.withValues(alpha: 0.3), shape: BoxShape.circle),
              selectedDecoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle),
              outsideDaysVisible: false,
            ),
            headerStyle: const HeaderStyle(formatButtonVisible: false, titleCentered: true),
          ),
          const Divider(height: 1),
          Expanded(
            child: eventosDia.isNotEmpty
                ? _EventosDia(eventos: eventosDia, fecha: _selected!)
                : _ProximosVencer(eventos: proximosVencer),
          ),
        ],
      ),
    );
  }

  List<_ProximoEvento> _getProximos() {
    final hoy = DateTime.now();
    final result = <_ProximoEvento>[];
    for (int offset = 0; offset <= 45; offset++) {
      final dia = DateTime(hoy.year, hoy.month, hoy.day + offset);
      final eventos = _eventosDelDia(dia);
      for (final e in eventos) {
        result.add(_ProximoEvento(evento: e, fecha: dia));
      }
    }
    return result.take(10).toList();
  }
}

class _EventosDia extends StatelessWidget {
  final List<FiscalEvent> eventos;
  final DateTime fecha;
  const _EventosDia({required this.eventos, required this.fecha});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Text(
            AppDateUtils.formatFecha(fecha),
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            itemCount: eventos.length,
            itemBuilder: (_, i) {
              final e = eventos[i];
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                    child: Text(FiscalCalendar.getTipoLabel(e.tipo), style: const TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 11)),
                  ),
                  title: Text(e.nombre, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(e.descripcion, style: const TextStyle(fontSize: 12)),
                  trailing: FilledButton.tonal(
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8)),
                    onPressed: () => context.push('/declaraciones/new'),
                    child: const Text('Registrar', style: TextStyle(fontSize: 12)),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ProximoEvento {
  final FiscalEvent evento;
  final DateTime fecha;
  const _ProximoEvento({required this.evento, required this.fecha});
}

class _ProximosVencer extends StatelessWidget {
  final List<_ProximoEvento> eventos;
  const _ProximosVencer({required this.eventos});

  @override
  Widget build(BuildContext context) {
    if (eventos.isEmpty) {
      return const Center(child: Text('No hay vencimientos próximos', style: TextStyle(color: AppColors.textSecondary)));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Text('Próximos vencimientos fiscales', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            itemCount: eventos.length,
            itemBuilder: (_, i) {
              final pe = eventos[i];
              final hoy = DateTime.now();
              final dias = pe.fecha.difference(DateTime(hoy.year, hoy.month, hoy.day)).inDays;
              final urgent = dias <= 5;
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: Container(
                    width: 40, height: 40,
                    decoration: BoxDecoration(
                      color: (urgent ? AppColors.error : AppColors.warning).withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '${pe.fecha.day}',
                      style: TextStyle(fontWeight: FontWeight.w800, color: urgent ? AppColors.error : AppColors.warning, fontSize: 16),
                    ),
                  ),
                  title: Text(pe.evento.nombre, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  subtitle: Text(AppDateUtils.formatFecha(pe.fecha), style: const TextStyle(fontSize: 12)),
                  trailing: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: (urgent ? AppColors.error : AppColors.warning).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      dias == 0 ? 'Hoy' : 'En $dias días',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: urgent ? AppColors.error : AppColors.warning),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
