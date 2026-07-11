import 'package:cloud_functions/cloud_functions.dart';

class DgiiResult {
  final String rnc;
  final String nombre;
  final String? nombreComercial;
  final String? categoria;
  final String estado;
  final bool isFisico;

  const DgiiResult({
    required this.rnc,
    required this.nombre,
    this.nombreComercial,
    this.categoria,
    required this.estado,
    required this.isFisico,
  });

  bool get isActivo {
    final s = estado.toUpperCase();
    return s == 'ACTIVO' || s == 'NORMAL';
  }

  String get nombreDisplay => _titleCase(nombre);
  String? get nombreComercialDisplay {
    if (nombreComercial == null || nombreComercial!.isEmpty) return null;
    final nc = _titleCase(nombreComercial!);
    return nc == nombreDisplay ? null : nc;
  }

  static String _titleCase(String s) {
    if (s.isEmpty) return '';
    return s.toLowerCase().split(' ').map((w) => w.isEmpty ? '' : w[0].toUpperCase() + w.substring(1)).join(' ');
  }
}

class DgiiService {
  static final _fn = FirebaseFunctions.instance.httpsCallable(
    'dgiiLookup',
    options: HttpsCallableOptions(timeout: const Duration(seconds: 12)),
  );

  static Future<DgiiResult?> buscar(String rncOrCedula) async {
    final digits = rncOrCedula.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length < 9) return null;

    try {
      final res = await _fn.call({'rnc': digits});
      final data = res.data as Map<dynamic, dynamic>;

      if (data['found'] != true) return null;

      final tipo = (data['tipo'] as String? ?? '').toUpperCase();
      return DgiiResult(
        rnc: data['rnc'] as String? ?? digits,
        nombre: data['nombre'] as String? ?? '',
        nombreComercial: data['nombreComercial'] as String?,
        categoria: data['categoria'] as String?,
        estado: data['estado'] as String? ?? 'ACTIVO',
        isFisico: tipo == 'FISICO' || tipo.contains('FÍSICA') || tipo.contains('FISICA'),
      );
    } catch (_) {
      return null;
    }
  }

  static String mensajeError(String digits) {
    if (digits.length == 11) {
      return 'Cédula no registrada como contribuyente en DGII.';
    }
    return 'RNC no encontrado en el registro DGII.';
  }
}
