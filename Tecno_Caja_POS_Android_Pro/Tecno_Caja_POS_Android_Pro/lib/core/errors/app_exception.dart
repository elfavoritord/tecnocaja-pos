/// Jerarquia de errores de la app. Los repositorios y servicios lanzan estas
/// excepciones tipadas para que la capa de presentacion pueda mostrar
/// mensajes claros sin depender del tipo de excepcion nativa (DioException,
/// DatabaseException, etc.) que las origino.
sealed class AppException implements Exception {
  const AppException({required this.message, this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => message;
}

class NetworkException extends AppException {
  const NetworkException({super.message = 'No hay conexion a internet.', super.cause});
}

class ServerException extends AppException {
  const ServerException({required super.message, this.statusCode, super.cause});
  final int? statusCode;
}

class UnauthorizedException extends AppException {
  const UnauthorizedException({super.message = 'Sesion invalida o expirada.', super.cause});
}

class ForbiddenException extends AppException {
  const ForbiddenException({super.message = 'No tienes permiso para realizar esta accion.', super.cause});
}

class ValidationException extends AppException {
  const ValidationException({required super.message, this.fieldErrors = const {}, super.cause});
  final Map<String, String> fieldErrors;
}

class NotFoundException extends AppException {
  const NotFoundException({super.message = 'No se encontro el registro.', super.cause});
}

class ConflictException extends AppException {
  const ConflictException({required super.message, super.cause});
}

class DatabaseFailure extends AppException {
  const DatabaseFailure({required super.message, super.cause});
}

class PrinterException extends AppException {
  const PrinterException({super.message = 'No se pudo conectar con la impresora.', super.cause});
}

class InsufficientStockException extends AppException {
  InsufficientStockException(this.productName, this.available)
      : super(message: 'Stock insuficiente para "$productName" (disponible: $available)');
  final String productName;
  final double available;
}

class LicenseExpiredException extends AppException {
  const LicenseExpiredException({super.message = 'La licencia ha vencido.', super.cause});
}

class DeviceRevokedException extends AppException {
  const DeviceRevokedException({super.message = 'Este dispositivo fue revocado por el administrador.', super.cause});
}

class UnknownAppException extends AppException {
  const UnknownAppException({super.message = 'Ocurrio un error inesperado.', super.cause});
}
