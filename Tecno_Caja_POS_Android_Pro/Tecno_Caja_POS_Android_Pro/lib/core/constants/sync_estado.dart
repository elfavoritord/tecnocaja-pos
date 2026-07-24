enum SyncEstado { pendiente, sincronizado, error, conflicto }

extension SyncEstadoX on SyncEstado {
  static SyncEstado desde(String? value) {
    return SyncEstado.values.firstWhere(
      (e) => e.name == value,
      orElse: () => SyncEstado.pendiente,
    );
  }
}
