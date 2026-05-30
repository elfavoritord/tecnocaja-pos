import 'package:flutter/material.dart';

class AppBrandLogo extends StatelessWidget {
  final double width;

  const AppBrandLogo({super.key, this.width = 260});

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/images/tecno reporte logo.png',
      width: width,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
      errorBuilder: (_, _, _) {
        return Container(
          width: width * 0.34,
          height: width * 0.34,
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(
              color: Colors.white.withValues(alpha: 0.3),
              width: 1.5,
            ),
          ),
          child: const Icon(
            Icons.bar_chart_rounded,
            size: 52,
            color: Colors.white,
          ),
        );
      },
    );
  }
}
