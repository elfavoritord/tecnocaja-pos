'use strict';

/**
 * Firestore en memoria para pruebas de la tienda online (POS y nube).
 *
 * Cubre lo que usan server/tienda-online/nube.js y cloud/tienda-online:
 * rutas con "/", set (con merge profundo), update con rutas de campo
 * ("items.p1.r"), create, delete, where('a.b', '==', x), limit, onSnapshot
 * de consultas, runTransaction (lecturas antes que escrituras, como
 * Firestore real; se ejecutan una a la vez) y FieldValue (increment,
 * serverTimestamp, arrayUnion, delete).
 */

const SENTINEL = '__fakeFieldValue';

const FieldValue = {
  increment: (n) => ({ [SENTINEL]: 'inc', n: Number(n) || 0 }),
  serverTimestamp: () => ({ [SENTINEL]: 'ts' }),
  arrayUnion: (...items) => ({ [SENTINEL]: 'union', items }),
  delete: () => ({ [SENTINEL]: 'del' }),
};

// También entiende los FieldValue reales de firebase-admin (para correr el
// servidor del POS completo contra este Firestore en memoria).
const REAL_TRANSFORMS = {
  NumericIncrementTransform: (v) => ({ [SENTINEL]: 'inc', n: Number(v.operand) || 0 }),
  ServerTimestampTransform: () => ({ [SENTINEL]: 'ts' }),
  ArrayUnionTransform: (v) => ({ [SENTINEL]: 'union', items: v.elements || [] }),
  DeleteTransform: () => ({ [SENTINEL]: 'del' }),
};

function asSentinel(v) {
  if (!v || typeof v !== 'object') return null;
  if (v[SENTINEL]) return v;
  const real = REAL_TRANSFORMS[v.constructor?.name];
  return real ? real(v) : null;
}

function isSentinel(v) {
  return Boolean(asSentinel(v));
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !isSentinel(v);
}

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}

function resolve(current, rawValue) {
  const value = asSentinel(rawValue) || rawValue;
  if (!isSentinel(value)) {
    if (isPlainObject(value)) {
      const out = {};
      for (const [k, x] of Object.entries(value)) {
        const r = resolve(undefined, x);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return clone(value);
  }
  switch (value[SENTINEL]) {
    case 'inc': return (Number(current) || 0) + value.n;
    case 'ts': return new Date();
    case 'union': {
      const list = Array.isArray(current) ? clone(current) : [];
      for (const item of value.items) {
        if (!list.some((x) => JSON.stringify(x) === JSON.stringify(item))) list.push(clone(item));
      }
      return list;
    }
    case 'del': return undefined;
    default: throw new Error(`FieldValue no soportado: ${value[SENTINEL]}`);
  }
}

function deepMerge(target, data) {
  const out = isPlainObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      const r = resolve(out[key], value);
      if (r === undefined) delete out[key];
      else out[key] = r;
    }
  }
  return out;
}

function getField(obj, field) {
  return String(field).split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function setField(obj, field, value) {
  const parts = String(field).split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  const r = resolve(node[last], value);
  if (r === undefined) delete node[last];
  else node[last] = r;
}

function firestoreError(code, message) {
  const error = new Error(`${code} ${message}`);
  error.code = code;
  return error;
}

function createFakeFirestore(seed = {}) {
  const docs = new Map();
  for (const [path, data] of Object.entries(seed)) docs.set(path, clone(data));
  const listeners = new Set();
  let autoId = 0;
  let chain = Promise.resolve();
  let writes = 0;

  function parentOf(path) {
    return path.split('/').slice(0, -1).join('/');
  }

  function snapshot(path) {
    const data = docs.get(path);
    return {
      id: path.split('/').pop(),
      ref: docRef(path),
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : clone(data)),
    };
  }

  function runQuery(q) {
    let ids = [...docs.keys()].filter((p) => parentOf(p) === q.path);
    ids = ids.filter((p) => q.filters.every(({ field, op, value }) => {
      const v = getField(docs.get(p), field);
      if (op === '==') return v === value;
      if (op === '!=') return v !== value;
      if (op === 'in') return value.includes(v);
      if (op === 'array-contains') return Array.isArray(v) && v.includes(value);
      throw new Error(`Operador no soportado: ${op}`);
    }));
    ids.sort();
    if (q.max !== null) ids = ids.slice(0, q.max);
    const list = ids.map(snapshot);
    return { docs: list, empty: list.length === 0, size: list.length };
  }

  function notify(path) {
    const parent = parentOf(path);
    for (const l of listeners) {
      if (l.q.path === parent) {
        try { l.onNext(runQuery(l.q)); } catch (error) { l.onError?.(error); }
      }
    }
  }

  function write(op, path, data, opts = {}) {
    writes += 1;
    const current = docs.get(path);
    if (op === 'set') {
      docs.set(path, opts.merge ? deepMerge(current, data) : deepMerge(undefined, data));
    } else if (op === 'create') {
      if (current !== undefined) throw firestoreError(6, 'ALREADY_EXISTS');
      docs.set(path, deepMerge(undefined, data));
    } else if (op === 'update') {
      if (current === undefined) throw firestoreError(5, 'NOT_FOUND');
      const next = clone(current);
      for (const [field, value] of Object.entries(data)) setField(next, field, value);
      docs.set(path, next);
    } else if (op === 'delete') {
      docs.delete(path);
    }
  }

  function makeQuery(path, filters = [], max = null) {
    const q = { path, filters, max };
    return {
      _q: q,
      where: (field, op, value) => makeQuery(path, [...filters, { field, op, value }], max),
      limit: (n) => makeQuery(path, filters, n),
      orderBy: () => makeQuery(path, filters, max),
      get: async () => runQuery(q),
      onSnapshot(onNext, onError) {
        const l = { q, onNext, onError };
        listeners.add(l);
        setImmediate(() => { if (listeners.has(l)) onNext(runQuery(q)); });
        return () => listeners.delete(l);
      },
    };
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(),
      path,
      get: async () => snapshot(path),
      set: async (data, opts) => { write('set', path, data, opts); notify(path); },
      create: async (data) => { write('create', path, data); notify(path); },
      update: async (data) => { write('update', path, data); notify(path); },
      delete: async () => { write('delete', path); notify(path); },
      collection: (sub) => collectionRef(`${path}/${sub}`),
    };
  }

  function collectionRef(path) {
    return {
      ...makeQuery(path),
      id: path.split('/').pop(),
      path,
      doc: (id) => {
        if (id === undefined) {
          autoId += 1;
          return docRef(`${path}/auto${String(autoId).padStart(6, '0')}`);
        }
        return docRef(`${path}/${id}`);
      },
      add: async (data) => {
        autoId += 1;
        const ref = docRef(`${path}/auto${String(autoId).padStart(6, '0')}`);
        await ref.set(data);
        return ref;
      },
    };
  }

  async function runTransaction(fn) {
    const run = async () => {
      const buffer = [];
      let wrote = false;
      const tx = {
        async get(target) {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          if (target._q) return runQuery(target._q);
          return snapshot(target.path);
        },
        set(ref, data, opts) { wrote = true; buffer.push(['set', ref.path, data, opts]); return tx; },
        create(ref, data) { wrote = true; buffer.push(['create', ref.path, data]); return tx; },
        update(ref, data) { wrote = true; buffer.push(['update', ref.path, data]); return tx; },
        delete(ref) { wrote = true; buffer.push(['delete', ref.path]); return tx; },
      };
      const result = await fn(tx);
      // Validar antes de aplicar: una transacción se aplica completa o nada.
      for (const [op, path] of buffer) {
        if (op === 'update' && !docs.has(path) && !buffer.some(([o, p]) => (o === 'set' || o === 'create') && p === path)) {
          throw firestoreError(5, 'NOT_FOUND');
        }
      }
      const touched = new Set();
      for (const [op, path, data, opts] of buffer) {
        write(op, path, data, opts);
        touched.add(path);
      }
      for (const path of touched) notify(path);
      return result;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return {
    FieldValue,
    doc: docRef,
    collection: collectionRef,
    runTransaction,
    getAll: async (...refs) => refs.map((r) => snapshot(r.path)),
    _docs: docs,
    _get: (path) => (docs.has(path) ? clone(docs.get(path)) : undefined),
    _writes: () => writes,
  };
}

module.exports = { createFakeFirestore, FieldValue };
