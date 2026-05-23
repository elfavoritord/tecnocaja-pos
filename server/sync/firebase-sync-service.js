/**
 * firebase-sync-service.js
 *
 * Orquestador principal de sincronización con Firebase.
 * Detecta cambios de internet y ejecuta sincronizaciones.
 *
 * Cambios respecto a la versión previa:
 *  - Reusa modules/firebase-admin.js (lee FIREBASE_SERVICE_ACCOUNT_PATH /
 *    FIREBASE_SERVICE_ACCOUNT_JSON, igual que el resto del sistema). Se acabó
 *    el bug de FIREBASE_KEY_PATH inexistente.
 *  - checkInternet() hace un ping real (DNS lookup contra firestore.googleapis.com).
 *  - Si Firebase Admin no se pudo inicializar al arrancar (ej. sin internet),
 *    se reintenta cada vez que vuelve la conexión.
 *  - Expone lastError para que la UI pueda mostrar diagnóstico.
 */

const dns = require('dns').promises;
const { FirebaseSyncQueue } = require('./firebase-sync-queue');

// Cargar el módulo central de Firebase Admin de forma defensiva — si por
// alguna razón no está disponible, el servicio sigue funcionando en modo
// offline (encola pero no sube).
let firebaseAdminModule = null;
try {
  firebaseAdminModule = require('../../modules/firebase-admin');
} catch (err) {
  console.warn('⚠️  modules/firebase-admin no disponible:', err.message);
}

// Host usado para detectar internet. Usar el dominio real de Firestore
// porque si el firewall bloquea Firestore concretamente, da igual que
// google.com responda — sync va a fallar de todos modos.
const INTERNET_PROBE_HOST = 'firestore.googleapis.com';

class FirebaseSyncService {
  constructor() {
    this.isOnline = false;        // ¿Hay internet ahora mismo?
    this.firebaseReady = false;   // ¿Firebase Admin inicializado correctamente?
    this.isSyncing = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.syncInterval = null;
    this.checkInternetInterval = null;
  }

  /**
   * Inicializa el servicio de sincronización.
   */
  async initialize() {
    console.log('🔄 Inicializando Firebase Sync Service...');

    // Inicializar tabla de cola
    await FirebaseSyncQueue.init();

    // Primer chequeo inmediato (no esperar 10s)
    await this.checkInternet();

    // Detectar cambios de internet cada 10 segundos
    this.checkInternetInterval = setInterval(() => this.checkInternet(), 10000);

    // Intentar sincronizar cada 30 segundos si hay internet
    this.syncInterval = setInterval(() => this.processPendingItems(), 30000);

    // Limpiar items antiguos cada 24 horas
    setInterval(() => FirebaseSyncQueue.cleanup(7), 24 * 60 * 60 * 1000);

    console.log('✓ Firebase Sync Service inicializado');
  }

  /**
   * Verifica conectividad real a Firebase haciendo un DNS lookup.
   * Es barato (no consume cuota), y si DNS resuelve es muy probable que
   * Firestore esté alcanzable.
   */
  async checkInternet() {
    let online = false;
    try {
      await dns.lookup(INTERNET_PROBE_HOST);
      online = true;
    } catch (err) {
      online = false;
    }

    const wasOnline = this.isOnline;
    this.isOnline = online;

    if (online && !wasOnline) {
      console.log('🟢 Conexión a internet recuperada');
    } else if (!online && wasOnline) {
      console.warn('🔴 Conexión a internet perdida');
    }

    // Si hay internet pero Firebase Admin todavía no está listo, intentar
    // inicializarlo (puede que la app arrancara offline o que la key se
    // haya añadido en caliente).
    if (online && !this.firebaseReady) {
      this.tryInitFirebase();
    }
  }

  /**
   * Intenta inicializar Firebase Admin. Idempotente y silencioso en éxitos
   * repetidos.
   */
  tryInitFirebase() {
    if (this.firebaseReady) return true;
    if (!firebaseAdminModule) {
      this.lastError = 'modules/firebase-admin no cargado';
      return false;
    }

    try {
      // getFirestore() llama internamente a getFirebaseApp(), que lee
      // FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT_JSON.
      firebaseAdminModule.getFirestore();
      this.firebaseReady = true;
      this.lastError = null;
      console.log('✅ Firebase Admin SDK inicializado (sync service)');
      return true;
    } catch (err) {
      this.firebaseReady = false;
      this.lastError = err.message;
      // Solo loguear una vez para no spamear.
      if (!this._initWarnedOnce) {
        console.warn('⚠️  Firebase Admin no disponible:', err.message);
        this._initWarnedOnce = true;
      }
      return false;
    }
  }

  /**
   * Acceso lazy a Firestore. Lanza si no está listo.
   */
  getDb() {
    if (!this.firebaseReady) {
      this.tryInitFirebase();
    }
    if (!this.firebaseReady) {
      throw new Error(this.lastError || 'Firebase Admin no inicializado');
    }
    return firebaseAdminModule.getFirestore();
  }

  /**
   * Procesa items pendientes de sincronización.
   */
  async processPendingItems() {
    if (!this.isOnline || !this.firebaseReady || this.isSyncing) return;

    this.isSyncing = true;

    try {
      const pending = await FirebaseSyncQueue.getPending(5); // 5 a la vez

      for (const item of pending) {
        await this.syncItem(item);
      }

      if (pending.length > 0) {
        this.lastSyncAt = new Date();
        console.log(`✓ Sincronizados ${pending.length} items`);
      }
    } catch (err) {
      console.error('Error procesando items pendientes:', err);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sincroniza un item individual.
   */
  async syncItem(item) {
    try {
      const { id, entity_type, entity_id, data_payload } = item;
      const payload = JSON.parse(data_payload);

      console.log(`🚀 Sincronizando ${entity_type}:${entity_id}...`);

      const handlers = {
        sale: this.syncSale.bind(this),
        cash_closing: this.syncCashClosing.bind(this),
        daily_report: this.syncDailyReport.bind(this),
        inventory: this.syncInventory.bind(this),
      };

      const handler = handlers[entity_type];
      if (!handler) {
        throw new Error(`No hay handler para ${entity_type}`);
      }

      await handler(payload, entity_id);
      await FirebaseSyncQueue.markSynced(id);
      console.log(`✅ Sincronizado ${entity_type}:${entity_id}`);
    } catch (err) {
      console.error('❌ Error sincronizando:', err);
      await FirebaseSyncQueue.markError(item.id, err.message);
    }
  }

  /** Sincroniza una venta. */
  async syncSale(payload, saleId) {
    const db = this.getDb();
    const { businessId, branchId, ...saleData } = payload;

    await db
      .collection('businesses')
      .doc(businessId)
      .collection('branches')
      .doc(branchId)
      .collection('sales')
      .doc(saleId)
      .set({ ...saleData, _synced_at: new Date() }, { merge: true });
  }

  /** Sincroniza un cierre de caja. */
  async syncCashClosing(payload, closingId) {
    const db = this.getDb();
    const { businessId, branchId, ...closingData } = payload;

    await db
      .collection('businesses')
      .doc(businessId)
      .collection('branches')
      .doc(branchId)
      .collection('cash_closings')
      .doc(closingId)
      .set({ ...closingData, _synced_at: new Date() }, { merge: true });
  }

  /** Sincroniza un reporte diario. */
  async syncDailyReport(payload, reportDate) {
    const db = this.getDb();
    const { businessId, branchId, ...reportData } = payload;

    await db
      .collection('businesses')
      .doc(businessId)
      .collection('branches')
      .doc(branchId)
      .collection('daily_reports')
      .doc(reportDate)
      .set({ ...reportData, _synced_at: new Date() }, { merge: true });
  }

  /** Sincroniza inventario. */
  async syncInventory(payload, branchId) {
    const db = this.getDb();
    const { businessId, items } = payload;

    const batch = db.batch();

    for (const item of items) {
      const docRef = db
        .collection('businesses')
        .doc(businessId)
        .collection('branches')
        .doc(branchId)
        .collection('inventory')
        .doc(String(item.product_id));

      batch.set(docRef, { ...item, _synced_at: new Date() }, { merge: true });
    }

    await batch.commit();
  }

  /**
   * Estado de sincronización (lo consume /api/sync/status y la UI).
   *
   * isOnline en la UI representa "puedo sincronizar AHORA": eso requiere
   * tanto internet como Firebase Admin listo. Así, si falta la key, la UI
   * dirá "Sin internet" pero el log explicará por qué.
   */
  async getStatus() {
    const stats = await FirebaseSyncQueue.getStats();
    return {
      isOnline: this.isOnline && this.firebaseReady,
      hasInternet: this.isOnline,
      firebaseReady: this.firebaseReady,
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      queue: stats,
    };
  }

  /** Fuerza sincronización manual. */
  async syncNow() {
    if (this.isSyncing) {
      return { status: 'already_syncing' };
    }

    // Intento de re-init por si recién volvió internet
    if (!this.firebaseReady) {
      this.tryInitFirebase();
    }

    if (!this.isOnline) {
      return { status: 'offline', message: 'Sin conexión a internet' };
    }
    if (!this.firebaseReady) {
      return {
        status: 'firebase_unavailable',
        message: this.lastError || 'Firebase Admin no inicializado',
      };
    }

    console.log('🔄 Sincronización manual iniciada');
    await this.processPendingItems();
    return { status: 'syncing' };
  }

  /** Detiene el servicio. */
  stop() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.checkInternetInterval) clearInterval(this.checkInternetInterval);
    console.log('⛔ Firebase Sync Service detenido');
  }
}

// Instancia singleton
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new FirebaseSyncService();
  }
  return instance;
}

module.exports = {
  FirebaseSyncService,
  getInstance,
};
