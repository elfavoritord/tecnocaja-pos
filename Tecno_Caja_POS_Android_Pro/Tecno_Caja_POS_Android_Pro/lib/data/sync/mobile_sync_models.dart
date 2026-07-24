import '../../core/constants/roles.dart';

/// Respuesta completa de POST /api/mobile-auth/login -- ver
/// server/routes/mobile-auth.routes.js. Vive aparte de las entidades locales
/// porque describe la forma remota (ids INT como String, sin UUID) antes de
/// mapearse a Empresa/Sucursal/Caja/Usuario locales.
class MobileLinkPayload {
  const MobileLinkPayload({
    required this.accessToken,
    required this.refreshToken,
    required this.accessExpiresAt,
    required this.refreshExpiresAt,
    required this.usuario,
    required this.negocio,
  });

  final String accessToken;
  final String refreshToken;
  final DateTime accessExpiresAt;
  final DateTime refreshExpiresAt;
  final RemoteUsuario usuario;
  final RemoteNegocio negocio;

  factory MobileLinkPayload.fromJson(Map<String, dynamic> json) => MobileLinkPayload(
        accessToken: json['accessToken'] as String,
        refreshToken: json['refreshToken'] as String,
        accessExpiresAt: DateTime.parse(json['accessExpiresAt'] as String),
        refreshExpiresAt: DateTime.parse(json['refreshExpiresAt'] as String),
        usuario: RemoteUsuario.fromJson(json['usuario'] as Map<String, dynamic>),
        negocio: RemoteNegocio.fromJson(json['negocio'] as Map<String, dynamic>),
      );
}

class RemoteUsuario {
  const RemoteUsuario({
    required this.id,
    required this.nombre,
    required this.usuario,
    this.email,
    this.telefono,
    required this.rol,
    this.sucursalId,
    this.cajaId,
    this.firebaseUid,
  });

  final String id;
  final String nombre;
  final String usuario;
  final String? email;
  final String? telefono;
  final RolBase rol;
  final String? sucursalId;
  final String? cajaId;

  /// Null cuando la sesion se abrio por usuario/contraseña locales
  /// (POST /login-local) y esa cuenta de Windows nunca se ha vinculado con
  /// Google -- ver mobile-auth.routes.js.
  final String? firebaseUid;

  factory RemoteUsuario.fromJson(Map<String, dynamic> json) => RemoteUsuario(
        id: json['id'] as String,
        nombre: json['nombre'] as String,
        usuario: json['usuario'] as String,
        email: json['email'] as String?,
        telefono: json['telefono'] as String?,
        rol: RolBase.values.firstWhere((r) => r.name == json['rol'], orElse: () => RolBase.cajero),
        sucursalId: json['sucursalId'] as String?,
        cajaId: json['cajaId'] as String?,
        firebaseUid: json['firebaseUid'] as String?,
      );
}

class RemoteNegocio {
  const RemoteNegocio({
    required this.nombre,
    this.rnc,
    this.direccion,
    this.telefono,
    required this.moneda,
    required this.tasaItbis,
    required this.sucursales,
    required this.cajas,
  });

  final String nombre;
  final String? rnc;
  final String? direccion;
  final String? telefono;
  final String moneda;
  final double tasaItbis;
  final List<RemoteSucursal> sucursales;
  final List<RemoteCaja> cajas;

  factory RemoteNegocio.fromJson(Map<String, dynamic> json) => RemoteNegocio(
        nombre: json['nombre'] as String,
        rnc: json['rnc'] as String?,
        direccion: json['direccion'] as String?,
        telefono: json['telefono'] as String?,
        moneda: json['moneda'] as String? ?? 'DOP',
        tasaItbis: (json['tasaItbis'] as num?)?.toDouble() ?? 0.18,
        sucursales: ((json['sucursales'] as List?) ?? [])
            .map((e) => RemoteSucursal.fromJson(e as Map<String, dynamic>))
            .toList(),
        cajas: ((json['cajas'] as List?) ?? []).map((e) => RemoteCaja.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class RemoteSucursal {
  const RemoteSucursal({required this.id, required this.nombre, this.codigo, this.direccion, this.telefono});

  final String id;
  final String nombre;
  final String? codigo;
  final String? direccion;
  final String? telefono;

  factory RemoteSucursal.fromJson(Map<String, dynamic> json) => RemoteSucursal(
        id: json['id'] as String,
        nombre: json['nombre'] as String,
        codigo: json['codigo'] as String?,
        direccion: json['direccion'] as String?,
        telefono: json['telefono'] as String?,
      );
}

class RemoteCaja {
  const RemoteCaja({required this.id, required this.sucursalId, required this.nombre, this.codigo});

  final String id;
  final String sucursalId;
  final String nombre;
  final String? codigo;

  factory RemoteCaja.fromJson(Map<String, dynamic> json) => RemoteCaja(
        id: json['id'] as String,
        sucursalId: json['sucursalId'] as String,
        nombre: json['nombre'] as String,
        codigo: json['codigo'] as String?,
      );
}

/// Fila de GET /api/mobile-sync/productos -- ver server/routes/mobile-sync.routes.js.
class RemoteProducto {
  const RemoteProducto({
    required this.id,
    this.sku,
    required this.nombre,
    this.categoria,
    this.marca,
    required this.unidadMedida,
    required this.precioCompra,
    required this.precioVenta,
    required this.itbisIncluido,
    required this.tasaItbis,
    required this.stock,
    required this.stockMinimo,
  });

  final String id;
  final String? sku;
  final String nombre;
  final String? categoria;
  final String? marca;
  final String unidadMedida;
  final double precioCompra;
  final double precioVenta;
  final bool itbisIncluido;
  final double tasaItbis;
  final double stock;
  final double stockMinimo;

  factory RemoteProducto.fromJson(Map<String, dynamic> json) => RemoteProducto(
        id: json['id'] as String,
        sku: json['sku'] as String?,
        nombre: json['nombre'] as String,
        categoria: json['categoria'] as String?,
        marca: json['marca'] as String?,
        unidadMedida: json['unidadMedida'] as String? ?? 'Unidad',
        precioCompra: (json['precioCompra'] as num?)?.toDouble() ?? 0,
        precioVenta: (json['precioVenta'] as num?)?.toDouble() ?? 0,
        itbisIncluido: json['itbisIncluido'] as bool? ?? false,
        tasaItbis: (json['tasaItbis'] as num?)?.toDouble() ?? 0,
        stock: (json['stock'] as num?)?.toDouble() ?? 0,
        stockMinimo: (json['stockMinimo'] as num?)?.toDouble() ?? 0,
      );
}

/// Fila de GET /api/mobile-sync/clientes.
class RemoteCliente {
  const RemoteCliente({
    required this.id,
    required this.nombre,
    this.telefono,
    this.email,
    this.direccion,
    this.cedulaRnc,
    required this.limiteCredito,
    required this.balance,
  });

  final String id;
  final String nombre;
  final String? telefono;
  final String? email;
  final String? direccion;
  final String? cedulaRnc;
  final double limiteCredito;
  final double balance;

  factory RemoteCliente.fromJson(Map<String, dynamic> json) => RemoteCliente(
        id: json['id'] as String,
        nombre: json['nombre'] as String,
        telefono: json['telefono'] as String?,
        email: json['email'] as String?,
        direccion: json['direccion'] as String?,
        cedulaRnc: json['cedulaRnc'] as String?,
        limiteCredito: (json['limiteCredito'] as num?)?.toDouble() ?? 0,
        balance: (json['balance'] as num?)?.toDouble() ?? 0,
      );
}

/// Fila de GET /api/mobile-sync/proveedores.
class RemoteProveedor {
  const RemoteProveedor({
    required this.id,
    required this.nombre,
    this.empresaProveedora,
    this.telefono,
    this.email,
    this.rnc,
    this.contacto,
    this.direccion,
    this.diasVisita,
    this.terminosPagoDias,
  });

  final String id;
  final String nombre;
  final String? empresaProveedora;
  final String? telefono;
  final String? email;
  final String? rnc;
  final String? contacto;
  final String? direccion;
  final String? diasVisita;
  final int? terminosPagoDias;

  factory RemoteProveedor.fromJson(Map<String, dynamic> json) => RemoteProveedor(
        id: json['id'] as String,
        nombre: json['nombre'] as String,
        empresaProveedora: json['empresaProveedora'] as String?,
        telefono: json['telefono'] as String?,
        email: json['email'] as String?,
        rnc: json['rnc'] as String?,
        contacto: json['contacto'] as String?,
        direccion: json['direccion'] as String?,
        diasVisita: json['diasVisita'] as String?,
        terminosPagoDias: json['terminosPagoDias'] as int?,
      );
}
