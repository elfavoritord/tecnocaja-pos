import 'package:flutter/material.dart';

/// Paleta de marca Tecno Caja. Verde primario #22C55E fijo (identidad),
/// el resto se adapta a modo claro/oscuro vía [AppColors.of].
class AppColors {
  const AppColors._();

  static const Color primary = Color(0xFF22C55E);
  static const Color primaryDark = Color(0xFF16A34A);
  static const Color primaryLight = Color(0xFF86EFAC);

  static const Color success = Color(0xFF22C55E);
  static const Color warning = Color(0xFFF59E0B);
  static const Color danger = Color(0xFFEF4444);
  static const Color info = Color(0xFF3B82F6);

  static const Color usd = Color(0xFF3B82F6);
  static const Color dop = Color(0xFF22C55E);

  // Superficies modo claro
  static const Color lightBackground = Color(0xFFF7F9F8);
  static const Color lightSurface = Color(0xFFFFFFFF);
  static const Color lightSurfaceAlt = Color(0xFFF0F2F1);
  static const Color lightBorder = Color(0xFFE2E8F0);
  static const Color lightTextPrimary = Color(0xFF0F172A);
  static const Color lightTextSecondary = Color(0xFF64748B);

  // Superficies modo oscuro
  static const Color darkBackground = Color(0xFF0B1220);
  static const Color darkSurface = Color(0xFF111A2B);
  static const Color darkSurfaceAlt = Color(0xFF17223A);
  static const Color darkBorder = Color(0xFF243044);
  static const Color darkTextPrimary = Color(0xFFF1F5F9);
  static const Color darkTextSecondary = Color(0xFF94A3B8);
}
