/* Formato 606 de la DGII (Compras de Bienes y Servicios, Norma General 07-2018
   y 05-2019): validación y archivo TXT. Lo usan el POS (servidor y pantalla) y el
   Portal de Contadores (copia con su `vendor-sync`): un solo lugar para las reglas.

   Fuente: «Instructivo Llenado y Remisión del Formato de Envío de Compras de Bienes
   y Servicios (606)», DGII, febrero 2026 (campos, códigos y reglas de cada casilla).
   El TXT sigue lo que genera la herramienta oficial: encabezado
   606|RNC|AAAAMM|cantidad, 23 campos por línea separados por «|», fechas AAAAMMDD,
   montos con punto decimal y nombre DGII_F_606_<RNC>_<AAAAMM>.TXT. La DGII
   recomienda pasar el archivo por su «Herramienta de Pre-validación» antes de
   enviarlo por la Oficina Virtual: descargarlo no es presentarlo.

   Cada registro (todos los montos sin impuestos donde aplica, en pesos):
     rncCedula, tipoBienesServicios (1-11), ncf, ncfModificado, fechaComprobante,
     fechaPago (AAAA-MM-DD o AAAAMMDD), montoServicios, montoBienes, itbisFacturado,
     itbisRetenido, itbisProporcionalidad, itbisCosto, itbisPercibido,
     tipoRetencionIsr (1-9), montoRetencionRenta, isrPercibido, isc,
     otrosImpuestos, propinaLegal, formaPago (1-7), origen (texto para mostrar). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Formato606 = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const TIPOS_BIENES = {
    1: 'Gastos de personal', 2: 'Gastos por trabajos, suministros y servicios', 3: 'Arrendamientos',
    4: 'Gastos de activos fijos', 5: 'Gastos de representación', 6: 'Otras deducciones admitidas',
    7: 'Gastos financieros', 8: 'Gastos extraordinarios', 9: 'Compras y gastos que formarán parte del costo de venta',
    10: 'Adquisiciones de activos', 11: 'Gastos de seguros',
  };
  const TIPOS_RETENCION_ISR = {
    1: 'Alquileres', 2: 'Honorarios por servicios', 3: 'Otras rentas', 4: 'Otras rentas (rentas presuntas)',
    5: 'Intereses pagados a personas jurídicas residentes', 6: 'Intereses pagados a personas físicas residentes',
    7: 'Retención por proveedores del Estado', 8: 'Juegos telefónicos', 9: 'Retenciones subsector de ganadería de carne bovina',
  };
  const FORMAS_PAGO = {
    1: 'Efectivo', 2: 'Cheques/Transferencias/Depósito', 3: 'Tarjeta crédito/débito', 4: 'Compra a crédito',
    5: 'Permuta', 6: 'Notas de crédito', 7: 'Mixto',
  };
  // Comprobantes que sustentan una compra o un gasto (los de consumo no van).
  const TIPOS_NCF = {
    B01: 'Crédito fiscal', B03: 'Nota de débito', B04: 'Nota de crédito', B11: 'Comprobante de compras',
    B13: 'Gastos menores', B14: 'Regímenes especiales', B15: 'Gubernamental', B17: 'Pagos al exterior',
    E31: 'Crédito fiscal electrónico', E33: 'Nota de débito electrónica', E34: 'Nota de crédito electrónica',
    E41: 'Compras electrónico', E43: 'Gastos menores electrónico', E44: 'Regímenes especiales electrónico',
    E45: 'Gubernamental electrónico', E47: 'Pagos al exterior electrónico',
  };
  const NOTAS = new Set(['B03', 'B04', 'E33', 'E34']);
  // Llevan el RNC de quien informa: no hay proveedor identificado en RD.
  const CON_RNC_PROPIO = new Set(['B13', 'E43', 'B17', 'E47']);
  const EXTERIOR = new Set(['B17', 'E47']);
  const DE_COMPRAS = new Set(['B11', 'E41']);
  const MAX_REGISTROS = 10000;
  const ENCABEZADOS = [
    'RNC o Cédula', 'Tipo Id', 'Tipo Bienes y Servicios Comprados', 'NCF', 'NCF o Documento Modificado',
    'Fecha Comprobante', 'Fecha Pago', 'Monto Facturado en Servicios', 'Monto Facturado en Bienes', 'Total Monto Facturado',
    'ITBIS Facturado', 'ITBIS Retenido', 'ITBIS sujeto a Proporcionalidad (Art. 349)', 'ITBIS llevado al Costo',
    'ITBIS por Adelantar', 'ITBIS percibido en compras', 'Tipo de Retención en ISR', 'Monto Retención Renta',
    'ISR Percibido en compras', 'Impuesto Selectivo al Consumo', 'Otros Impuestos/Tasas', 'Monto Propina Legal', 'Forma de Pago',
  ];

  const digitos = (v) => String(v ?? '').replace(/\D/g, '');
  // Centavos enteros: nada de sumas con flotantes.
  const centavos = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const pesos = (c) => (c / 100).toFixed(2);
  const opcional = (c) => (c ? pesos(c) : '');
  const dos = (n) => String(n).padStart(2, '0');

  function fecha(valor) {
    const s = String(valor ?? '').trim();
    const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (!m) return null;
    const [, a, mes, d] = m.map(Number);
    const f = new Date(Date.UTC(a, mes - 1, d));
    if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d) return null;
    return `${m[1]}${m[2]}${m[3]}`;
  }
  const codigo = (v, tabla) => {
    const n = Number(String(v ?? '').trim().replace(/^0+(?=\d)/, ''));
    return Number.isInteger(n) && tabla[n] ? n : null;
  };
  const tipoDeNcf = (ncf) => String(ncf || '').slice(0, 3).toUpperCase();

  function periodoValido(periodo) {
    const m = String(periodo || '').match(/^(\d{4})(\d{2})$/);
    return Boolean(m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 2018);
  }
  // Un rango AAAA-MM-DD → AAAAMM si es un solo mes.
  function periodoDeRango(desde, hasta) {
    const a = String(desde || '').slice(0, 7).replace('-', '');
    const b = String(hasta || desde || '').slice(0, 7).replace('-', '');
    return a && a === b && periodoValido(a) ? a : null;
  }

  // Acepta también los nombres del archivo para el contador de versiones anteriores.
  function leerRegistro(r) {
    return {
      origen: r.origen || '', referencia: r.referencia ?? null,
      rncCedula: digitos(r.rncCedula ?? r.rncProveedor),
      tipoBienesServicios: r.tipoBienesServicios,
      ncf: String(r.ncf || '').trim().toUpperCase(),
      ncfModificado: String(r.ncfModificado || '').trim().toUpperCase(),
      fechaComprobante: r.fechaComprobante, fechaPago: r.fechaPago,
      montoServicios: r.montoServicios, montoBienes: r.montoBienes, itbisFacturado: r.itbisFacturado,
      itbisRetenido: r.itbisRetenido, itbisProporcionalidad: r.itbisProporcionalidad, itbisCosto: r.itbisCosto,
      itbisPercibido: r.itbisPercibido, tipoRetencionIsr: r.tipoRetencionIsr ?? r.isrTipoRetencion,
      montoRetencionRenta: r.montoRetencionRenta, isrPercibido: r.isrPercibido, isc: r.isc,
      otrosImpuestos: r.otrosImpuestos, propinaLegal: r.propinaLegal, formaPago: r.formaPago,
    };
  }

  const MONTOS = ['montoServicios', 'montoBienes', 'itbisFacturado', 'itbisRetenido', 'itbisProporcionalidad', 'itbisCosto',
    'itbisPercibido', 'montoRetencionRenta', 'isrPercibido', 'isc', 'otrosImpuestos', 'propinaLegal'];

  /**
   * @param {{ rncInformante: string, periodo: string, registros: object[] }} datos
   * @returns {{ ok, periodo, rncInformante, nombreArchivo, txt, filas, errores, avisos, resumen }}
   */
  function construir({ rncInformante, periodo, registros = [] } = {}) {
    const errores = [];
    const avisos = [];
    const rncPropio = digitos(rncInformante);
    const per = String(periodo || '').replace(/\D/g, '');
    const general = (mensaje) => errores.push({ fila: null, ncf: '', mensaje });
    if (![9, 11].includes(rncPropio.length)) general('El RNC o cédula del negocio debe tener 9 u 11 dígitos (Configuración → Mi Negocio).');
    if (!periodoValido(per)) general('El período debe ser un mes (AAAAMM).');
    if (registros.length > MAX_REGISTROS) general(`La DGII admite hasta ${MAX_REGISTROS.toLocaleString('es-DO')} registros por archivo; este período tiene ${registros.length}.`);
    const inicio = `${per}01`;
    const fin = `${per}31`;

    const vistos = new Map();
    const filas = registros.map((crudo, i) => {
      const r = leerRegistro(crudo);
      const fila = i + 1;
      const error = (mensaje) => errores.push({ fila, ncf: r.ncf, origen: r.origen, mensaje });
      const aviso = (mensaje) => avisos.push({ fila, ncf: r.ncf, origen: r.origen, mensaje });
      const c = {};
      for (const k of MONTOS) {
        c[k] = r[k] === '' || r[k] === null || r[k] === undefined ? 0 : centavos(r[k]);
        if (!Number.isFinite(c[k])) { error(`${k}: no es un monto.`); c[k] = 0; }
        if (c[k] < 0) error(`${k}: no puede ser negativo.`);
      }

      const tipo = tipoDeNcf(r.ncf);
      if (!r.ncf) error('Falta el NCF.');
      else if (!/^(B\d{10}|E\d{12}|[A-Z]\d{18})$/.test(r.ncf)) error(`NCF «${r.ncf}» no tiene el formato de la DGII (B + 10 dígitos o E + 12).`);
      else if (r.ncf.length === 19) aviso('NCF de 19 posiciones: solo se acepta para retenciones de comprobantes de antes de mayo 2018.');
      else if (tipo === 'B02' || tipo === 'E32') error(`${tipo} es de consumo: no sustenta costos ni gastos y no va en el 606. Pide al proveedor un comprobante de crédito fiscal.`);
      else if (!TIPOS_NCF[tipo]) error(`${tipo} no es un comprobante que se reporte en el 606.`);

      let rnc = r.rncCedula;
      if (CON_RNC_PROPIO.has(tipo)) {
        if (!rnc) rnc = rncPropio;
        else if (rnc !== rncPropio) error(`${tipo}: la DGII pide el RNC o cédula de tu negocio (${rncPropio}), no ${rnc}.`);
      }
      if (![9, 11].includes(rnc.length)) error(rnc ? `RNC o cédula «${rnc}» debe tener 9 u 11 dígitos.` : 'Falta el RNC o cédula del proveedor.');
      if (DE_COMPRAS.has(tipo) && rnc.length === 9) aviso(`${tipo} a un RNC: la DGII alerta si el vendedor está registrado como contribuyente (debe darte crédito fiscal).`);
      const tipoId = rnc.length === 9 ? 1 : rnc.length === 11 ? 2 : '';

      const tipoBienes = codigo(r.tipoBienesServicios, TIPOS_BIENES);
      if (!tipoBienes) error('Falta el tipo de bienes y servicios (1 a 11).');

      if (NOTAS.has(tipo)) {
        if (!r.ncfModificado) error(`${tipo} es una nota: indica el NCF que modifica.`);
        else if (!/^(B\d{10}|E\d{12}|[A-Z]\d{18})$/.test(r.ncfModificado)) error(`NCF modificado «${r.ncfModificado}» no tiene el formato de la DGII.`);
      } else if (r.ncfModificado) {
        aviso('Tiene NCF modificado pero no es una nota de débito o crédito: se envía vacío.');
        r.ncfModificado = '';
      }

      const fComp = fecha(r.fechaComprobante);
      const fPago = r.fechaPago ? fecha(r.fechaPago) : '';
      if (!fComp) error('Fecha del comprobante inválida.');
      if (r.fechaPago && !fPago) error('Fecha de pago inválida.');
      const conRetencion = c.itbisRetenido > 0 || c.montoRetencionRenta > 0 || r.tipoRetencionIsr;
      if (conRetencion && !fPago) error('Con retención la DGII exige la fecha de pago (casilla 7).');
      if (fComp && fPago && fPago < fComp) error('La fecha de pago es anterior a la del comprobante.');
      if (fComp && fComp > fin) error('El comprobante es de un mes posterior al período.');
      if (fPago && fPago > fin) error('La fecha de pago es posterior al período.');
      if (fComp && fComp < inicio && !(conRetencion && fPago >= inicio)) {
        aviso('Comprobante de un mes anterior: solo se reporta otra vez para informar retenciones pagadas en este período.');
      }

      const total = c.montoServicios + c.montoBienes;
      if (total <= 0) error('El monto facturado (servicios + bienes, sin impuestos) es cero.');
      if (c.itbisRetenido > c.itbisFacturado) error('El ITBIS retenido es mayor que el facturado.');
      if (c.itbisCosto + c.itbisProporcionalidad > c.itbisFacturado) error('ITBIS al costo más proporcionalidad pasa del ITBIS facturado.');
      if (c.itbisFacturado > Math.round(total * 0.18) + 100) aviso('El ITBIS pasa del 18 % del monto: revisa los montos.');

      const tipoRet = r.tipoRetencionIsr ? codigo(r.tipoRetencionIsr, TIPOS_RETENCION_ISR) : null;
      if (r.tipoRetencionIsr && !tipoRet) error('Tipo de retención ISR inválido (1 a 9).');
      if (tipoRet && !c.montoRetencionRenta) error('Hay tipo de retención ISR sin monto retenido.');
      if (!tipoRet && c.montoRetencionRenta) error('Hay retención de renta sin su tipo (alquileres, honorarios…).');

      if (EXTERIOR.has(tipo)) {
        for (const k of ['itbisRetenido', 'itbisProporcionalidad', 'itbisCosto', 'isrPercibido', 'isc', 'otrosImpuestos', 'propinaLegal']) {
          if (c[k]) error(`${tipo} (pago al exterior) no lleva «${k}».`);
        }
      }

      const forma = codigo(r.formaPago, FORMAS_PAGO);
      if (!forma) error('Falta la forma de pago (1 a 7).');

      const clave = `${rnc}|${r.ncf}`;
      if (r.ncf && vistos.has(clave)) error(`Repetido: el mismo NCF del mismo proveedor ya está en la fila ${vistos.get(clave)}.`);
      else vistos.set(clave, fila);

      const adelantar = c.itbisFacturado - c.itbisCosto;
      const campos = [
        rnc, String(tipoId), tipoBienes ? dos(tipoBienes) : '', r.ncf, r.ncfModificado,
        fComp || '', fPago || '', pesos(c.montoServicios), pesos(c.montoBienes), pesos(total),
        pesos(c.itbisFacturado), opcional(c.itbisRetenido), opcional(c.itbisProporcionalidad), opcional(c.itbisCosto),
        pesos(adelantar), opcional(c.itbisPercibido), tipoRet ? dos(tipoRet) : '', opcional(c.montoRetencionRenta),
        opcional(c.isrPercibido), opcional(c.isc), opcional(c.otrosImpuestos), opcional(c.propinaLegal), forma ? dos(forma) : '',
      ];
      return {
        fila, origen: r.origen, referencia: r.referencia, tipoNcf: tipo, campos,
        montos: { total, itbis: c.itbisFacturado, itbisRetenido: c.itbisRetenido, adelantar, retencionRenta: c.montoRetencionRenta },
      };
    });

    const suma = (k) => filas.reduce((t, f) => t + f.montos[k], 0);
    const resumen = {
      cantidad: filas.length,
      montoFacturado: pesos(suma('total')), itbisFacturado: pesos(suma('itbis')), itbisRetenido: pesos(suma('itbisRetenido')),
      itbisPorAdelantar: pesos(suma('adelantar')), retencionRenta: pesos(suma('retencionRenta')),
    };
    const ok = errores.length === 0 && filas.length > 0;
    const encabezado = `606|${rncPropio}|${per}|${filas.length}`;
    const txt = ok ? `${[encabezado, ...filas.map((f) => f.campos.join('|'))].join('\r\n')}\r\n` : '';
    return {
      ok, periodo: per, rncInformante: rncPropio, nombreArchivo: `DGII_F_606_${rncPropio}_${per}.TXT`,
      txt, filas, errores, avisos, resumen, sinRegistros: filas.length === 0,
    };
  }

  // Filas para revisar en Excel (no es el archivo fiscal: ese es el TXT).
  function filasRevision(resultado) {
    return [['Origen', ...ENCABEZADOS], ...resultado.filas.map((f) => [f.origen, ...f.campos])];
  }

  return {
    construir, filasRevision, periodoDeRango, periodoValido, tipoDeNcf,
    TIPOS_BIENES, TIPOS_RETENCION_ISR, FORMAS_PAGO, TIPOS_NCF, ENCABEZADOS, MAX_REGISTROS,
  };
});
