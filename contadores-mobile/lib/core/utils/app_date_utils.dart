import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:intl/intl.dart';

class AppDateUtils {
  AppDateUtils._();

  static final _fmtFecha = DateFormat('dd/MM/yyyy', 'es_DO');
  static final _fmtFechaHora = DateFormat('dd/MM/yyyy HH:mm', 'es_DO');
  static final _fmtMes = DateFormat('MMMM yyyy', 'es_DO');
  static final _fmtMesCorto = DateFormat('MMM yyyy', 'es_DO');
  static final _fmtDia = DateFormat('dd MMM', 'es_DO');
  static final _fmtHora = DateFormat('HH:mm', 'es_DO');

  static String formatFecha(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtFecha.format(d);
  }

  static String formatFechaHora(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtFechaHora.format(d);
  }

  static String formatMes(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtMes.format(d).capitalize();
  }

  static String formatMesCorto(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtMesCorto.format(d).capitalize();
  }

  static String formatDia(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtDia.format(d);
  }

  static String formatHora(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return '—';
    return _fmtHora.format(d);
  }

  static DateTime? toDateTime(dynamic value) {
    if (value == null) return null;
    if (value is DateTime) return value;
    if (value is Timestamp) return value.toDate();
    if (value is String) {
      try { return DateTime.parse(value); } catch (_) { return null; }
    }
    return null;
  }

  static Timestamp toTimestamp(DateTime dt) => Timestamp.fromDate(dt);

  static int diasRestantes(dynamic fecha) {
    final d = toDateTime(fecha);
    if (d == null) return 0;
    return d.difference(DateTime.now()).inDays;
  }

  static String diasRestantesLabel(dynamic fecha) {
    final dias = diasRestantes(fecha);
    if (dias < 0) return 'Vencido hace ${(-dias)} días';
    if (dias == 0) return 'Vence hoy';
    if (dias == 1) return 'Vence mañana';
    return 'Vence en $dias días';
  }

  static String periodoLabel(int mes, int year) {
    final dt = DateTime(year, mes, 1);
    return _fmtMes.format(dt).capitalize();
  }

  static List<String> getPeriodos(int cantidad) {
    final now = DateTime.now();
    final periodos = <String>[];
    for (int i = 0; i < cantidad; i++) {
      final d = DateTime(now.year, now.month - i, 1);
      periodos.add('${d.year}-${d.month.toString().padLeft(2, '0')}');
    }
    return periodos;
  }
}

extension StringExt on String {
  String capitalize() =>
      isEmpty ? this : '${this[0].toUpperCase()}${substring(1)}';
}
