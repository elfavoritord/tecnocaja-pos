'use strict';

/**
 * assistant.routes.js — Tecno Asistente + Centro de Ayuda (Fase 1).
 * Factory pattern con inyección de dependencias.
 *
 * Rutas:
 *  GET    /api/assistant/articles?module=&planCode=&businessType=
 *  POST   /api/assistant/ask            { question, module, planCode, businessType }
 *  POST   /api/assistant/escalate       { transcript, module, contactInfo }
 *  GET    /api/assistant/escalations    (solo administrador_general)
 */

const express = require('express');
const knowledge = require('../services/assistant-knowledge.service');
const { answerQuestion } = require('../services/assistant.service');

const SEED_ARTICLES = [
  {
    slug: 'abrir-cerrar-caja',
    module: 'caja',
    title: 'Cómo abrir y cerrar caja',
    keywords: 'abrir caja, cerrar caja, corte, turno, monto inicial, arqueo',
    content:
      'Para empezar a vender necesitas abrir caja desde el módulo Caja, indicando el ' +
      'monto inicial con el que arrancas el turno. Al terminar el turno, usa "Cerrar ' +
      'caja" para hacer el corte: el sistema compara lo esperado (según ventas e ' +
      'ingresos/egresos registrados) contra el monto real contado. Si la conexión con ' +
      'la PC principal se pierde a mitad de turno, la caja sigue funcionando en modo ' +
      'local y se sincroniza sola cuando vuelve la conexión.',
    uiModule: 'caja',
    uiSelector: '#btn-caja-action',
  },
  {
    slug: 'buscar-y-vender-productos',
    module: 'ventas',
    title: 'Buscar productos y registrar una venta',
    keywords: 'vender, venta, buscador, escanear, codigo de barras, carrito',
    content:
      'En el módulo Ventas, usa el buscador de productos (por nombre o escaneando el ' +
      'código de barras) para agregarlos al carrito. Si escaneas varios códigos muy ' +
      'rápido, deja que el sistema procese cada uno antes de escanear el siguiente para ' +
      'evitar que se agregue un producto equivocado. Al finalizar, selecciona el método ' +
      'de pago y confirma para generar el comprobante.',
    uiModule: 'ventas',
    uiSelector: '#product-search',
  },
  {
    slug: 'clientes-credito-fiado',
    module: 'clientes',
    title: 'Vender a crédito (fiado) y cobrar después',
    keywords: 'credito, fiado, cliente, deuda, abono, pago pendiente',
    content:
      'Para vender a crédito, el cliente debe estar registrado en el módulo Clientes. ' +
      'Al facturar, elige el método de pago "Crédito" — la venta queda asociada a ese ' +
      'cliente como deuda pendiente. Para cobrar después, entra al perfil del cliente en ' +
      'Clientes, revisa sus facturas a crédito y registra el abono o pago recibido.',
  },
  {
    slug: 'anular-devolver-venta',
    module: 'ventas',
    title: 'Anular una venta o procesar una devolución',
    keywords: 'anular, devolucion, cancelar venta, reembolso',
    content:
      'Para anular una venta completa, búscala por número de factura y usa la opción de ' +
      'anular — esto revierte el inventario y el monto de caja asociados. Para una ' +
      'devolución parcial (solo algunos productos de la factura), usa la opción de ' +
      'devolución, busca la factura original y selecciona qué productos y cantidades se ' +
      'devuelven. Ambas acciones normalmente requieren permiso de supervisor o ' +
      'administrador.',
  },
  {
    slug: 'agregar-importar-productos',
    module: 'productos',
    title: 'Agregar productos nuevos o importarlos desde Excel/CSV',
    keywords: 'producto nuevo, importar, csv, excel, catalogo, inventario inicial',
    content:
      'Puedes crear productos uno por uno desde el módulo Productos, o importar un ' +
      'catálogo completo desde un archivo CSV (por ejemplo exportado de Excel). Si ' +
      'importas un CSV grande y el sistema rechaza algunas filas, revisa el mensaje de ' +
      'error — indica fila por fila cuál es el problema (por ejemplo, una sucursal que no ' +
      'existe o un precio inválido) para poder corregirlo antes de reintentar.',
    uiModule: 'productos',
    uiSelector: '#btn-products-new',
  },
  {
    slug: 'compras-proveedores',
    module: 'compras',
    title: 'Registrar una compra a un proveedor',
    keywords: 'compra, proveedor, factura de compra, gasto, cuentas por pagar',
    content:
      'En el módulo Compras y Gastos puedes registrar una compra eligiendo un proveedor ' +
      'ya existente, o crear uno nuevo directamente desde el mismo formulario si todavía ' +
      'no está en tu lista de proveedores. Si la compra es de contado, el pago se ' +
      'registra automáticamente; si es a crédito, queda en cuentas por pagar hasta que la ' +
      'saldes.',
  },
  {
    slug: 'comprobantes-fiscales-ncf',
    module: 'configuracion',
    title: 'Comprobantes fiscales (NCF) y facturación electrónica',
    keywords: 'ncf, comprobante fiscal, dgii, factura fiscal, e-cf',
    content:
      'Los NCF (Números de Comprobante Fiscal) se configuran en Configuración, dentro de ' +
      'la sección de Ventas y Facturación. Ahí se cargan las secuencias autorizadas por la ' +
      'DGII para cada tipo de comprobante. La facturación electrónica (e-CF) tiene su ' +
      'propia sección de configuración fiscal, con su propio estado de certificación y ' +
      'ambiente (pruebas/producción).',
  },
  {
    slug: 'modo-offline-sin-conexion',
    module: null,
    title: 'Qué pasa si se pierde la conexión con la PC principal',
    keywords: 'offline, sin conexion, sin internet, pc principal, sincronizar, sucursal',
    content:
      'Si esta terminal no puede comunicarse con la PC principal (por red o porque está ' +
      'apagada), Tecno Caja sigue funcionando en modo local para las operaciones más ' +
      'importantes: abrir/cerrar caja, vender, y registrar clientes o productos básicos. ' +
      'Esos datos quedan guardados localmente y se sincronizan solos con la base de datos ' +
      'principal en cuanto la conexión vuelve. Algunos módulos que dependen de internet ' +
      '(por ejemplo integraciones en la nube) no están disponibles mientras dure la ' +
      'desconexión.',
  },
];

// Fase 2 — tutoriales guiados paso a paso ("muéstrame dónde" encadenado).
// Selectores verificados contra index.html real — nav items por data-module,
// más 3 controles concretos: #btn-caja-action, #product-search, #btn-products-new.
// Deliberadamente solo requieren cambiar de módulo (nada de abrir modales
// intermedios) — mantiene el motor de resaltado simple para esta fase.
const SEED_TUTORIALS = [
  {
    slug: 'tutorial-abrir-caja',
    title: 'Cómo abrir caja',
    description: 'Guía paso a paso para abrir caja al empezar tu turno.',
    module: 'caja',
    steps: [
      { module: 'caja', selector: '[data-module="caja"]', text: 'Entra al módulo Caja desde el menú lateral.' },
      { module: 'caja', selector: '#btn-caja-action', text: 'Presiona este botón para abrir caja e indica el monto inicial con el que arrancas el turno.' },
    ],
  },
  {
    slug: 'tutorial-vender-producto',
    title: 'Cómo hacer una venta',
    description: 'Guía paso a paso para buscar un producto y cobrarlo.',
    module: 'ventas',
    steps: [
      { module: 'ventas', selector: '[data-module="ventas"]', text: 'Entra al módulo Ventas desde el menú lateral.' },
      { module: 'ventas', selector: '#product-search', text: 'Busca el producto aquí, por nombre o escaneando el código de barras, y agrégalo al carrito.' },
    ],
  },
  {
    slug: 'tutorial-agregar-producto',
    title: 'Cómo agregar un producto nuevo',
    description: 'Guía paso a paso para crear un producto en tu catálogo.',
    module: 'productos',
    steps: [
      { module: 'productos', selector: '[data-module="productos"]', text: 'Entra al módulo Productos desde el menú lateral.' },
      { module: 'productos', selector: '#btn-products-new', text: 'Presiona este botón para crear un producto nuevo.' },
    ],
  },
];

async function ensureSchema(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS assistant_kb_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug VARCHAR(120) NOT NULL UNIQUE,
      module VARCHAR(60) DEFAULT NULL,
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT DEFAULT NULL,
      role_scope TEXT DEFAULT NULL,
      plan_scope VARCHAR(20) NOT NULL DEFAULT 'basico',
      business_types TEXT DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Columnas de Fase 2 ("muéstrame dónde") sobre una tabla que ya pudo existir
  // desde la Fase 1 — ALTER TABLE con catch individual, mismo patrón que
  // modules/plans.js#ensurePlanExtensions (no todos los motores soportan
  // ADD COLUMN IF NOT EXISTS de forma portable).
  await query(`ALTER TABLE assistant_kb_articles ADD COLUMN ui_module VARCHAR(60) DEFAULT NULL`).catch(() => {});
  await query(`ALTER TABLE assistant_kb_articles ADD COLUMN ui_selector VARCHAR(300) DEFAULT NULL`).catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS assistant_questions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      module VARCHAR(60) DEFAULT NULL,
      user_role VARCHAR(60) DEFAULT NULL,
      matched_article_id INT DEFAULT NULL,
      had_answer TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS assistant_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript TEXT NOT NULL,
      module VARCHAR(60) DEFAULT NULL,
      user_role VARCHAR(60) DEFAULT NULL,
      contact_info VARCHAR(200) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // role_scope/plan_scope/business_types con los mismos nombres que
  // assistant_kb_articles a propósito — así articleAppliesToUser() del
  // servicio de conocimiento sirve igual para filtrar tutoriales.
  await query(`
    CREATE TABLE IF NOT EXISTS assistant_tutorials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug VARCHAR(120) NOT NULL UNIQUE,
      title VARCHAR(200) NOT NULL,
      description VARCHAR(300) DEFAULT NULL,
      module VARCHAR(60) DEFAULT NULL,
      role_scope TEXT DEFAULT NULL,
      plan_scope VARCHAR(20) NOT NULL DEFAULT 'basico',
      business_types TEXT DEFAULT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS assistant_tutorial_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tutorial_id INT NOT NULL,
      step_order INT NOT NULL,
      module VARCHAR(60) DEFAULT NULL,
      selector VARCHAR(300) NOT NULL,
      text VARCHAR(500) NOT NULL,
      CONSTRAINT fk_ats_tutorial FOREIGN KEY (tutorial_id) REFERENCES assistant_tutorials(id) ON DELETE CASCADE
    )
  `);
  await seedInitialArticles(query);
  await seedInitialTutorials(query);
}

async function seedInitialArticles(query) {
  try {
    const rows = await query('SELECT COUNT(*) as c FROM assistant_kb_articles');
    if (Number(rows[0]?.c || 0) > 0) return;
    for (const article of SEED_ARTICLES) {
      await query(
        `INSERT INTO assistant_kb_articles (slug, module, title, content, keywords, ui_module, ui_selector)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          article.slug, article.module, article.title, article.content, article.keywords,
          article.uiModule || null, article.uiSelector || null,
        ]
      ).catch(() => {}); // UNIQUE(slug) — si ya existe uno, seguir con el resto
    }
    console.log(`[assistant] Base de conocimiento inicial cargada (${SEED_ARTICLES.length} artículos).`);
  } catch (e) {
    console.warn('[assistant] No se pudo cargar la base de conocimiento inicial:', e.message);
  }
}

async function seedInitialTutorials(query) {
  try {
    const rows = await query('SELECT COUNT(*) as c FROM assistant_tutorials');
    if (Number(rows[0]?.c || 0) > 0) return;
    for (const tutorial of SEED_TUTORIALS) {
      const { insertId } = await query(
        `INSERT INTO assistant_tutorials (slug, title, description, module) VALUES (?, ?, ?, ?)`,
        [tutorial.slug, tutorial.title, tutorial.description, tutorial.module]
      );
      let order = 1;
      for (const step of tutorial.steps) {
        await query(
          `INSERT INTO assistant_tutorial_steps (tutorial_id, step_order, module, selector, text) VALUES (?, ?, ?, ?, ?)`,
          [insertId, order++, step.module, step.selector, step.text]
        );
      }
    }
    console.log(`[assistant] Tutoriales guiados iniciales cargados (${SEED_TUTORIALS.length}).`);
  } catch (e) {
    console.warn('[assistant] No se pudieron cargar los tutoriales iniciales:', e.message);
  }
}

function createAssistantRouter({ query, resolveRequestActorUser, userRoleHasPermission, assistantLimiter }) {
  const router = express.Router();
  const limiter = assistantLimiter || ((_req, _res, next) => next());

  function roleCodeOf(actor) {
    return String(actor?.role_code || actor?.rol || '').trim().toLowerCase();
  }
  function isAdminGeneral(actor) {
    return roleCodeOf(actor) === 'administrador_general';
  }

  async function requireAuth(req, res, next) {
    try {
      req.authUser = await resolveRequestActorUser(req, { required: true, allowPayloadFallback: true });
      next();
    } catch (e) {
      res.status(401).json({ error: e.message || 'Sesión inválida o expirada.' });
    }
  }

  router.use(requireAuth);

  function readContext(req) {
    const source = req.method === 'GET' ? req.query : req.body || {};
    return {
      roleCode: roleCodeOf(req.authUser),
      planCode: String(source.planCode || 'basico').toLowerCase(),
      businessType: source.businessType || null,
    };
  }

  router.get('/articles', async (req, res) => {
    try {
      await ensureSchema(query);
      const ctx = readContext(req);
      const articles = await knowledge.listArticles(query, { module: req.query.module || null, ...ctx });
      res.json({
        articles: articles.map((a) => ({
          id: a.id, slug: a.slug, module: a.module, title: a.title, content: a.content,
          uiModule: a.ui_module || null, uiSelector: a.ui_selector || null,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/tutorials', async (req, res) => {
    try {
      await ensureSchema(query);
      const ctx = readContext(req);
      const rows = await query('SELECT * FROM assistant_tutorials WHERE is_active = 1');
      const applicable = rows.filter((t) => knowledge.articleAppliesToUser(t, ctx));
      res.json({
        tutorials: applicable.map((t) => ({ id: t.id, slug: t.slug, title: t.title, description: t.description, module: t.module })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/tutorials/:slug', async (req, res) => {
    try {
      await ensureSchema(query);
      const ctx = readContext(req);
      const [tutorial] = await query('SELECT * FROM assistant_tutorials WHERE slug = ? AND is_active = 1', [req.params.slug]);
      if (!tutorial) return res.status(404).json({ error: 'Tutorial no encontrado.' });
      if (!knowledge.articleAppliesToUser(tutorial, ctx)) {
        return res.status(403).json({ error: 'Este tutorial no está disponible para tu rol o plan actual.' });
      }
      const steps = await query(
        'SELECT * FROM assistant_tutorial_steps WHERE tutorial_id = ? ORDER BY step_order ASC',
        [tutorial.id]
      );
      res.json({
        id: tutorial.id,
        slug: tutorial.slug,
        title: tutorial.title,
        description: tutorial.description,
        module: tutorial.module,
        steps: steps.map((s) => ({ module: s.module, selector: s.selector, text: s.text })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/ask', limiter, async (req, res) => {
    try {
      await ensureSchema(query);
      const question = String(req.body?.question || '').trim();
      if (!question) return res.status(400).json({ error: 'La pregunta es requerida.' });
      if (question.length > 500) return res.status(400).json({ error: 'Pregunta demasiado larga (máximo 500 caracteres).' });

      const ctx = readContext(req);
      const result = await answerQuestion(query, { question, module: req.body?.module || null, ...ctx });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/escalate', limiter, async (req, res) => {
    try {
      await ensureSchema(query);
      const transcript = String(req.body?.transcript || '').trim();
      if (!transcript) return res.status(400).json({ error: 'transcript es requerido.' });

      const { insertId } = await query(
        `INSERT INTO assistant_escalations (transcript, module, user_role, contact_info, status)
         VALUES (?, ?, ?, ?, 'pendiente')`,
        [
          transcript.slice(0, 4000),
          req.body?.module || null,
          roleCodeOf(req.authUser) || null,
          req.body?.contactInfo ? String(req.body.contactInfo).slice(0, 200) : null,
        ]
      );
      res.status(201).json({ ok: true, id: insertId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/escalations', async (req, res) => {
    try {
      await ensureSchema(query);
      const actor = req.authUser;
      const allowed = isAdminGeneral(actor)
        || (typeof userRoleHasPermission === 'function' && userRoleHasPermission(actor, 'asistente.ver_escalaciones'));
      if (!allowed) return res.status(403).json({ error: 'No tienes permiso para ver esto.' });

      const escalations = await query('SELECT * FROM assistant_escalations ORDER BY created_at DESC LIMIT 100');
      const unanswered = await query(
        `SELECT question, module, COUNT(*) as veces FROM assistant_questions_log
         WHERE had_answer = 0 GROUP BY question, module ORDER BY veces DESC LIMIT 20`
      );
      res.json({ escalations, unanswered });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAssistantRouter, ensureSchema };
