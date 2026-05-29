// ===== TECNO_CAJA - CLIENT STATE =====
const DB = {
  config: {
    nombre: 'Tecno Caja',
    logo: '',
    rnc: '',
    direccion: '',
    telefono: '',
    moneda: 'RD$',
    idioma: 'es',
    tipoNegocio: 'pizzeria',
    setupCompleted: false,
    requireCashOpenBeforeUse: true,
    licenseStatus: 'trial',
    trialStartedAt: null,
    trialEndsAt: null,
    trialDaysLeft: 30,
    trialExpired: false,
    businessProfile: null,
    itbis: 18,
    taxCalculateAtInvoiceEnd: true,
    taxIncludeInProductPrice: false,
    taxShowBreakdownOnReceipts: true,
    taxSeparateTaxableAndExempt: true,
    prefix: 'FAC-',
    nextInvoice: 1001,
    eInvoiceEnabled: true,
    eInvoicePrefix: 'ECF-',
    eInvoiceNextNumber: 1,
    mensaje: '',
    scaleType: 'none',
    scaleSerialPort: '',
    scaleSerialBaudRate: 9600,
    scaleDefaultUnit: 'kg',
    scaleReadPattern: '',
    scaleRoundingDecimals: 2,
    scaleAutoRead: true,
    cajaAbierta: false,
    cajaMonto: 0,
    activeBranchId: null,
    activeCashRegisterId: null,
    activeBranchName: '',
    activeCashRegisterName: '',
    salesSplitViewEnabled: false,
    whatsappPasteGuideEnabled: true
  },
  users: [],
  currentUser: null,
  authToken: null,
  categorias: [],
  productos: [],
  clientes: [],
  proveedores: [],
  facturasProveedores: [],
  roles: [],
  mesas: [],
  sucursales: [],
  cajasSucursal: [],
  deliveryLocations: [],
  mobileSessions: [],
  mobileConfig: null,
  ventas: [],
  movimientosSistema: [],
  movimientosInventario: [],
  ventasPendientes: [],
  cotizaciones: [],
  movimientosCaja: [],
  nextInvoice: 1001,
  saleItems: [],
  payMethod: 'efectivo',
  saleDocumentType: 'ticket',
  saleClientId: null,
  saleDeliveryUserId: null,
  saleOrderType: 'mostrador',
  saleKitchenStatus: 'pendiente',
  saleGeneralDiscount: 0,
  saleNcfType: '',
  saleRncCliente: '',
  saleRazonSocial: '',
  saleNcfReferencia: '',
  saleNcfReferenciaId: null,
  saleTableLabel: '',
  saleDeliveryPhone: '',
  saleDeliveryAddress: '',
  saleDeliveryReference: '',
  saleDeliveryLink: '',
  saleOrderNotes: '',
  caja: {
    sessionId: null,
    abierta: false
  }
};

function hydrateDB(payload) {
  Object.assign(DB, payload);
  DB.config = { ...DB.config, ...(payload.config || {}) };
  DB.caja = { ...DB.caja, ...(payload.caja || {}) };
  const resolvedCajaAbierta = Boolean(DB.caja?.abierta || DB.config?.cajaAbierta);
  DB.caja = { ...DB.caja, abierta: resolvedCajaAbierta };
  DB.config = {
    ...DB.config,
    cajaAbierta: resolvedCajaAbierta,
    cajaMonto: resolvedCajaAbierta ? (Number(DB.config?.cajaMonto || 0) || 0) : 0
  };
  DB.ventasPendientes = payload.ventasPendientes || DB.ventasPendientes || [];
  DB.cotizaciones = payload.cotizaciones || DB.cotizaciones || [];
  DB.saleItems = payload.saleItems || [];
  DB.payMethod = payload.payMethod || 'efectivo';
  DB.saleDocumentType = payload.saleDocumentType || 'ticket';
  DB.saleClientId = payload.saleClientId || null;
  DB.saleDeliveryUserId = payload.saleDeliveryUserId || null;
  DB.saleOrderType = payload.saleOrderType || 'mostrador';
  DB.saleKitchenStatus = payload.saleKitchenStatus || 'pendiente';
  DB.saleGeneralDiscount = Number(payload.saleGeneralDiscount || 0) || 0;
  DB.saleNcfType = payload.saleNcfType || '';
  DB.saleRncCliente = payload.saleRncCliente || '';
  DB.saleRazonSocial = payload.saleRazonSocial || '';
  DB.saleNcfReferencia = payload.saleNcfReferencia || '';
  DB.saleNcfReferenciaId = payload.saleNcfReferenciaId || null;
  DB.saleTableLabel = payload.saleTableLabel || '';
  DB.saleDeliveryPhone = payload.saleDeliveryPhone || '';
  DB.saleDeliveryAddress = payload.saleDeliveryAddress || '';
  DB.saleDeliveryReference = payload.saleDeliveryReference || '';
  DB.saleDeliveryLink = payload.saleDeliveryLink || '';
  DB.saleOrderNotes = payload.saleOrderNotes || '';
}
