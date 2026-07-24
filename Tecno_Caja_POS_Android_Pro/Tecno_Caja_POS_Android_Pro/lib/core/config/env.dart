/// Configuracion inyectada en tiempo de compilacion via
/// `flutter run --dart-define-from-file=env.json` (copiar de `env.example.json`).
///
/// Todos los valores tienen un default de desarrollo razonable para que
/// `flutter run` funcione sin configuracion adicional. En produccion SIEMPRE
/// se debe pasar env.json real -- ver docs/BUILD_RELEASE.md.
class Env {
  const Env._();

  /// API de sincronizacion en la nube (rutas nuevas dentro del server.js
  /// existente de Tecno Caja POS Windows, expuestas via Cloudflare Tunnel).
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://api.tecnocaja.app',
  );

  /// URL directa al POS Windows en la misma red local (vinculacion LAN).
  /// Vacio por defecto: se completa por dispositivo durante "Vincular con Windows".
  static const String apiBaseUrlLan = String.fromEnvironment(
    'API_BASE_URL_LAN',
    defaultValue: '',
  );

  static const String environment = String.fromEnvironment(
    'ENVIRONMENT',
    defaultValue: 'development',
  );

  static const String tecnoCajaIdIssuer = String.fromEnvironment(
    'TECNO_CAJA_ID_ISSUER',
    defaultValue: 'tecnocaja.app',
  );

  /// "Web client ID" del proyecto Firebase (Firebase Console > Authentication
  /// > Sign-in method > Google > Configuracion web SDK). Google Sign-In en
  /// Android lo necesita como `serverClientId` para que el idToken resultante
  /// tenga la audiencia correcta y Firebase pueda validarlo. Vacio hasta que
  /// Emilio configure el proyecto real -- ver docs/FIREBASE_SETUP.md.
  static const String googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');

  static bool get isProduction => environment == 'production';

  static bool get isDevelopment => !isProduction;
}
