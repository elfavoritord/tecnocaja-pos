import 'package:flutter/material.dart';
import '../../core/config/app_colors.dart';

class EstadoBadge extends StatelessWidget {
  final String estado;
  final bool large;

  const EstadoBadge({super.key, required this.estado, this.large = false});

  String get _label {
    switch (estado) {
      case 'asignado':
        return 'Asignado';
      case 'en_camino':
        return 'En camino';
      case 'entregado':
        return 'Entregado';
      case 'incidencia':
        return 'Incidencia';
      default:
        return estado;
    }
  }

  IconData get _icon {
    switch (estado) {
      case 'asignado':
        return Icons.assignment_outlined;
      case 'en_camino':
        return Icons.delivery_dining_rounded;
      case 'entregado':
        return Icons.check_circle_outline_rounded;
      case 'incidencia':
        return Icons.warning_amber_rounded;
      default:
        return Icons.help_outline;
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = AppColors.estadoColor(estado);
    final bg = color.withValues(alpha: 0.12);
    final fontSize = large ? 13.0 : 11.0;
    final iconSize = large ? 16.0 : 13.0;
    final padding = large
        ? const EdgeInsets.symmetric(horizontal: 12, vertical: 6)
        : const EdgeInsets.symmetric(horizontal: 8, vertical: 4);

    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(_icon, size: iconSize, color: color),
          const SizedBox(width: 4),
          Text(
            _label,
            style: TextStyle(
              color: color,
              fontSize: fontSize,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
