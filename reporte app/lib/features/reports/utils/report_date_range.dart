import '../../../shared/widgets/app_filter_bar.dart';
import '../../../data/repositories/sales_repository.dart';

DateRange stableRangeForFilter(DateFilter filter, {DateTime? now}) {
  final current = now ?? DateTime.now();
  final today = DateTime(current.year, current.month, current.day);
  final endOfToday = DateTime(
    current.year,
    current.month,
    current.day,
    23,
    59,
    59,
  );

  switch (filter) {
    case DateFilter.today:
      return DateRange(from: today, to: endOfToday);
    case DateFilter.yesterday:
      final yesterday = today.subtract(const Duration(days: 1));
      return DateRange(from: yesterday, to: today);
    case DateFilter.thisWeek:
      return DateRange(
        from: today.subtract(Duration(days: current.weekday - 1)),
        to: endOfToday,
      );
    case DateFilter.thisMonth:
      return DateRange(
        from: DateTime(current.year, current.month, 1),
        to: endOfToday,
      );
    case DateFilter.custom:
      return DateRange(from: today, to: endOfToday);
  }
}
