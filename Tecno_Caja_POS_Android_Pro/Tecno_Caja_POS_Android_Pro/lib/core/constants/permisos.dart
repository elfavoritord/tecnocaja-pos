/// Permisos individuales otorgables a un usuario, mas alla de su rol base.
/// La UI debe ocultar o bloquear (no solo deshabilitar) cualquier accion
/// cuyo permiso no este presente en `Usuario.permisosEfectivos`.
enum Permiso {
  verCostos,
  verGanancias,
  cambiarPrecios,
  aplicarDescuentos,
  anularVentas,
  reimprimir,
  abrirCaja,
  cerrarCaja,
  crearProductos,
  editarProductos,
  ajustarInventario,
  verReportes,
  exportarDatos,
  administrarUsuarios,
  configurarSucursal,
  accederECF,
  verOtrasSucursales,
}

extension PermisoLabel on Permiso {
  String get etiqueta => switch (this) {
        Permiso.verCostos => 'Ver costos',
        Permiso.verGanancias => 'Ver ganancias',
        Permiso.cambiarPrecios => 'Cambiar precios',
        Permiso.aplicarDescuentos => 'Aplicar descuentos',
        Permiso.anularVentas => 'Anular ventas',
        Permiso.reimprimir => 'Reimprimir',
        Permiso.abrirCaja => 'Abrir caja',
        Permiso.cerrarCaja => 'Cerrar caja',
        Permiso.crearProductos => 'Crear productos',
        Permiso.editarProductos => 'Editar productos',
        Permiso.ajustarInventario => 'Ajustar inventario',
        Permiso.verReportes => 'Ver reportes',
        Permiso.exportarDatos => 'Exportar',
        Permiso.administrarUsuarios => 'Administrar usuarios',
        Permiso.configurarSucursal => 'Configurar sucursal',
        Permiso.accederECF => 'Acceder a e-CF',
        Permiso.verOtrasSucursales => 'Ver otras sucursales',
      };
}
