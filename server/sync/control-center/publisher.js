'use strict';

/**
 * server/sync/control-center/publisher.js
 *
 * Publica el Centro de Control de la app de reportes en Firestore, debajo del
 * mismo businesses/{businessId} que ya usan los demás datos de la app:
 *
 *   controlCenter/{tipo}[_b{sucursal}]    resumen, ventas, inventario, caja,
 *                                         clientes, fiscal, delivery y el
 *                                         catálogo de productos (catalog +
 *                                         catalog_p{n}, páginas de 400)
 *   dailyStats/{YYYY-MM-DD}[_b{sucursal}] un documento por día (rangos libres)
 *   terminals/{serverId}                  señal de vida de cada PC (cualquier caja)
 *
 * Reglas LAN-first:
 *   - Nunca corre dentro de una venta ni la espera: todo es en segundo plano.
 *   - Sin Internet no intenta nada; publica cuando vuelve la conexión.
 *   - Solo la PC principal (la de la base de datos) calcula y publica los
 *     resúmenes; las cajas terminal solo mandan su señal de vida. Así en
 *     multicaja no se repite el mismo cálculo en cada PC.
 *   - Solo escribe un documento si cambió (huella SHA-1), salvo el resumen,
 *     que se refresca cada pocos minutos para que la app sepa que el POS vive.
 */

const crypto = require('crypto');
const snapshotLib = require('./snapshot');
const periodsLib = require('./periods');

const DEFAULTS = {
  firstRunDelayMs: 45 * 1000,
  quickDelayMs: 30 * 1000,
  minGapMs: 90 * 1000,
  fullIntervalMs: 15 * 60 * 1000,
  heartbeatMs: 5 * 60 * 1000,
  summaryRefreshMs: 10 * 60 * 1000,
  backfillDays: 400,
  backfillChunkDays: 31,
  backfillPauseMs: 4000,
};

const BACKFILL_VERSION = 1;
const VOLATILE_KEYS = new Set([
  'asOf', 'generatedAt', 'generatedAtText', 'hoursOpen', 'lastSeenAt', 'checkedAt', 'lastCheckAt', 'warnings',
]);

/** Firestore no acepta undefined, NaN ni Infinity. */
function clean(value) {
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = clean(entry);
    }
    return out;
  }
  return value;
}

/** Huella del contenido sin los campos que cambian en cada corrida. */
function stableHash(value) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out = {};
      for (const key of Object.keys(v).sort()) {
        if (VOLATILE_KEYS.has(key)) continue;
        out[key] = strip(v[key]);
      }
      return out;
    }
    return v;
  };
  return crypto.createHash('sha1').update(JSON.stringify(strip(value))).digest('hex');
}

function isEmptyDay(doc) {
  const t = doc.data.totals || {};
  return !t.invoices && !t.sales && !t.cancelled?.count && !t.returns?.count
    && !t.collections?.count && !t.expenses;
}

function createControlCenterPublisher(deps = {}) {
  const {
    query,
    getFirestore,
    getBusinessId,
    monitor = null,
    isMain = () => true,
    getServerId = () => 'srv_desconocido',
    getHostname = () => '',
    getTerminalScope = () => ({}),
    getCloudStatus = async () => null,
    countDeferredEcf = async () => 0,
    countContingencySales = async () => 0,
    ensureSchema = async () => {},
    mapSequence = null,
    appVersion = '',
    logger = console,
    now = () => new Date(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = deps;
  const options = { ...DEFAULTS, ...(deps.options || {}) };

  const hashes = new Map();
  const lastWriteAt = new Map();
  const warned = new Set();
  let started = false;
  let schemaReady = false;
  let inFlight = null;
  let fullRequestedAfterRun = false;
  let scheduledTimer = null;
  let scheduledFull = false;
  let pendingWhileOffline = false;
  let backfillRunning = false;
  let backfillChecked = false;
  let backfillPromise = null;
  let lastRunEndedAt = 0;
  let lastFullAt = 0;
  let lastBusinessId = null;
  let cache = { facts: null, factsDay: null, months: null };
  let timers = [];
  let onConnectivityChange = null;

  const status = {
    started: false,
    role: null,
    businessId: null,
    lastRunAt: null,
    lastRunMode: null,
    lastDurationMs: null,
    lastError: null,
    lastSuccessAt: null,
    lastWrites: 0,
    runs: 0,
    backfill: null,
  };

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(`[control-center] ${message}`);
  }

  function isKnownOffline() {
    if (!monitor) return false;
    if (typeof monitor.isKnownOffline === 'function') return monitor.isKnownOffline();
    return monitor.getStatus?.().online === false;
  }

  function firestoreOrNull() {
    try {
      return getFirestore();
    } catch (error) {
      warnOnce('no-firestore', `Firebase no está configurado; no se publica el Centro de Control (${error.message}).`);
      return null;
    }
  }

  function resolveBusinessId(config = {}) {
    const id = getBusinessId({ ...config, nombre: config.business_name, business_name: config.business_name });
    if (id) {
      lastBusinessId = id;
      status.businessId = id;
    }
    return id || null;
  }

  async function syncInfo() {
    const [cloud, pendingEcf] = await Promise.all([
      Promise.resolve().then(getCloudStatus).catch(() => null),
      Promise.resolve().then(countDeferredEcf).catch(() => 0),
    ]);
    const internet = monitor?.getStatus ? monitor.getStatus() : { online: null };
    const { day, time } = periodsLib.rdParts(now());
    return {
      generatedAt: now(),
      generatedAtText: `${day} ${time}`,
      generatedBy: {
        serverId: getServerId(),
        hostname: getHostname(),
        role: isMain() ? 'principal' : 'terminal',
        appVersion,
      },
      internet: { online: internet.online ?? null, lastCheckAt: internet.lastCheckAt || null },
      cloud: {
        ready: cloud ? Boolean(cloud.firebaseReady) : null,
        lastSyncAt: cloud?.lastSyncAt || null,
        pending: Number(cloud?.queue?.pending || 0),
        errors: Number(cloud?.queue?.errors || 0),
        lastError: cloud?.lastError ? String(cloud.lastError).slice(0, 200) : null,
      },
      pendingEcf: Number(pendingEcf || 0),
    };
  }

  /** Escribe solo los documentos que cambiaron. Devuelve cuántos escribió. */
  async function writeDocs(firestore, businessId, collection, docs, { force = new Set() } = {}) {
    const base = firestore.collection('businesses').doc(businessId).collection(collection);
    const stamp = now();
    const pending = [];
    for (const { id, data } of docs) {
      const path = `${businessId}/${collection}/${id}`;
      const payload = clean(data);
      const hash = stableHash(payload);
      const refreshDue = force.has(id)
        && (stamp.getTime() - (lastWriteAt.get(path) || 0)) >= options.summaryRefreshMs;
      if (!refreshDue && hashes.get(path) === hash) continue;
      pending.push({ ref: base.doc(id), payload: { ...payload, generatedAt: stamp }, path, hash });
    }
    for (let i = 0; i < pending.length; i += 400) {
      const slice = pending.slice(i, i + 400);
      const batch = firestore.batch();
      for (const item of slice) batch.set(item.ref, item.payload);
      await batch.commit();
      for (const item of slice) {
        hashes.set(item.path, item.hash);
        lastWriteAt.set(item.path, stamp.getTime());
      }
    }
    return pending.length;
  }

  async function heartbeat(firestore) {
    if (!firestore || !lastBusinessId) return 0;
    const scope = getTerminalScope() || {};
    const [info, contingencySales] = await Promise.all([
      syncInfo(),
      Promise.resolve().then(countContingencySales).catch(() => 0),
    ]);
    const role = isMain() ? 'principal' : 'terminal';
    const data = clean({
      serverId: getServerId(),
      hostname: getHostname(),
      role,
      isMain: role === 'principal',
      branchId: scope.branchId ? String(scope.branchId) : null,
      cashRegisterId: scope.cashRegisterId ? String(scope.cashRegisterId) : null,
      appVersion,
      lastSeenAt: now(),
      lastSeenText: info.generatedAtText,
      internet: info.internet,
      cloud: info.cloud,
      pendingEcf: info.pendingEcf,
      contingencySales: Number(contingencySales || 0),
      mode: role === 'terminal' && Number(contingencySales || 0) > 0 ? 'contingencia' : 'normal',
      publisher: {
        lastRunAt: status.lastRunAt,
        lastSuccessAt: status.lastSuccessAt,
        lastDurationMs: status.lastDurationMs,
        lastError: status.lastError,
      },
    });
    await firestore
      .collection('businesses').doc(lastBusinessId)
      .collection('terminals').doc(getServerId())
      .set(data, { merge: true });
    return 1;
  }

  async function publish({ full }) {
    const firestore = firestoreOrNull();
    if (!firestore) return { skipped: 'firebase' };

    if (!isMain()) {
      // Caja terminal: solo su señal de vida (necesita saber el negocio).
      if (!lastBusinessId) {
        const rows = await query('SELECT business_name FROM config WHERE id = 1 LIMIT 1').catch(() => []);
        resolveBusinessId(rows[0] || {});
      }
      const writes = await heartbeat(firestore);
      return { writes, mode: 'heartbeat' };
    }

    if (!schemaReady) {
      await Promise.resolve().then(ensureSchema)
        .catch((error) => warnOnce('schema', `No se pudieron revisar tablas: ${error.message}`));
      schemaReady = true;
    }

    const today = periodsLib.rdParts(now()).day;
    const needsFull = full || !cache.facts || cache.factsDay !== today;
    const snapshot = await snapshotLib.collectSnapshot({
      query,
      now: now(),
      cachedFacts: needsFull ? null : cache.facts,
      cachedMonths: needsFull ? null : cache.months,
      full: needsFull,
      mapSequence,
      syncInfo: await syncInfo(),
    });
    cache = { facts: snapshot.facts, factsDay: today, months: snapshot.months };

    const businessId = resolveBusinessId(snapshot.config);
    if (!businessId) {
      warnOnce('no-business', 'El negocio no tiene licencia ni nombre propio todavía; no se publica el Centro de Control.');
      return { skipped: 'business' };
    }

    const scopes = [null, ...snapshot.branchKeys];
    const controlDocs = [];
    for (const scopeKey of scopes) {
      const docs = snapshotLib.buildScopeDocuments(snapshot, scopeKey);
      for (const [kind, data] of Object.entries(docs)) {
        controlDocs.push({ id: scopeKey === null ? kind : `${kind}_b${scopeKey}`, data });
      }
    }
    const force = new Set(scopes.map((key) => (key === null ? 'summary' : `summary_b${key}`)));
    let writes = await writeDocs(firestore, businessId, 'controlCenter', controlDocs, { force });

    // Días de la ventana: en corrida rápida solo hoy (los demás no cambiaron).
    const windowDays = needsFull ? periodsLib.listDays(snapshot.periods.facts.fromDay, today) : [today];
    const dayDocs = [];
    for (const scopeKey of scopes) {
      dayDocs.push(...snapshotLib.buildDayDocuments(snapshot, windowDays, scopeKey));
    }
    writes += await writeDocs(firestore, businessId, 'dailyStats', dayDocs);
    writes += await heartbeat(firestore).catch((error) => {
      warnOnce(`heartbeat:${error.message}`, `No se pudo registrar la señal de vida: ${error.message}`);
      return 0;
    });

    if (needsFull) lastFullAt = now().getTime();
    for (const warning of snapshot.warnings) warnOnce(`snap:${warning}`, `Sección omitida — ${warning}`);

    if (!backfillChecked) {
      backfillChecked = true;
      backfillPromise = runBackfill(firestore, businessId, snapshot).catch((error) => {
        backfillChecked = false;
        status.backfill = { error: error.message };
        warnOnce(`backfill:${error.message}`, `El histórico diario no se pudo completar: ${error.message}`);
      });
    }
    return { writes, mode: needsFull ? 'full' : 'quick' };
  }

  /**
   * Histórico de dailyStats para rangos libres en la app (una sola vez por
   * versión; se reanuda si se corta). Va por bloques de un mes con pausas
   * para no cargar la base de datos de la tienda.
   */
  async function runBackfill(firestore, businessId, snapshot) {
    if (backfillRunning) return;
    backfillRunning = true;
    try {
      const metaRef = firestore.collection('businesses').doc(businessId).collection('controlCenter').doc('meta');
      const metaSnap = await metaRef.get();
      const done = (metaSnap?.exists ? metaSnap.data() : {})?.backfill || {};
      const windowFrom = snapshot.periods.facts.fromDay;
      const target = periodsLib.addDays(snapshot.today, -options.backfillDays);
      if (done.version === BACKFILL_VERSION && done.fromDay && done.fromDay <= target) {
        status.backfill = { done: true, fromDay: done.fromDay };
        return;
      }

      const customerFirsts = await snapshotLib.collectCustomerFirsts(query).catch(() => null);
      const scopes = [null, ...snapshot.branchKeys];
      let cursorTo = periodsLib.addDays(windowFrom, -1);
      let written = 0;
      while (cursorTo >= target) {
        if (!started) return;
        if (isKnownOffline()) {
          backfillChecked = false; // se retoma en la próxima corrida con Internet
          return;
        }
        const chunkFrom = periodsLib.addDays(cursorTo, -(options.backfillChunkDays - 1));
        const cursorFrom = chunkFrom < target ? target : chunkFrom;
        const facts = await snapshotLib.collectFacts(query, { fromDay: cursorFrom, toDay: cursorTo }, { customerFirsts });
        const days = periodsLib.listDays(cursorFrom, cursorTo);
        const docs = [];
        for (const scopeKey of scopes) {
          for (const doc of snapshotLib.buildDayDocuments(snapshot, days, scopeKey, facts)) {
            if (!isEmptyDay(doc)) docs.push(doc);
          }
        }
        written += await writeDocs(firestore, businessId, 'dailyStats', docs);
        status.backfill = { running: true, reachedDay: cursorFrom, written };
        cursorTo = periodsLib.addDays(cursorFrom, -1);
        if (options.backfillPauseMs > 0) {
          await new Promise((resolve) => {
            const t = setTimeoutFn(resolve, options.backfillPauseMs);
            t?.unref?.();
          });
        }
      }

      await metaRef.set(clean({
        backfill: {
          version: BACKFILL_VERSION,
          fromDay: target,
          toDay: periodsLib.addDays(windowFrom, -1),
          completedAt: now(),
          written,
        },
      }), { merge: true });
      status.backfill = { done: true, fromDay: target, written };
      logger.log(`[control-center] Histórico diario listo (${written} documentos desde ${target}).`);
    } finally {
      backfillRunning = false;
    }
  }

  /** Ejecuta una publicación ahora (o devuelve la que está en curso). */
  function runOnce({ full = false, reason = '' } = {}) {
    if (inFlight) {
      if (full) fullRequestedAfterRun = true;
      return inFlight;
    }
    if (isKnownOffline()) {
      pendingWhileOffline = true;
      return Promise.resolve({ skipped: 'offline' });
    }
    const startedAt = now().getTime();
    status.lastRunAt = now();
    inFlight = publish({ full })
      .then((result) => {
        status.runs += 1;
        status.lastRunMode = result?.mode || result?.skipped || null;
        status.lastWrites = Number(result?.writes || 0);
        if (!result?.skipped) {
          status.lastSuccessAt = now();
          status.lastError = null;
        }
        return result;
      })
      .catch((error) => {
        status.lastError = String(error?.message || error).slice(0, 300);
        warnOnce(`run:${status.lastError}`, `No se pudo publicar${reason ? ` (${reason})` : ''}: ${status.lastError}`);
        return { error: status.lastError };
      })
      .finally(() => {
        status.lastDurationMs = now().getTime() - startedAt;
        lastRunEndedAt = now().getTime();
        inFlight = null;
        if (fullRequestedAfterRun) {
          fullRequestedAfterRun = false;
          schedule({ full: true });
        }
      });
    return inFlight;
  }

  /** Programa una corrida respetando el espacio mínimo entre publicaciones. */
  function schedule({ full = false, delayMs = options.quickDelayMs } = {}) {
    if (!started) return;
    if (scheduledTimer) {
      if (full) scheduledFull = true;
      return;
    }
    const sinceLast = now().getTime() - lastRunEndedAt;
    const wait = Math.max(delayMs, options.minGapMs - sinceLast, 0);
    scheduledFull = full;
    scheduledTimer = setTimeoutFn(() => {
      const runFull = scheduledFull;
      scheduledTimer = null;
      scheduledFull = false;
      runOnce({ full: runFull, reason: runFull ? 'completa' : 'cambio en el POS' });
    }, wait);
    scheduledTimer?.unref?.();
  }

  /** Avisar que algo cambió en el POS (venta, caja, gasto…). */
  function notifyChange() {
    if (!started) return;
    if (isKnownOffline()) {
      pendingWhileOffline = true;
      return;
    }
    schedule({ full: false });
  }

  function start() {
    if (started) return api;
    started = true;
    status.started = true;
    status.role = isMain() ? 'principal' : 'terminal';

    const first = setTimeoutFn(() => runOnce({ full: true, reason: 'arranque' }), options.firstRunDelayMs);
    first?.unref?.();
    timers.push({ type: 'timeout', id: first });

    const fullTimer = setIntervalFn(() => {
      if (now().getTime() - lastFullAt >= options.fullIntervalMs - 1000) schedule({ full: true, delayMs: 0 });
    }, options.fullIntervalMs);
    fullTimer?.unref?.();
    timers.push({ type: 'interval', id: fullTimer });

    const beatTimer = setIntervalFn(() => {
      if (isKnownOffline()) return;
      if (now().getTime() - lastRunEndedAt < options.heartbeatMs - 1000) return;
      heartbeat(firestoreOrNull()).catch(() => {});
    }, options.heartbeatMs);
    beatTimer?.unref?.();
    timers.push({ type: 'interval', id: beatTimer });

    if (monitor?.on) {
      onConnectivityChange = (online) => {
        if (online && pendingWhileOffline) {
          pendingWhileOffline = false;
          schedule({ full: true });
        }
      };
      monitor.on('change', onConnectivityChange);
    }
    return api;
  }

  function stop() {
    started = false;
    status.started = false;
    for (const t of timers) {
      if (t.type === 'timeout') clearTimeoutFn(t.id);
      else clearIntervalFn(t.id);
    }
    timers = [];
    if (scheduledTimer) clearTimeoutFn(scheduledTimer);
    scheduledTimer = null;
    if (monitor?.off && onConnectivityChange) monitor.off('change', onConnectivityChange);
    onConnectivityChange = null;
  }

  function getStatus() {
    return { ...status, pendingWhileOffline, inFlight: Boolean(inFlight) };
  }

  /** Espera la publicación y el histórico en curso (pruebas y apagado ordenado). */
  async function whenIdle() {
    await Promise.all([inFlight, backfillPromise].filter(Boolean));
  }

  const api = { start, stop, notifyChange, runOnce, getStatus, whenIdle };
  return api;
}

module.exports = { createControlCenterPublisher, clean, stableHash, BACKFILL_VERSION };
