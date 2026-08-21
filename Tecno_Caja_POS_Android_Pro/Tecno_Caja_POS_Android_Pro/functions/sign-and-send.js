'use strict';

/**
 * signAndSend / consultarEstadoEcf -- cierra el ciclo real de e-CF que
 * `fiscal.js:requestNcf` deja en PENDIENTE_FIRMA. Porta la orquestación de
 * modules/ecf/services/ecf.service.js (Desktop, solo lectura de referencia):
 * generar XML -> firmar -> (RFCE si aplica) -> enviar a DGII -> QR.
 *
 * Alcance de esta primera entrega: solo E31 (Crédito Fiscal) y E32
 * (Consumo, con rama RFCE por umbral) -- ver plan de implementación. El
 * resto de tipos e-CF quedan reservados por requestNcf pero signAndSend los
 * rechaza con un error claro en vez de enviar un XML nunca probado contra
 * DGII real.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const { callerContext } = require('./certification');
const { SUPPORTED_ECF_TYPES, RFCE_THRESHOLD_DOP, ALLOW_E32_FULL_RECEPTION, resolveEnvironmentConfig } = require('./ecf/config');
const { generateEcfXml, generateRfceXml } = require('./ecf/xml-generator');
const { signXml, extractSecurityCode } = require('./ecf/signing');
const { buildQrVerificationUrl } = require('./ecf/qr-url');
const { getCertificateForSigning } = require('./ecf/certificate');
const { getAuthToken } = require('./ecf/dgii-auth');
const dgiiClient = require('./ecf/dgii-client');

const LOCK_STALE_MS = 2 * 60 * 1000;

// DGII: 1=Efectivo, 2=Cheque/Transferencia/Depósito, 3=Tarjeta, 4=Crédito,
// 8=Otras formas de venta -- mapeo de MetodoPago (lib/domain/entities/venta.dart).
const TIPO_PAGO_POR_METODO = {
  efectivo: '1',
  tarjeta: '3',
  transferencia: '2',
  credito: '4',
  combinado: '8',
};

function ecfDocRef(db, businessId, saleId) {
  return db.collection('businesses').doc(businessId).collection('ecfDocuments').doc(saleId);
}

function saleRef(db, businessId, saleId) {
  return db.collection('businesses').doc(businessId).collection('sales').doc(saleId);
}

async function buildEmitter(db, businessId) {
  const [businessSnap, fiscalSnap] = await Promise.all([
    db.collection('businesses').doc(businessId).get(),
    db.collection('businesses').doc(businessId).collection('settings').doc('fiscal').get(),
  ]);
  if (!businessSnap.exists) throw new HttpsError('failed-precondition', 'La empresa no existe.');
  const business = businessSnap.data() || {};
  const fiscal = fiscalSnap.exists ? fiscalSnap.data() : {};

  const emitter = {
    rnc: business.rnc || business.rncCedula || '',
    razonSocial: business.razonSocial || business.name || business.nombreComercial || '',
    nombreComercial: business.nombreComercial || business.name || '',
    direccion: business.address || business.direccion || '',
    telefono: business.phone || business.telefono || '',
    correo: business.email || business.correo || '',
  };
  if (!emitter.rnc || !emitter.razonSocial) {
    throw new HttpsError('failed-precondition', 'Configura RNC y razón social de la empresa antes de emitir e-CF.');
  }
  if (!fiscal.actividadEconomica) {
    throw new HttpsError('failed-precondition', 'Configura la actividad económica en Facturación fiscal antes de emitir e-CF.');
  }
  return emitter;
}

async function buildCustomer(db, businessId, sale) {
  if (!sale.customerId) return { nombre: 'Consumidor Final' };
  const snap = await db.collection('businesses').doc(businessId).collection('customers').doc(String(sale.customerId)).get();
  if (!snap.exists) return { nombre: 'Consumidor Final' };
  const c = snap.data() || {};
  return {
    rnc: c.taxId || '',
    nombre: c.name || 'Consumidor Final',
    correo: c.email || '',
    telefono: c.phone || '',
    direccion: c.address || '',
  };
}

function buildItemsPayload(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  return items.map((item) => ({
    name: item.productName || 'Producto',
    quantity: Number(item.quantity || 0),
    unitPrice: Number(item.price || 0),
    discount: Number(item.discount || 0),
    taxRate: Number(item.taxRate || 0),
  }));
}

/**
 * signAndSend({businessId, branchId, saleId}) -- firma y envía a DGII el
 * e-CF que requestNcf ya reservó (estadoFiscal: PENDIENTE_FIRMA).
 */
const signAndSend = onCall({ cors: true, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const businessId = String(request.data?.businessId || '').trim();
  const saleId = String(request.data?.saleId || '').trim();
  if (!businessId || !saleId) throw new HttpsError('invalid-argument', 'Faltan businessId o saleId.');

  // callerContext valida sesión + pertenencia a la empresa (mismo patrón que
  // certification.js/certificate-vault.js); cualquier empleado con acceso a
  // e-CF puede disparar la firma/envío, no solo un admin (el gate de
  // Permiso.accederECF ya se aplica del lado Flutter).
  await callerContext(request, { adminOnly: false });

  const db = admin.firestore();
  const sRef = saleRef(db, businessId, saleId);
  const dRef = ecfDocRef(db, businessId, saleId);

  const saleSnap = await sRef.get();
  if (!saleSnap.exists) throw new HttpsError('not-found', 'La venta no existe en el servidor.');
  const sale = saleSnap.data();

  const estadoActual = String(sale.estadoFiscal || '');
  if (['ENVIADO', 'ACEPTADO', 'ACEPTADO_CONDICIONAL'].includes(estadoActual)) {
    const docSnap = await dRef.get();
    return {
      reused: true,
      estadoFiscal: estadoActual,
      trackId: sale.ecfTrackId || null,
      ecfQrUrl: sale.ecfQrUrl || null,
      dgiiResponse: docSnap.exists ? (docSnap.data().dgiiResponse || null) : null,
    };
  }
  if (estadoActual === 'RECHAZADO') {
    throw new HttpsError('failed-precondition', 'Este e-CF ya fue rechazado por DGII. Requiere corrección manual (fuera de alcance de reintento automático).');
  }
  if (['FIRMANDO', 'ENVIANDO'].includes(estadoActual)) {
    const updatedAt = sale.updatedAt?.toDate ? sale.updatedAt.toDate() : new Date(0);
    if (Date.now() - updatedAt.getTime() < LOCK_STALE_MS) {
      throw new HttpsError('already-exists', 'Ya hay un envío en curso para esta venta. Espera un momento y vuelve a intentar.');
    }
  }
  if (estadoActual !== 'PENDIENTE_FIRMA' && !['FIRMANDO', 'ENVIANDO'].includes(estadoActual)) {
    throw new HttpsError('failed-precondition', `La venta no está lista para firmar (estado actual: ${estadoActual || 'sin NCF'}). Primero solicita el NCF.`);
  }

  const ncfType = String(sale.ncfType || '').toUpperCase();
  if (!SUPPORTED_ECF_TYPES.has(ncfType)) {
    throw new HttpsError('failed-precondition', `El tipo ${ncfType} todavía no está soportado por la firma/envío automático (solo E31/E32 en esta versión).`);
  }
  const ambiente = String(sale.ambiente || 'certificacion');

  await sRef.set({ estadoFiscal: 'FIRMANDO', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  let fase = 'FIRMANDO';

  try {
    const emitter = await buildEmitter(db, businessId);
    const customer = await buildCustomer(db, businessId, sale);
    const items = buildItemsPayload(sale);
    if (!items.length) throw new HttpsError('failed-precondition', 'La venta no tiene productos para facturar.');

    const tipoPago = TIPO_PAGO_POR_METODO[String(sale.paymentMethod || 'efectivo')] || '1';
    const issueDate = sale.createdAt?.toDate ? sale.createdAt.toDate() : new Date();

    const { xml: unsignedEcfXml, totals } = generateEcfXml({
      emitter,
      customer,
      document: { eNCF: sale.ncf, tipoeCF: ncfType, tipoPago, tipoIngresos: '01' },
      items,
      issueDate,
    });

    const certificate = await getCertificateForSigning(businessId);
    const signedEcfXml = signXml(unsignedEcfXml, certificate);
    const codigoSeguridad = extractSecurityCode(signedEcfXml);
    if (!codigoSeguridad) throw new Error('No se pudo calcular el código de seguridad del e-CF firmado.');

    const usaRfce = ncfType === 'E32' && totals.total < RFCE_THRESHOLD_DOP && !ALLOW_E32_FULL_RECEPTION;
    let xmlEnviado = signedEcfXml;
    let submissionMode = 'ecf';

    if (usaRfce) {
      const unsignedRfceXml = generateRfceXml({
        emitter,
        customer,
        document: { eNCF: sale.ncf, tipoeCF: ncfType, tipoPago, tipoIngresos: '01', codigoSeguridad },
        totals,
        issueDate,
      });
      xmlEnviado = signXml(unsignedRfceXml, certificate);
      submissionMode = 'rfce';
    }

    fase = 'ENVIANDO';
    await sRef.set({ estadoFiscal: 'ENVIANDO', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    const token = await getAuthToken(db, businessId, certificate, ambiente);
    const { recepcionUrl, facturaConsumoUrl } = resolveEnvironmentConfig(ambiente);
    const dgiiResult = submissionMode === 'rfce'
      ? await dgiiClient.sendRfce(facturaConsumoUrl, token, xmlEnviado)
      : await dgiiClient.sendEcf(recepcionUrl, token, xmlEnviado);

    const trackId = dgiiResult.trackId || dgiiResult.TrackId || null;
    const ecfQrUrl = buildQrVerificationUrl(xmlEnviado, ambiente);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await dRef.set({
      businessId,
      saleId,
      ncf: sale.ncf,
      ncfType,
      ambiente,
      submissionMode,
      estadoFiscal: 'ENVIADO',
      trackId,
      codigoSeguridad,
      ecfQrUrl,
      xmlFirmado: xmlEnviado,
      dgiiResponse: {
        mensaje: dgiiResult.mensaje || null,
        codigo: dgiiResult.codigo || null,
        raw: dgiiResult.raw ? String(dgiiResult.raw).slice(0, 4000) : null,
      },
      updatedAt: now,
      sentAt: now,
    }, { merge: true });

    await sRef.set({
      estadoFiscal: 'ENVIADO',
      ecfTrackId: trackId,
      ecfQrUrl,
      ecfError: null,
      updatedAt: now,
    }, { merge: true });

    return { reused: false, estadoFiscal: 'ENVIADO', trackId, ecfQrUrl, submissionMode };
  } catch (error) {
    const mensaje = error instanceof HttpsError ? error.message : (error?.message || 'Error desconocido al firmar/enviar el e-CF.');
    await sRef.set({
      estadoFiscal: fase === 'ENVIANDO' ? 'ENVIO_FALLIDO' : 'FIRMA_FALLIDA',
      ecfError: mensaje,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', mensaje);
  }
});

/**
 * consultarEstadoEcf({businessId, saleId}) -- consulta el TrackID en DGII,
 * sin re-firmar ni reenviar.
 */
const consultarEstadoEcf = onCall({ cors: true, timeoutSeconds: 60 }, async (request) => {
  const businessId = String(request.data?.businessId || '').trim();
  const saleId = String(request.data?.saleId || '').trim();
  if (!businessId || !saleId) throw new HttpsError('invalid-argument', 'Faltan businessId o saleId.');

  await callerContext(request, { adminOnly: false });

  const db = admin.firestore();
  const dRef = ecfDocRef(db, businessId, saleId);
  const docSnap = await dRef.get();
  if (!docSnap.exists || !docSnap.data().trackId) {
    throw new HttpsError('failed-precondition', 'Esta venta todavía no tiene un TrackID de DGII para consultar.');
  }
  const doc = docSnap.data();
  const ambiente = doc.ambiente || 'certificacion';

  const certificate = await getCertificateForSigning(businessId);
  const token = await getAuthToken(db, businessId, certificate, ambiente);
  const { consultaTrackIdUrl } = resolveEnvironmentConfig(ambiente);
  const result = await dgiiClient.queryTrackStatus(consultaTrackIdUrl, token, doc.trackId);

  const codigo = String(result.codigo || '').trim();
  let estadoFiscal = 'DESCONOCIDO';
  if (codigo === '1') estadoFiscal = 'ACEPTADO';
  else if (codigo === '2') estadoFiscal = 'RECHAZADO';
  else if (codigo === '3') estadoFiscal = 'EN_PROCESO';
  else if (codigo === '4') estadoFiscal = 'ACEPTADO_CONDICIONAL';

  const now = admin.firestore.FieldValue.serverTimestamp();
  await dRef.set({
    estadoFiscal,
    dgiiResponse: {
      mensaje: result.mensaje || null,
      codigo: result.codigo || null,
      raw: result.raw ? String(result.raw).slice(0, 4000) : null,
    },
    updatedAt: now,
    lastCheckedAt: now,
  }, { merge: true });
  await saleRef(db, businessId, saleId).set({ estadoFiscal, updatedAt: now }, { merge: true });

  return { estadoFiscal, codigo: result.codigo || null, mensaje: result.mensaje || null };
});

module.exports = { signAndSend, consultarEstadoEcf };
