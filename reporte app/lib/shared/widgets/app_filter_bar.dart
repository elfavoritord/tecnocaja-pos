import 'package:flutter/material.dart';
import '../../core/constants/app_colors.dart';

enum DateFilter { today, yesterday, thisWeek, thisMonth, custom }

extension DateFilterExt on DateFilter {
  String get label {
    switch (this) {
      case DateFilter.today: return 'Hoy';
      case DateFilter.yesterday: return 'Ayer';
      case DateFilter.thisWeek: return 'Esta semana';
      case DateFilter.thisMonth: return 'Este mes';
      case DateFilter.custom: return 'Personalizado';
    }
  }
}

class AppFilterBar extends StatelessWidget {
  final DateFilter selected;
  final ValueChanged<DateFilter> onChanged;

  const AppFilterBar({
    super.key,
    required this.selected,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 36,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        children: DateFilter.values.map((f) {
          final isSelected = f == selected;
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilterChip(
              label: Text(f.label),
              selected: isSelected,
              onSelected: (_) => onChanged(f),
              selectedColor: AppColors.primary.withValues(alpha: 0.15),
              checkmarkColor: AppColors.primary,
              labelStyle: TextStyle(
                fontSize: 13,
                fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                color: isSelected ? AppColors.primary : null,
              ),
              side: BorderSide(
                color: isSelected ? AppColors.primary : AppColors.lightBorder,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 4),
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          );
        }).toList(),
      ),
    );
  }
}
