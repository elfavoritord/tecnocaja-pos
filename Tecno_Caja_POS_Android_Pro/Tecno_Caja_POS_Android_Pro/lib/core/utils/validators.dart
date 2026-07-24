/// Validaciones de formularios. Los checksums de cedula/RNC son el algoritmo
/// modulo-11 publico usado por DGII -- validan el FORMATO, no si el numero
/// esta activo en el padron (eso requiere consultar server/routes/rnc.routes.js
/// del backend Windows, ver Fase de sincronizacion).
class Validators {
  Validators._();

  static final RegExp _emailRegex = RegExp(r'^[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}$');
  static final RegExp _phoneRegex = RegExp(r'^\+?1?\s?8[024]9[\s-]?\d{3}[\s-]?\d{4}$');

  static String? required(String? value, {String label = 'Este campo'}) {
    if (value == null || value.trim().isEmpty) return '$label es obligatorio.';
    return null;
  }

  static String? email(String? value) {
    if (value == null || value.trim().isEmpty) return 'El correo es obligatorio.';
    if (!_emailRegex.hasMatch(value.trim())) return 'Correo invalido.';
    return null;
  }

  static String? phoneRD(String? value, {bool optional = false}) {
    if (value == null || value.trim().isEmpty) {
      return optional ? null : 'El telefono es obligatorio.';
    }
    if (!_phoneRegex.hasMatch(value.trim())) {
      return 'Telefono invalido (formato 809/829/849-000-0000).';
    }
    return null;
  }

  static String? password(String? value) {
    if (value == null || value.isEmpty) return 'La contrasena es obligatoria.';
    if (value.length < 8) return 'Minimo 8 caracteres.';
    if (!RegExp(r'[A-Za-z]').hasMatch(value) || !RegExp(r'[0-9]').hasMatch(value)) {
      return 'Debe combinar letras y numeros.';
    }
    return null;
  }

  static String? confirmPassword(String? value, String original) {
    if (value != original) return 'Las contrasenas no coinciden.';
    return null;
  }

  static String? positiveNumber(String? value, {String label = 'El valor'}) {
    if (value == null || value.trim().isEmpty) return '$label es obligatorio.';
    final parsed = double.tryParse(value.replaceAll(',', '.'));
    if (parsed == null) return '$label debe ser numerico.';
    if (parsed < 0) return '$label no puede ser negativo.';
    return null;
  }

  /// Cedula dominicana (11 digitos) o RNC (9 digitos), algoritmo modulo-11.
  static String? cedulaORnc(String? value, {bool optional = false}) {
    if (value == null || value.trim().isEmpty) {
      return optional ? null : 'Cedula o RNC obligatorio.';
    }
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.length == 11) {
      return _validaCedula(digits) ? null : 'Cedula invalida.';
    }
    if (digits.length == 9) {
      return _validaRnc(digits) ? null : 'RNC invalido.';
    }
    return 'Debe tener 9 digitos (RNC) u 11 (cedula).';
  }

  static bool _validaCedula(String digits) {
    const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
    var sum = 0;
    for (var i = 0; i < 10; i++) {
      var product = int.parse(digits[i]) * weights[i];
      if (product >= 10) {
        product = (product ~/ 10) + (product % 10);
      }
      sum += product;
    }
    final checkDigit = (10 - (sum % 10)) % 10;
    return checkDigit == int.parse(digits[10]);
  }

  static bool _validaRnc(String digits) {
    const weights = [7, 9, 8, 6, 5, 4, 3, 2];
    var sum = 0;
    for (var i = 0; i < 8; i++) {
      sum += int.parse(digits[i]) * weights[i];
    }
    final remainder = sum % 11;
    final checkDigit = remainder < 2 ? 1 - remainder : 11 - remainder;
    return checkDigit == int.parse(digits[8]);
  }
}
