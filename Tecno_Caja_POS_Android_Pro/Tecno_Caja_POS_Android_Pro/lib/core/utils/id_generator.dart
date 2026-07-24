import 'package:uuid/uuid.dart';

/// Genera identificadores unicos para todos los registros locales.
/// Cada entidad usa UUID v4 como PK desde el momento de creacion offline,
/// para poder sincronizar sin colisiones entre dispositivos.
class IdGenerator {
  IdGenerator._();

  static const Uuid _uuid = Uuid();

  static String newId() => _uuid.v4();
}
