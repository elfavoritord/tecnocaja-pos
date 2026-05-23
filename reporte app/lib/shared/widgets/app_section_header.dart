import 'package:flutter/material.dart';
import '../../core/constants/app_colors.dart';

class AppSectionHeader extends StatelessWidget {
  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  const AppSectionHeader({
    super.key,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final compact = MediaQuery.sizeOf(context).width < 400;
    final h = compact ? 12.0 : 16.0;
    final vTop = compact ? 12.0 : 18.0;
    final vBottom = compact ? 6.0 : 8.0;
    return Padding(
      padding: EdgeInsets.fromLTRB(h, vTop, h, vBottom),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  fontSize: compact ? 13.0 : null,
                ),
          ),
          if (actionLabel != null)
            TextButton(
              onPressed: onAction,
              style: TextButton.styleFrom(
                foregroundColor: AppColors.primary,
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(
                actionLabel!,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
        ],
      ),
    );
  }
}
