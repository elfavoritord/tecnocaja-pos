/// Tipos de NCF tradicionales de la DGII (República Dominicana). Espejo de
/// `js/ncf-config.js` en Tecno Caja Windows (`NCF_TYPE_LABELS`) para no
/// inventar otro vocabulario entre las dos apps.
class NcfType {
  NcfType._();

  static const b01 = 'B01';
  static const b02 = 'B02';
  static const b14 = 'B14';
  static const b15 = 'B15';
  static const b16 = 'B16';
  static const b17 = 'B17';

  static const Map<String, String> etiquetas = {
    b01: 'Crédito Fiscal',
    b02: 'Consumidor Final',
    b14: 'Régimen Especial',
    b15: 'Gubernamental',
    b16: 'Comprobante para Exportaciones',
    b17: 'Comprobante para Pagos al Exterior',
  };

  static String etiquetaDe(String tipo) => etiquetas[tipo] ?? tipo;
}

/// Tipos e-CF reales (firma digital + envío a DGII vía
/// `functions/sign-and-send.js`). Solo se ofrecen en la UI cuando
/// `FiscalSettings.eCfValidado` es true (certificación DGII completada) --
/// ver `fiscal_repository.dart`. Esta primera entrega solo soporta E31/E32
/// (`SUPPORTED_ECF_TYPES` en `functions/ecf/config.js`); el resto de tipos
/// e-CF (E33/E34/E41/E43-47) queda reservado por `requestNcf` pero
/// `signAndSend` los rechaza con un error claro.
class EcfType {
  EcfType._();

  static const e31 = 'E31';
  static const e32 = 'E32';

  static const Map<String, String> etiquetas = {
    e31: 'e-CF Crédito Fiscal',
    e32: 'e-CF Consumo',
  };

  static String etiquetaDe(String tipo) => etiquetas[tipo] ?? tipo;
}
