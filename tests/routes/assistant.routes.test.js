'use strict';

/**
 * tests/routes/assistant.routes.test.js
 *
 * Verifica los endpoints del Tecno Asistente / Centro de Ayuda: validaciones
 * básicas, degradación sin proveedor de IA configurado, y el guard de admin
 * en /escalations.
 */

const express = require('express');
const request = require('supertest');

const SEED_ARTICLE_ROW = {
  id: 1,
  slug: 'abrir-cerrar-caja',
  module: 'caja',
  title: 'Cómo abrir y cerrar caja',
  content: 'Para abrir caja entra al módulo Caja y registra el monto inicial.',
  keywords: 'abrir caja, cerrar caja, turno',
  role_scope: null,
  plan_scope: 'basico',
  business_types: null,
  is_active: 1,
  ui_module: 'caja',
  ui_selector: '#btn-caja-action',
};

const SEED_TUTORIAL_ROW = {
  id: 1,
  slug: 'tutorial-abrir-caja',
  title: 'Cómo abrir caja',
  description: 'Guía paso a paso para abrir caja al empezar tu turno.',
  module: 'caja',
  role_scope: null,
  plan_scope: 'basico',
  business_types: null,
  is_active: 1,
};

const SEED_TUTORIAL_STEPS = [
  { id: 1, tutorial_id: 1, step_order: 1, module: 'caja', selector: '[data-module="caja"]', text: 'Entra al módulo Caja.' },
  { id: 2, tutorial_id: 1, step_order: 2, module: 'caja', selector: '#btn-caja-action', text: 'Presiona este botón.' },
];

function buildMockQuery({
  articles = [SEED_ARTICLE_ROW], aiConfigRows = [],
  tutorials = [SEED_TUTORIAL_ROW], tutorialSteps = SEED_TUTORIAL_STEPS,
} = {}) {
  return jest.fn(async (sql, params) => {
    if (/^\s*CREATE TABLE/i.test(sql)) return {};
    if (/SELECT COUNT\(\*\) as c FROM assistant_kb_articles/i.test(sql)) return [{ c: 1 }]; // ya "sembrado"
    if (/INSERT INTO assistant_kb_articles/i.test(sql)) return { insertId: 1 };
    if (/SELECT \* FROM assistant_kb_articles WHERE is_active = 1/i.test(sql)) return articles;
    if (/SELECT COUNT\(\*\) as c FROM assistant_tutorials/i.test(sql)) return [{ c: 1 }]; // ya "sembrado"
    if (/SELECT \* FROM assistant_tutorials WHERE slug = \? AND is_active = 1/i.test(sql)) {
      return tutorials.filter((t) => t.slug === params[0]);
    }
    if (/SELECT \* FROM assistant_tutorials WHERE is_active = 1/i.test(sql)) return tutorials;
    if (/SELECT \* FROM assistant_tutorial_steps WHERE tutorial_id = \?/i.test(sql)) {
      return tutorialSteps.filter((s) => s.tutorial_id === params[0]).sort((a, b) => a.step_order - b.step_order);
    }
    if (/FROM offline_cache_config/i.test(sql)) return aiConfigRows; // sin IA configurada por defecto
    if (/INSERT INTO assistant_questions_log/i.test(sql)) return {};
    if (/INSERT INTO assistant_escalations/i.test(sql)) return { insertId: 42 };
    if (/SELECT \* FROM assistant_escalations/i.test(sql)) return [{ id: 42, transcript: 'x', status: 'pendiente' }];
    if (/SELECT question, module, COUNT/i.test(sql)) return [];
    return [];
  });
}

function buildApp({ query, actor } = {}) {
  const { createAssistantRouter } = require('../../server/routes/assistant.routes');
  const mockQuery = query || buildMockQuery();
  const resolveRequestActorUser = jest.fn().mockResolvedValue(
    actor || { id: 1, usuario: 'cajero1', role_code: 'cajero' }
  );
  const userRoleHasPermission = jest.fn().mockReturnValue(false);

  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantRouter({
    query: mockQuery, resolveRequestActorUser, userRoleHasPermission,
  }));
  return { app, mockQuery, resolveRequestActorUser, userRoleHasPermission };
}

describe('assistant.routes', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('GET /api/assistant/articles', () => {
    it('devuelve los artículos activos aplicables al usuario', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/assistant/articles');
      expect(res.status).toBe(200);
      expect(res.body.articles).toHaveLength(1);
      expect(res.body.articles[0].slug).toBe('abrir-cerrar-caja');
    });

    it('incluye uiModule/uiSelector para "muéstrame dónde"', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/assistant/articles');
      expect(res.body.articles[0].uiModule).toBe('caja');
      expect(res.body.articles[0].uiSelector).toBe('#btn-caja-action');
    });
  });

  describe('GET /api/assistant/tutorials', () => {
    it('devuelve los tutoriales activos aplicables al usuario', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/assistant/tutorials');
      expect(res.status).toBe(200);
      expect(res.body.tutorials).toHaveLength(1);
      expect(res.body.tutorials[0].slug).toBe('tutorial-abrir-caja');
    });

    it('filtra tutoriales fuera de alcance por rol', async () => {
      const restringido = { ...SEED_TUTORIAL_ROW, role_scope: JSON.stringify(['administrador_general']) };
      const { app } = buildApp({ query: buildMockQuery({ tutorials: [restringido] }), actor: { id: 1, role_code: 'cajero' } });
      const res = await request(app).get('/api/assistant/tutorials');
      expect(res.body.tutorials).toHaveLength(0);
    });
  });

  describe('GET /api/assistant/tutorials/:slug', () => {
    it('devuelve 404 si el tutorial no existe', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/assistant/tutorials/no-existe');
      expect(res.status).toBe(404);
    });

    it('devuelve el tutorial con sus pasos en orden', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/api/assistant/tutorials/tutorial-abrir-caja');
      expect(res.status).toBe(200);
      expect(res.body.steps).toHaveLength(2);
      expect(res.body.steps[0].selector).toBe('[data-module="caja"]');
      expect(res.body.steps[1].selector).toBe('#btn-caja-action');
    });

    it('devuelve 403 si el tutorial no aplica al rol del usuario', async () => {
      const restringido = { ...SEED_TUTORIAL_ROW, role_scope: JSON.stringify(['administrador_general']) };
      const { app } = buildApp({
        query: buildMockQuery({ tutorials: [restringido] }),
        actor: { id: 1, role_code: 'cajero' },
      });
      const res = await request(app).get('/api/assistant/tutorials/tutorial-abrir-caja');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/assistant/ask', () => {
    it('devuelve 400 si falta la pregunta', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/assistant/ask').send({});
      expect(res.status).toBe(400);
    });

    it('devuelve 400 si la pregunta es demasiado larga', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/assistant/ask').send({ question: 'x'.repeat(501) });
      expect(res.status).toBe(400);
    });

    it('sin artículos relevantes, responde que no sabe y no ofrece IA', async () => {
      const { app } = buildApp({ query: buildMockQuery({ articles: [] }) });
      const res = await request(app).post('/api/assistant/ask').send({ question: 'algo totalmente fuera de tema' });
      expect(res.status).toBe(200);
      expect(res.body.aiGenerated).toBe(false);
      expect(res.body.sources).toEqual([]);
    });

    it('con artículo relevante pero sin IA configurada, degrada al contenido del artículo', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/assistant/ask').send({ question: '¿cómo abro la caja?', module: 'caja' });
      expect(res.status).toBe(200);
      expect(res.body.aiGenerated).toBe(false);
      expect(res.body.aiAvailable).toBe(false);
      expect(res.body.answer).toBe(SEED_ARTICLE_ROW.content);
      expect(res.body.sources[0].slug).toBe('abrir-cerrar-caja');
    });
  });

  describe('POST /api/assistant/escalate', () => {
    it('devuelve 400 si falta el transcript', async () => {
      const { app } = buildApp();
      const res = await request(app).post('/api/assistant/escalate').send({});
      expect(res.status).toBe(400);
    });

    it('crea la escalación cuando hay transcript', async () => {
      const { app, mockQuery } = buildApp();
      const res = await request(app).post('/api/assistant/escalate').send({
        transcript: 'Usuario: hola\nAsistente: no se',
        module: 'caja',
      });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBe(42);
      const insertCall = mockQuery.mock.calls.find(([sql]) => /INSERT INTO assistant_escalations/i.test(sql));
      expect(insertCall).toBeDefined();
    });

    it('nunca inserta campos fuera de la lista blanca (transcript/module/rol/contacto)', async () => {
      const { app, mockQuery } = buildApp();
      await request(app).post('/api/assistant/escalate').send({
        transcript: 'Usuario: hola',
        module: 'caja',
        contactInfo: '8090000000',
        // Campos que NO deberían poder colarse en el INSERT:
        apiKey: 'secreto-no-deberia-guardarse',
        password: 'tampoco-esto',
      });
      const insertCall = mockQuery.mock.calls.find(([sql]) => /INSERT INTO assistant_escalations/i.test(sql));
      const insertedValues = insertCall[1];
      expect(insertedValues).toEqual(['Usuario: hola', 'caja', 'cajero', '8090000000']);
      expect(JSON.stringify(insertedValues)).not.toMatch(/secreto-no-deberia-guardarse|tampoco-esto/);
    });
  });

  describe('GET /api/assistant/escalations', () => {
    it('devuelve 403 para un rol sin permiso', async () => {
      const { app } = buildApp({ actor: { id: 2, usuario: 'cajero1', role_code: 'cajero' } });
      const res = await request(app).get('/api/assistant/escalations');
      expect(res.status).toBe(403);
    });

    it('permite el acceso a administrador_general', async () => {
      const { app } = buildApp({ actor: { id: 1, usuario: 'admin', role_code: 'administrador_general' } });
      const res = await request(app).get('/api/assistant/escalations');
      expect(res.status).toBe(200);
      expect(res.body.escalations).toHaveLength(1);
    });

    it('permite el acceso si userRoleHasPermission lo autoriza aunque el rol no sea admin', async () => {
      const { app, userRoleHasPermission } = buildApp({ actor: { id: 3, usuario: 'sup1', role_code: 'supervisor' } });
      userRoleHasPermission.mockReturnValue(true);
      const res = await request(app).get('/api/assistant/escalations');
      expect(res.status).toBe(200);
    });
  });
});
