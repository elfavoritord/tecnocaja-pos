import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class NovaposApiSettingsService {
  NovaposApiSettingsService._();

  static final NovaposApiSettingsService instance =
      NovaposApiSettingsService._();

  static const String _prefsKey = 'novapos_api_base_url';
  static const String _envBaseUrl = String.fromEnvironment(
    'NOVAPOS_API_BASE_URL',
  );
  static const String _hostedWebBaseUrl = String.fromEnvironment(
    'NOVAPOS_HOSTED_WEB_API_URL',
  );

  Future<String> getBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_prefsKey) ?? '';
    return _normalizeUrl(stored.isNotEmpty ? stored : _defaultBaseUrl);
  }

  Future<void> setBaseUrl(String value) async {
    final prefs = await SharedPreferences.getInstance();
    final normalized = _normalizeUrl(value);
    await prefs.setString(_prefsKey, normalized);
  }

  Future<void> resetBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_prefsKey);
  }

  String get defaultBaseUrl => _defaultBaseUrl;

  String get _defaultBaseUrl {
    if (_envBaseUrl.isNotEmpty) {
      return _normalizeUrl(_envBaseUrl);
    }

    if (kIsWeb && !_isLocalWebHost && _hostedWebBaseUrl.trim().isNotEmpty) {
      return _normalizeUrl(_hostedWebBaseUrl);
    }

    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:3399';
    }

    return 'http://127.0.0.1:3399';
  }

  bool get _isLocalWebHost {
    if (!kIsWeb) {
      return false;
    }

    final host = Uri.base.host.trim().toLowerCase();
    return host == 'localhost' || host == '127.0.0.1';
  }

  String _normalizeUrl(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return _defaultBaseUrl;
    }

    final withScheme =
        trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : 'http://$trimmed';

    return withScheme.replaceFirst(RegExp(r'/+$'), '');
  }
}
