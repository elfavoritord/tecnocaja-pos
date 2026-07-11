import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

// ── Tema ──────────────────────────────────────────────────────────────────
final themeProvider = StateNotifierProvider<ThemeNotifier, ThemeMode>((ref) => ThemeNotifier());

class ThemeNotifier extends StateNotifier<ThemeMode> {
  ThemeNotifier() : super(ThemeMode.system) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final val = prefs.getString('theme_mode') ?? 'system';
    state = _parse(val);
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('theme_mode', _serialize(mode));
  }

  ThemeMode _parse(String s) {
    switch (s) {
      case 'light': return ThemeMode.light;
      case 'dark': return ThemeMode.dark;
      default: return ThemeMode.system;
    }
  }

  String _serialize(ThemeMode m) {
    switch (m) {
      case ThemeMode.light: return 'light';
      case ThemeMode.dark: return 'dark';
      default: return 'system';
    }
  }
}

// ── Notificaciones ────────────────────────────────────────────────────────
final notifEnabledProvider = StateNotifierProvider<NotifNotifier, bool>((ref) => NotifNotifier());

class NotifNotifier extends StateNotifier<bool> {
  NotifNotifier() : super(true) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    state = prefs.getBool('notif_enabled') ?? true;
  }

  Future<void> toggle() async {
    state = !state;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('notif_enabled', state);
  }
}

// ── Biometría ─────────────────────────────────────────────────────────────
final biometricsEnabledProvider = StateNotifierProvider<BiometricsNotifier, bool>((ref) => BiometricsNotifier());

class BiometricsNotifier extends StateNotifier<bool> {
  BiometricsNotifier() : super(false) {
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    state = prefs.getBool('biometrics_enabled') ?? false;
  }

  Future<void> toggle() async {
    state = !state;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('biometrics_enabled', state);
  }
}
