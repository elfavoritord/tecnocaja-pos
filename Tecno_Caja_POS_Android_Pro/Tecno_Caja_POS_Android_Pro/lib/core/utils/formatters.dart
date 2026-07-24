import 'package:intl/intl.dart';

/// Formateo de moneda/fecha consistente en toda la app. RD usa punto decimal
/// y coma de miles (como en_US), a diferencia del resto de Latinoamerica.
class Formatters {
  Formatters._();

  static final NumberFormat _dop = NumberFormat.currency(locale: 'es_DO', symbol: r'RD$', decimalDigits: 2);
  static final NumberFormat _usd = NumberFormat.currency(locale: 'en_US', symbol: r'US$', decimalDigits: 2);
  static final NumberFormat _plain = NumberFormat.decimalPattern('en_US');
  static final NumberFormat _percent = NumberFormat.decimalPercentPattern(locale: 'en_US', decimalDigits: 1);
  static final DateFormat _date = DateFormat('dd/MM/yyyy');
  static final DateFormat _dateTime = DateFormat('dd/MM/yyyy hh:mm a');
  static final DateFormat _time = DateFormat('hh:mm a');
  static final DateFormat _monthYear = DateFormat('MMMM yyyy', 'es');

  static String currency(double value, {String currency = 'DOP'}) {
    return currency == 'USD' ? _usd.format(value) : _dop.format(value);
  }

  static String currencyCompact(double value) => _plain.format(value);

  static String percent(double value) => _percent.format(value);

  static String date(DateTime value) => _date.format(value.toLocal());

  static String dateTime(DateTime value) => _dateTime.format(value.toLocal());

  static String time(DateTime value) => _time.format(value.toLocal());

  static String monthYear(DateTime value) => _monthYear.format(value.toLocal());

  /// Redondeo al entero superior en multiplos de [step] (ej. 1.0 = peso
  /// entero, 0.25 = cuarto). Usado por la funcion de redondeo configurable.
  static double roundUpToStep(double value, double step) {
    if (step <= 0) return value;
    return (value / step).ceil() * step;
  }
}
