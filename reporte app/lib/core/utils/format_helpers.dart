import 'package:intl/intl.dart';

class FormatHelpers {
  FormatHelpers._();

  static final _currency = NumberFormat.currency(
    locale: 'es_DO',
    symbol: 'RD\$',
    decimalDigits: 2,
  );

  static final _compact = NumberFormat.compact(locale: 'es');
  static final _percent = NumberFormat.percentPattern('es');
  static final _number = NumberFormat('#,##0.00', 'es');

  static String currency(double amount) => _currency.format(amount);
  static String compact(double value) => _compact.format(value);
  static String percent(double value) => _percent.format(value / 100);
  static String number(double value) => _number.format(value);

  static String currencyCompact(double amount) {
    if (amount >= 1000000) return 'RD\$${_compact.format(amount)}';
    return currency(amount);
  }

  static String trend(double current, double previous) {
    if (previous == 0) return '+0%';
    final diff = ((current - previous) / previous) * 100;
    final sign = diff >= 0 ? '+' : '';
    return '$sign${diff.toStringAsFixed(1)}%';
  }

  static bool isTrendPositive(double current, double previous) {
    if (previous == 0) return true;
    return current >= previous;
  }
}

class DateHelpers {
  DateHelpers._();

  static final _dateFormatter = DateFormat('dd/MM/yyyy', 'es');
  static final _dateTimeFormatter = DateFormat('dd/MM/yyyy HH:mm', 'es');
  static final _timeFormatter = DateFormat('HH:mm', 'es');
  static final _dayMonthFormatter = DateFormat('d MMM', 'es');
  static final _monthYearFormatter = DateFormat('MMMM yyyy', 'es');

  static String date(DateTime dt) => _dateFormatter.format(dt);
  static String dateTime(DateTime dt) => _dateTimeFormatter.format(dt);
  static String time(DateTime dt) => _timeFormatter.format(dt);
  static String dayMonth(DateTime dt) => _dayMonthFormatter.format(dt);
  static String monthYear(DateTime dt) => _monthYearFormatter.format(dt);

  static DateTime get todayStart =>
      DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day);

  static DateTime get todayEnd => todayStart
      .add(const Duration(days: 1))
      .subtract(const Duration(milliseconds: 1));

  static DateTime get weekStart {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day - (now.weekday - 1));
  }

  static DateTime get monthStart {
    final now = DateTime.now();
    return DateTime(now.year, now.month, 1);
  }

  static DateTime get yesterdayStart =>
      todayStart.subtract(const Duration(days: 1));

  static DateTime get lastWeekStart =>
      weekStart.subtract(const Duration(days: 7));

  static DateTime get lastMonthStart {
    final now = DateTime.now();
    return DateTime(now.year, now.month - 1, 1);
  }

  static String relativeTime(DateTime dt) {
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'Ahora mismo';
    if (diff.inMinutes < 60) return 'Hace ${diff.inMinutes} min';
    if (diff.inHours < 24) return 'Hace ${diff.inHours}h';
    if (diff.inDays < 7) return 'Hace ${diff.inDays} días';
    return date(dt);
  }
}
