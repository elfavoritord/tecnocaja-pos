'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MEDIA = /\.(png|jpe?g|webp|gif|svg|pdf|xml|docx?|xlsx?|csv|txt)$/i;
function defaultComponents() {
  const root = process.env.TECNO_CAJA_USER_DATA || path.join(process.env.TECNO_CAJA_APP_ROOT || process.cwd(), 'runtime-data');
  return [
    { id: 'productos', root: process.env.PRODUCT_UPLOAD_DIR || path.join(root, 'uploads', 'productos') },
    { id: 'comprobantes', root: process.env.TREASURY_ATTACHMENTS_DIR || path.join(root, 'uploads', 'comprobantes') },
    { id: 'fiscales', root: process.env.FISCAL_ATTACHMENTS_DIR || path.join(root, 'uploads', 'comprobantes-fiscales') },
    { id: 'documentos', root: path.join(root, 'Sistema_Data') },
    { id: 'ecf-archivos', root: path.join(root, 'storage', 'ecf'), jsonFiles: ['cert-wizard-state.json', 'cert-wizard-state.json.bak'] },
    { id: 'ecf-trabajo', root: path.join(root, 'ecf') },
    { id: 'fiscal-control', root, files: ['ecf-sequence-high-watermarks.json'] },
  ];
}
function rutaSegura(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\x00:]/.test(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/).some((p) => p === '..' || !p)) throw new Error('Ruta insegura en el respaldo.');
  const base = path.resolve(root), destino = path.resolve(base, relative);
  if (!destino.startsWith(base + path.sep)) throw new Error('El archivo sale del directorio autorizado.');
  let actual = base;
  if (fs.existsSync(actual) && fs.lstatSync(actual).isSymbolicLink()) throw new Error('No se admiten enlaces simbólicos en la recuperación.');
  for (const parte of path.relative(base, destino).split(path.sep)) {
    actual = path.join(actual, parte);
    if (fs.existsSync(actual) && fs.lstatSync(actual).isSymbolicLink()) throw new Error('El respaldo intenta atravesar un enlace simbólico.');
  }
  return destino;
}
async function capturar({ components = defaultComponents(), maxBytes = 256 * 1024 * 1024 } = {}) {
  const archivos = [], componentes = [], requiereReconfiguracion = []; let total = 0;
  for (const c of components) {
    if (!/^[a-z0-9_-]+$/i.test(c.id)) throw new Error('Componente inválido.');
    componentes.push({ id: c.id, sourceRoot: path.resolve(c.root) });
    if (!fs.existsSync(c.root)) continue;
    async function recorrer(dir) {
      for (const entrada of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (c.files && !c.files.includes(entrada.name)) continue;
        const file = path.join(dir, entrada.name), relative = path.relative(c.root, file).split(path.sep).join('/');
        if (entrada.isSymbolicLink()) throw new Error(`Enlace no respaldable en ${c.id}.`);
        if (entrada.isDirectory()) { if (!/^(certificates|node_modules|backups)$/i.test(entrada.name)) await recorrer(file); else if (/certificates/i.test(entrada.name)) requiereReconfiguracion.push(`${c.id}:certificado`); continue; }
        if (!MEDIA.test(entrada.name) && !c.files?.includes(entrada.name) && !c.jsonFiles?.includes(relative)) {
          if (/\.(p12|pfx|pem|key)$/i.test(entrada.name)) requiereReconfiguracion.push(`${c.id}:certificado`);
          continue;
        }
        rutaSegura(c.root, relative);
        const antes = await fs.promises.stat(file);
        total += antes.size;
        if (total > maxBytes) throw new Error('Los adjuntos superan el límite de este paquete. Configura un componente de respaldo dedicado.');
        const bytes = await fs.promises.readFile(file), despues = await fs.promises.stat(file);
        if (antes.size !== despues.size || antes.mtimeMs !== despues.mtimeMs) throw new Error('Un archivo cambió durante el respaldo; vuelve a intentarlo.');
        archivos.push({ component: c.id, path: relative, size: bytes.length, sha256: hash(bytes), content: bytes.toString('base64') });
      }
    }
    await recorrer(c.root);
  }
  return { componentes, archivos, requiereReconfiguracion, totalBytes: total };
}
function validar(artifact, components = defaultComponents()) {
  if (!artifact) return [];
  if (!Array.isArray(artifact.archivos) || !Array.isArray(artifact.componentes)) throw new Error('Manifiesto de archivos inválido.');
  const roots = new Map(components.map((c) => [c.id, c.root])), ids = new Set(); let total = 0;
  return artifact.archivos.map((a) => {
    if (!roots.has(a.component)) throw new Error(`Falta el componente ${a.component}.`);
    const definition = components.find((c) => c.id === a.component);
    if (definition.files && !definition.files.includes(a.path)) throw new Error('Archivo fuera de la lista autorizada del componente.');
    const destino = rutaSegura(roots.get(a.component), a.path), key = destino.toLowerCase();
    if (ids.has(key)) throw new Error('Ruta de archivo duplicada.'); ids.add(key);
    if (typeof a.content !== 'string' || a.content.length > 360 * 1024 * 1024) throw new Error('Archivo demasiado grande.');
    const bytes = Buffer.from(a.content, 'base64');
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('El paquete excede el límite de adjuntos.');
    if (bytes.length !== a.size || hash(bytes) !== a.sha256) throw new Error(`Archivo corrupto en ${a.component}.`);
    return { destino, bytes, component: a.component };
  });
}
async function preparar(artifact, options = {}) {
  const archivos = validar(artifact, options.components), id = crypto.randomUUID(), acciones = [];
  async function revertir() {
    for (const a of [...acciones].reverse()) {
      if (a.aplicado && fs.existsSync(a.destino)) await fs.promises.unlink(a.destino);
      if (a.resguardado && fs.existsSync(a.anterior)) await fs.promises.rename(a.anterior, a.destino);
      if (fs.existsSync(a.temporal)) await fs.promises.unlink(a.temporal);
    }
  }
  try {
    for (const a of archivos) {
      // El contador de e-NCF utilizados nunca retrocede al recuperar un corte viejo.
      if (a.component === 'fiscal-control' && fs.existsSync(a.destino)) {
        const saved = JSON.parse(a.bytes.toString('utf8'));
        const current = JSON.parse(await fs.promises.readFile(a.destino, 'utf8'));
        saved.environments ||= {};
        for (const [env, state] of Object.entries(current.environments || {})) {
          const restored = saved.environments[env] || { ...state, maxima: {} };
          restored.maxima ||= {};
          for (const [type, value] of Object.entries(state.maxima || {})) restored.maxima[type] = Math.max(Number(value) || 0, Number(restored.maxima[type]) || 0);
          saved.environments[env] = restored;
        }
        a.bytes = Buffer.from(JSON.stringify(saved));
      }
      await fs.promises.mkdir(path.dirname(a.destino), { recursive: true });
      const accion = { destino: a.destino, temporal: a.destino + '.tcbak-stage-' + id, anterior: a.destino + '.tcbak-previous-' + id, aplicado: false, resguardado: false };
      acciones.push(accion);
      await fs.promises.writeFile(accion.temporal, a.bytes, { flag: 'wx' });
      const h = await fs.promises.open(accion.temporal, 'r+'); try { await h.sync(); } finally { await h.close(); }
    }
  } catch (e) { await revertir(); throw e; }
  return {
    commit: async () => { for (const a of acciones) {
      if (fs.existsSync(a.destino)) { await fs.promises.rename(a.destino, a.anterior); a.resguardado = true; }
      await fs.promises.rename(a.temporal, a.destino); a.aplicado = true;
    } },
    revertir,
    terminar: async () => { for (const a of acciones) if (a.resguardado && fs.existsSync(a.anterior)) await fs.promises.unlink(a.anterior); },
  };
}
module.exports = { defaultComponents, capturar, validar, preparar, rutaSegura };
