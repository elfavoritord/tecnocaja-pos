import 'package:intl/intl.dart';

class Formatters {
  Formatters._();

  static final _moneda = NumberFormat.currency(locale: 'es_DO', symbol: 'RD\$', decimalDigits: 2);
  static final _numero = NumberFormat('#,##0', 'es_DO');
  static final _porcentaje = NumberFormat('##0.##%', 'es_DO');

  static String moneda(num? valor) {
    if (valor == null) return 'RD\$ 0.00';
    return _moneda.format(valor);
  }

  static String numero(num? valor) {
    if (valor == null) return '0';
    return _numero.format(valor);
  }

  static String porcentaje(num? valor) {
    if (valor == null) return '0%';
    return _porcentaje.format(valor / 100);
  }

  static String rnc(String? valor) {
    if (valor == null || valor.isEmpty) return '—';
    final digits = valor.replaceAll(RegExp(r'\D'), '');
    if (digits.length == 9) {
      return '${digits.substring(0, 3)}-${digits.substring(3, 8)}-${digits.substring(8)}';
    }
    if (digits.length == 11) {
      return '${digits.substring(0, 3)}-${digits.substring(3, 10)}-${digits.substring(10)}';
    }
    return valor;
  }

  static String telefono(String? valor) {
    if (valor == null || valor.isEmpty) return '—';
    final digits = valor.replaceAll(RegExp(r'\D'), '');
    if (digits.length == 10) {
      return '(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}';
    }
    return valor;
  }

  static String iniciales(String? nombre) {
    if (nombre == null || nombre.trim().isEmpty) return '?';
    final partes = nombre.trim().split(' ').where((p) => p.isNotEmpty).toList();
    if (partes.length == 1) return partes[0][0].toUpperCase();
    return '${partes[0][0]}${partes[1][0]}'.toUpperCase();
  }

  static String estadoLabel(String? estado) {
    switch (estado?.toLowerCase()) {
      case 'active':
      case 'activo':
        return 'Activo';
      case 'trial':
      case 'prueba':
        return 'Prueba';
      case 'expired':
      case 'vencido':
        return 'Vencido';
      case 'suspended':
      case 'suspendido':
        return 'Suspendido';
      case 'cancelled':
      case 'cancelado':
        return 'Cancelado';
      case 'pendiente':
        return 'Pendiente';
      case 'en_proceso':
        return 'En proceso';
      case 'enviada':
        return 'Enviada';
      case 'aprobada':
        return 'Aprobada';
      case 'rechazada':
        return 'Rechazada';
      default:
        return estado ?? '—';
    }
  }

  static String planLabel(String? plan) {
    switch (plan?.toLowerCase()) {
      case 'standalone':
      case 'basic':
        return 'Básico';
      case 'plus':
        return 'Plus';
      case 'enterprise':
        return 'Enterprise';
      default:
        return plan ?? '—';
    }
  }
}
