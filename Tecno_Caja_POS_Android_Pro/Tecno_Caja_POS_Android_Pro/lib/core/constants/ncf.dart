/// Tipos de NCF tradicionales de la DGII (República Dominicana). Espejo de
/// `js/ncf-config.js` en Tecno Caja Windows (`NCF_TYPE_LABELS`) para no
/// inventar otro vocabulario entre las dos apps.
///
/// Solo se listan aquí los tradicionales: los e-CF (E31, E32, E33, E34, E41,
/// E43, E44, E45) no se ofrecen todavía porque `requestNcf` los rechaza sin
/// `eCfValidado` (firma digital real, pendiente en una fase posterior).
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
