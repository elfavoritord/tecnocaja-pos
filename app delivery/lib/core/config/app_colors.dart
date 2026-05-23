import 'package:flutter/material.dart';

class AppColors {
  // Paleta Tecno Caja Delivery
  static const primary = Color(0xFF1565C0);
  static const primaryLight = Color(0xFF1E88E5);
  static const primaryDark = Color(0xFF0D47A1);
  static const accent = Color(0xFF2196F3);

  // Estados de pedido
  static const asignado = Color(0xFF1E88E5);
  static const enCamino = Color(0xFFF57C00);
  static const entregado = Color(0xFF2E7D32);
  static const incidencia = Color(0xFFC62828);

  // UI general
  static const background = Color(0xFFF0F4FF);
  static const surface = Colors.white;
  static const error = Color(0xFFD32F2F);
  static const success = Color(0xFF388E3C);
  static const warning = Color(0xFFF57C00);

  static const textPrimary = Color(0xFF1A1A2E);
  static const textSecondary = Color(0xFF6B7280);
  static const textHint = Color(0xFF9CA3AF);

  static const divider = Color(0xFFE5E7EB);
  static const cardShadow = Color(0x14000000);

  static const LinearGradient primaryGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0D47A1), Color(0xFF1E88E5)],
  );

  static Color estadoColor(String estado) {
    switch (estado) {
      case 'asignado':
        return asignado;
      case 'en_camino':
        return enCamino;
      case 'entregado':
        return entregado;
      case 'incidencia':
        return incidencia;
      default:
        return textSecondary;
    }
  }
}
