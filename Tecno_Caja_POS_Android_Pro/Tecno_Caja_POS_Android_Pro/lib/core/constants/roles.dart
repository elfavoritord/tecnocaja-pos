import 'permisos.dart';

enum RolBase {
  administradorGeneral,
  administradorSucursal,
  supervisor,
  cajero,
  delivery,
  contador,
}

extension RolBaseLabel on RolBase {
  String get etiqueta => switch (this) {
        RolBase.administradorGeneral => 'Administrador general',
        RolBase.administradorSucursal => 'Administrador de sucursal',
        RolBase.supervisor => 'Supervisor',
        RolBase.cajero => 'Cajero',
        RolBase.delivery => 'Delivery',
        RolBase.contador => 'Contador',
      };

  /// Permisos por defecto al asignar el rol. Un usuario puede recibir
  /// permisos individuales adicionales encima de este set base (ver
  /// Usuario.permisosExtra / permisosRevocados en el dominio).
  Set<Permiso> get permisosPorDefecto => switch (this) {
        RolBase.administradorGeneral => Permiso.values.toSet(),
        RolBase.administradorSucursal => {
            Permiso.verCostos,
            Permiso.verGanancias,
            Permiso.cambiarPrecios,
            Permiso.aplicarDescuentos,
            Permiso.anularVentas,
            Permiso.reimprimir,
            Permiso.abrirCaja,
            Permiso.cerrarCaja,
            Permiso.crearProductos,
            Permiso.editarProductos,
            Permiso.ajustarInventario,
            Permiso.verReportes,
            Permiso.exportarDatos,
            Permiso.configurarSucursal,
            Permiso.accederECF,
          },
        RolBase.supervisor => {
            Permiso.aplicarDescuentos,
            Permiso.anularVentas,
            Permiso.reimprimir,
            Permiso.abrirCaja,
            Permiso.cerrarCaja,
            Permiso.editarProductos,
            Permiso.ajustarInventario,
            Permiso.verReportes,
          },
        RolBase.cajero => {
            Permiso.reimprimir,
            Permiso.abrirCaja,
            Permiso.cerrarCaja,
          },
        RolBase.delivery => <Permiso>{},
        RolBase.contador => {
            Permiso.verCostos,
            Permiso.verGanancias,
            Permiso.verReportes,
            Permiso.exportarDatos,
            Permiso.accederECF,
          },
      };
}
