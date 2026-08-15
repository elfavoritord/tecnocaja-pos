import 'dart:convert';

/// Fila unica (id=1) con los ajustes del dispositivo/instalacion, incluido
/// el estado de vinculacion con Tecno Caja POS Windows.
class ConfiguracionApp {
  const ConfiguracionApp({
    this.empresaId,
    this.monedaSecundariaActiva = false,
    this.tasaCambioUsdDop,
    this.redondeoActivo = false,
    this.redondeoPaso = 1.0,
    this.itbisDefault = 0.18,
    this.prefijoFactura,
    this.secuenciaFacturaActual = 1,
    this.periodoGraciaOfflineDias = 7,
    this.tema = 'sistema',
    this.impresoraPredeterminadaMac,
    this.impresoraAnchoMm = 58,
    this.imprimirAutomatico = false,
    this.sonidoScanner = true,
    this.vibrarScanner = true,
    this.windowsVinculado = false,
    this.windowsModoConexion = 'nube',
    this.windowsUrlLan,
    this.windowsCodigoDispositivo,
    this.windowsNombreDispositivo,
    this.windowsVinculadoEn,
    this.fiscalUsaComprobantes = false,
    this.fiscalModoComprobante,
    this.fiscalAmbiente = 'certificacion',
    this.sucursalSeleccionadaId,
    this.cajaSeleccionadaId,
    this.businessType,
    this.businessCapabilities = const {},
    required this.actualizadoEn,
  });

  final String? empresaId;
  final bool monedaSecundariaActiva;
  final double? tasaCambioUsdDop;
  final bool redondeoActivo;
  final double redondeoPaso;
  final double itbisDefault;
  final String? prefijoFactura;
  final int secuenciaFacturaActual;
  final int periodoGraciaOfflineDias;
  final String tema;
  final String? impresoraPredeterminadaMac;
  final int impresoraAnchoMm;
  final bool imprimirAutomatico;
  final bool sonidoScanner;
  final bool vibrarScanner;
  final bool windowsVinculado;
  final String windowsModoConexion;
  final String? windowsUrlLan;
  final String? windowsCodigoDispositivo;
  final String? windowsNombreDispositivo;
  final DateTime? windowsVinculadoEn;
  final bool fiscalUsaComprobantes;
  final String? fiscalModoComprobante;
  final String fiscalAmbiente;
  final String? sucursalSeleccionadaId;
  final String? cajaSeleccionadaId;
  final String? businessType;
  final Set<String> businessCapabilities;
  final DateTime actualizadoEn;

  static ConfiguracionApp inicial() =>
      ConfiguracionApp(actualizadoEn: DateTime.now());

  ConfiguracionApp copyWith({
    String? empresaId,
    bool? monedaSecundariaActiva,
    double? tasaCambioUsdDop,
    bool? redondeoActivo,
    double? redondeoPaso,
    double? itbisDefault,
    String? prefijoFactura,
    int? secuenciaFacturaActual,
    int? periodoGraciaOfflineDias,
    String? tema,
    String? impresoraPredeterminadaMac,
    int? impresoraAnchoMm,
    bool? imprimirAutomatico,
    bool? sonidoScanner,
    bool? vibrarScanner,
    bool? windowsVinculado,
    String? windowsModoConexion,
    String? windowsUrlLan,
    String? windowsCodigoDispositivo,
    String? windowsNombreDispositivo,
    DateTime? windowsVinculadoEn,
    bool? fiscalUsaComprobantes,
    String? fiscalModoComprobante,
    String? fiscalAmbiente,
    String? businessType,
    Set<String>? businessCapabilities,
  }) {
    return ConfiguracionApp(
      empresaId: empresaId ?? this.empresaId,
      monedaSecundariaActiva:
          monedaSecundariaActiva ?? this.monedaSecundariaActiva,
      tasaCambioUsdDop: tasaCambioUsdDop ?? this.tasaCambioUsdDop,
      redondeoActivo: redondeoActivo ?? this.redondeoActivo,
      redondeoPaso: redondeoPaso ?? this.redondeoPaso,
      itbisDefault: itbisDefault ?? this.itbisDefault,
      prefijoFactura: prefijoFactura ?? this.prefijoFactura,
      secuenciaFacturaActual:
          secuenciaFacturaActual ?? this.secuenciaFacturaActual,
      periodoGraciaOfflineDias:
          periodoGraciaOfflineDias ?? this.periodoGraciaOfflineDias,
      tema: tema ?? this.tema,
      impresoraPredeterminadaMac:
          impresoraPredeterminadaMac ?? this.impresoraPredeterminadaMac,
      impresoraAnchoMm: impresoraAnchoMm ?? this.impresoraAnchoMm,
      imprimirAutomatico: imprimirAutomatico ?? this.imprimirAutomatico,
      sonidoScanner: sonidoScanner ?? this.sonidoScanner,
      vibrarScanner: vibrarScanner ?? this.vibrarScanner,
      windowsVinculado: windowsVinculado ?? this.windowsVinculado,
      windowsModoConexion: windowsModoConexion ?? this.windowsModoConexion,
      windowsUrlLan: windowsUrlLan ?? this.windowsUrlLan,
      windowsCodigoDispositivo:
          windowsCodigoDispositivo ?? this.windowsCodigoDispositivo,
      windowsNombreDispositivo:
          windowsNombreDispositivo ?? this.windowsNombreDispositivo,
      windowsVinculadoEn: windowsVinculadoEn ?? this.windowsVinculadoEn,
      fiscalUsaComprobantes:
          fiscalUsaComprobantes ?? this.fiscalUsaComprobantes,
      fiscalModoComprobante:
          fiscalModoComprobante ?? this.fiscalModoComprobante,
      fiscalAmbiente: fiscalAmbiente ?? this.fiscalAmbiente,
      businessType: businessType ?? this.businessType,
      businessCapabilities: businessCapabilities ?? this.businessCapabilities,
      actualizadoEn: DateTime.now(),
    );
  }

  Map<String, Object?> toMap() => {
        'id': 1,
        'empresa_id': empresaId,
        'moneda_secundaria_activa': monedaSecundariaActiva ? 1 : 0,
        'tasa_cambio_usd_dop': tasaCambioUsdDop,
        'redondeo_activo': redondeoActivo ? 1 : 0,
        'redondeo_paso': redondeoPaso,
        'itbis_default': itbisDefault,
        'prefijo_factura': prefijoFactura,
        'secuencia_factura_actual': secuenciaFacturaActual,
        'periodo_gracia_offline_dias': periodoGraciaOfflineDias,
        'tema': tema,
        'impresora_predeterminada_mac': impresoraPredeterminadaMac,
        'impresora_ancho_mm': impresoraAnchoMm,
        'imprimir_automatico': imprimirAutomatico ? 1 : 0,
        'sonido_scanner': sonidoScanner ? 1 : 0,
        'vibrar_scanner': vibrarScanner ? 1 : 0,
        'windows_vinculado': windowsVinculado ? 1 : 0,
        'windows_modo_conexion': windowsModoConexion,
        'windows_url_lan': windowsUrlLan,
        'windows_codigo_dispositivo': windowsCodigoDispositivo,
        'windows_nombre_dispositivo': windowsNombreDispositivo,
        'windows_vinculado_en': windowsVinculadoEn?.toIso8601String(),
        'fiscal_usa_comprobantes': fiscalUsaComprobantes ? 1 : 0,
        'fiscal_modo_comprobante': fiscalModoComprobante,
        'fiscal_ambiente': fiscalAmbiente,
        'business_type': businessType,
        'business_capabilities_json':
            jsonEncode(businessCapabilities.toList()..sort()),
        'actualizado_en': actualizadoEn.toIso8601String(),
      };

  factory ConfiguracionApp.fromMap(Map<String, Object?> map) =>
      ConfiguracionApp(
        empresaId: map['empresa_id'] as String?,
        monedaSecundariaActiva:
            (map['moneda_secundaria_activa'] as int? ?? 0) == 1,
        tasaCambioUsdDop: (map['tasa_cambio_usd_dop'] as num?)?.toDouble(),
        redondeoActivo: (map['redondeo_activo'] as int? ?? 0) == 1,
        redondeoPaso: (map['redondeo_paso'] as num?)?.toDouble() ?? 1.0,
        itbisDefault: (map['itbis_default'] as num?)?.toDouble() ?? 0.18,
        prefijoFactura: map['prefijo_factura'] as String?,
        secuenciaFacturaActual: map['secuencia_factura_actual'] as int? ?? 1,
        periodoGraciaOfflineDias:
            map['periodo_gracia_offline_dias'] as int? ?? 7,
        tema: map['tema'] as String? ?? 'sistema',
        impresoraPredeterminadaMac:
            map['impresora_predeterminada_mac'] as String?,
        impresoraAnchoMm: map['impresora_ancho_mm'] as int? ?? 58,
        imprimirAutomatico: (map['imprimir_automatico'] as int? ?? 0) == 1,
        sonidoScanner: (map['sonido_scanner'] as int? ?? 1) == 1,
        vibrarScanner: (map['vibrar_scanner'] as int? ?? 1) == 1,
        windowsVinculado: (map['windows_vinculado'] as int? ?? 0) == 1,
        windowsModoConexion: map['windows_modo_conexion'] as String? ?? 'nube',
        windowsUrlLan: map['windows_url_lan'] as String?,
        windowsCodigoDispositivo: map['windows_codigo_dispositivo'] as String?,
        windowsNombreDispositivo: map['windows_nombre_dispositivo'] as String?,
        windowsVinculadoEn: map['windows_vinculado_en'] != null
            ? DateTime.parse(map['windows_vinculado_en'] as String)
            : null,
        fiscalUsaComprobantes:
            (map['fiscal_usa_comprobantes'] as int? ?? 0) == 1,
        fiscalModoComprobante: map['fiscal_modo_comprobante'] as String?,
        fiscalAmbiente: map['fiscal_ambiente'] as String? ?? 'certificacion',
        businessType: map['business_type'] as String?,
        businessCapabilities:
            _decodeCapabilities(map['business_capabilities_json']),
        actualizadoEn: DateTime.parse(map['actualizado_en'] as String),
      );

  static Set<String> _decodeCapabilities(Object? value) {
    if (value == null || value.toString().trim().isEmpty) return {};
    try {
      final decoded = jsonDecode(value.toString());
      if (decoded is! List) return {};
      return decoded.map((item) => item.toString()).toSet();
    } catch (_) {
      return {};
    }
  }
}
