import '../../core/constants/sync_estado.dart';

class Producto {
  const Producto({
    required this.id,
    required this.nombre,
    this.descripcion,
    this.sku,
    this.plu,
    this.codigoBarras,
    this.categoriaId,
    this.marca,
    this.unidadMedida = 'unidad',
    this.esPaquete = false,
    this.contenidoPaquete,
    this.precioCompra = 0,
    required this.precioVenta,
    this.precioMinimo,
    this.tasaItbis = 0.18,
    this.itbisIncluido = true,
    this.imagenPath,
    this.stockMinimo = 0,
    this.proveedorId,
    this.activo = true,
    this.favorito = false,
    this.esCompuesto = false,
    this.tieneVariantes = false,
    this.tieneLotes = false,
    this.ubicacion,
    required this.empresaId,
    this.sucursalId,
    this.dispositivoId,
    required this.creadoEn,
    required this.actualizadoEn,
    this.version = 1,
    this.syncEstado = SyncEstado.pendiente,
    this.sincronizadoEn,
    this.remotoId,
    this.eliminado = false,
  });

  final String id;
  final String nombre;
  final String? descripcion;
  final String? sku;
  final String? plu;
  final String? codigoBarras;
  final String? categoriaId;
  final String? marca;
  final String unidadMedida;
  final bool esPaquete;
  final double? contenidoPaquete;
  final double precioCompra;
  final double precioVenta;
  final double? precioMinimo;
  final double tasaItbis;
  final bool itbisIncluido;
  final String? imagenPath;
  final double stockMinimo;
  final String? proveedorId;
  final bool activo;
  final bool favorito;
  final bool esCompuesto;
  final bool tieneVariantes;
  final bool tieneLotes;
  final String? ubicacion;
  final String empresaId;
  final String? sucursalId;
  final String? dispositivoId;
  final DateTime creadoEn;
  final DateTime actualizadoEn;
  final int version;
  final SyncEstado syncEstado;
  final DateTime? sincronizadoEn;
  final String? remotoId;
  final bool eliminado;

  /// Precio unitario sin ITBIS, para calculos de venta cuando el precio
  /// guardado ya lo incluye (comportamiento tipico de colmado/retail RD).
  double get precioSinItbis => itbisIncluido ? precioVenta / (1 + tasaItbis) : precioVenta;

  double get montoItbisUnitario => itbisIncluido ? precioVenta - precioSinItbis : precioVenta * tasaItbis;

  Producto copyWith({
    String? nombre, String? descripcion, String? sku, String? plu, String? codigoBarras,
    String? categoriaId, String? marca, String? unidadMedida, bool? esPaquete,
    double? contenidoPaquete, double? precioCompra, double? precioVenta, double? precioMinimo,
    double? tasaItbis, bool? itbisIncluido, String? imagenPath, double? stockMinimo,
    String? proveedorId, bool? activo, bool? favorito, bool? esCompuesto, bool? tieneVariantes,
    bool? tieneLotes, String? ubicacion,
  }) {
    return Producto(
      id: id, empresaId: empresaId, sucursalId: sucursalId, dispositivoId: dispositivoId,
      nombre: nombre ?? this.nombre, descripcion: descripcion ?? this.descripcion,
      sku: sku ?? this.sku, plu: plu ?? this.plu, codigoBarras: codigoBarras ?? this.codigoBarras,
      categoriaId: categoriaId ?? this.categoriaId, marca: marca ?? this.marca,
      unidadMedida: unidadMedida ?? this.unidadMedida, esPaquete: esPaquete ?? this.esPaquete,
      contenidoPaquete: contenidoPaquete ?? this.contenidoPaquete,
      precioCompra: precioCompra ?? this.precioCompra, precioVenta: precioVenta ?? this.precioVenta,
      precioMinimo: precioMinimo ?? this.precioMinimo, tasaItbis: tasaItbis ?? this.tasaItbis,
      itbisIncluido: itbisIncluido ?? this.itbisIncluido, imagenPath: imagenPath ?? this.imagenPath,
      stockMinimo: stockMinimo ?? this.stockMinimo, proveedorId: proveedorId ?? this.proveedorId,
      activo: activo ?? this.activo, favorito: favorito ?? this.favorito,
      esCompuesto: esCompuesto ?? this.esCompuesto, tieneVariantes: tieneVariantes ?? this.tieneVariantes,
      tieneLotes: tieneLotes ?? this.tieneLotes, ubicacion: ubicacion ?? this.ubicacion,
      creadoEn: creadoEn, actualizadoEn: DateTime.now(), version: version + 1,
      syncEstado: SyncEstado.pendiente, sincronizadoEn: sincronizadoEn, remotoId: remotoId,
      eliminado: eliminado,
    );
  }

  Map<String, Object?> toMap() => {
        'id': id, 'nombre': nombre, 'descripcion': descripcion, 'sku': sku, 'plu': plu,
        'codigo_barras': codigoBarras, 'categoria_id': categoriaId, 'marca': marca,
        'unidad_medida': unidadMedida, 'es_paquete': esPaquete ? 1 : 0,
        'contenido_paquete': contenidoPaquete, 'precio_compra': precioCompra,
        'precio_venta': precioVenta, 'precio_minimo': precioMinimo, 'tasa_itbis': tasaItbis,
        'itbis_incluido': itbisIncluido ? 1 : 0, 'imagen_path': imagenPath,
        'stock_minimo': stockMinimo, 'proveedor_id': proveedorId, 'activo': activo ? 1 : 0,
        'favorito': favorito ? 1 : 0, 'es_compuesto': esCompuesto ? 1 : 0,
        'tiene_variantes': tieneVariantes ? 1 : 0, 'tiene_lotes': tieneLotes ? 1 : 0,
        'ubicacion': ubicacion, 'empresa_id': empresaId, 'sucursal_id': sucursalId,
        'dispositivo_id': dispositivoId,
        'creado_en': creadoEn.toIso8601String(), 'actualizado_en': actualizadoEn.toIso8601String(),
        'version': version, 'sync_estado': syncEstado.name,
        'sincronizado_en': sincronizadoEn?.toIso8601String(), 'remoto_id': remotoId,
        'eliminado': eliminado ? 1 : 0,
      };

  factory Producto.fromMap(Map<String, Object?> map) => Producto(
        id: map['id'] as String,
        nombre: map['nombre'] as String,
        descripcion: map['descripcion'] as String?,
        sku: map['sku'] as String?,
        plu: map['plu'] as String?,
        codigoBarras: map['codigo_barras'] as String?,
        categoriaId: map['categoria_id'] as String?,
        marca: map['marca'] as String?,
        unidadMedida: map['unidad_medida'] as String? ?? 'unidad',
        esPaquete: (map['es_paquete'] as int? ?? 0) == 1,
        contenidoPaquete: (map['contenido_paquete'] as num?)?.toDouble(),
        precioCompra: (map['precio_compra'] as num?)?.toDouble() ?? 0,
        precioVenta: (map['precio_venta'] as num?)?.toDouble() ?? 0,
        precioMinimo: (map['precio_minimo'] as num?)?.toDouble(),
        tasaItbis: (map['tasa_itbis'] as num?)?.toDouble() ?? 0.18,
        itbisIncluido: (map['itbis_incluido'] as int? ?? 1) == 1,
        imagenPath: map['imagen_path'] as String?,
        stockMinimo: (map['stock_minimo'] as num?)?.toDouble() ?? 0,
        proveedorId: map['proveedor_id'] as String?,
        activo: (map['activo'] as int? ?? 1) == 1,
        favorito: (map['favorito'] as int? ?? 0) == 1,
        esCompuesto: (map['es_compuesto'] as int? ?? 0) == 1,
        tieneVariantes: (map['tiene_variantes'] as int? ?? 0) == 1,
        tieneLotes: (map['tiene_lotes'] as int? ?? 0) == 1,
        ubicacion: map['ubicacion'] as String?,
        empresaId: map['empresa_id'] as String,
        sucursalId: map['sucursal_id'] as String?,
        dispositivoId: map['dispositivo_id'] as String?,
        creadoEn: DateTime.parse(map['creado_en'] as String),
        actualizadoEn: DateTime.parse(map['actualizado_en'] as String),
        version: map['version'] as int? ?? 1,
        syncEstado: SyncEstadoX.desde(map['sync_estado'] as String?),
        sincronizadoEn: map['sincronizado_en'] != null ? DateTime.parse(map['sincronizado_en'] as String) : null,
        remotoId: map['remoto_id'] as String?,
        eliminado: (map['eliminado'] as int? ?? 0) == 1,
      );
}
