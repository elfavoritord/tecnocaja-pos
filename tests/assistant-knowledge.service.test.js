'use strict';

const {
  tokenize,
  scoreArticle,
  articleAppliesToUser,
  searchArticles,
  listArticles,
} = require('../server/services/assistant-knowledge.service');

function makeArticle(overrides = {}) {
  return {
    id: 1,
    slug: 'articulo-1',
    module: 'caja',
    title: 'Cómo abrir caja',
    content: 'Para abrir caja entra al módulo Caja y registra el monto inicial.',
    keywords: 'abrir caja, turno, monto inicial',
    role_scope: null,
    plan_scope: 'basico',
    business_types: null,
    is_active: 1,
    ...overrides,
  };
}

describe('assistant-knowledge.service — tokenize/score', () => {
  test('tokenize quita acentos y descarta palabras muy cortas', () => {
    expect(tokenize('¿Cómo anulo una devolución?')).toEqual(['como', 'anulo', 'una', 'devolucion']);
  });

  test('scoreArticle puntúa más alto el artículo cuyas keywords coinciden', () => {
    const relevante = makeArticle();
    const irrelevante = makeArticle({
      id: 2,
      title: 'Registrar una compra a proveedor',
      content: 'Ve a Compras y Gastos para registrar una compra nueva.',
      keywords: 'compra, proveedor, factura de compra',
    });
    const questionTokens = tokenize('¿cómo abro la caja?');
    const scoreRelevante = scoreArticle(relevante, questionTokens, null);
    const scoreIrrelevante = scoreArticle(irrelevante, questionTokens, null);
    expect(scoreRelevante).toBeGreaterThan(scoreIrrelevante);
    expect(scoreIrrelevante).toBe(0);
  });

  test('scoreArticle suma puntos extra cuando el módulo actual coincide', () => {
    const article = makeArticle({ title: 'Artículo genérico', keywords: '', content: 'contenido neutro' });
    const questionTokens = tokenize('algo');
    const sinModulo = scoreArticle(article, questionTokens, null);
    const conModulo = scoreArticle(article, questionTokens, 'caja');
    expect(conModulo).toBeGreaterThan(sinModulo);
  });
});

describe('assistant-knowledge.service — articleAppliesToUser (filtrado rol/plan/tipo de negocio)', () => {
  test('artículo sin restricciones aplica a cualquier usuario', () => {
    const article = makeArticle();
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'basico', businessType: 'colmado' })).toBe(true);
  });

  test('excluye por rol cuando role_scope no incluye el rol actual', () => {
    const article = makeArticle({ role_scope: JSON.stringify(['administrador_general']) });
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'basico', businessType: null })).toBe(false);
    expect(articleAppliesToUser(article, { roleCode: 'administrador_general', planCode: 'basico', businessType: null })).toBe(true);
  });

  test('excluye por plan cuando el plan actual no alcanza plan_scope', () => {
    const article = makeArticle({ plan_scope: 'pro' });
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'basico', businessType: null })).toBe(false);
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'pro', businessType: null })).toBe(true);
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'plus', businessType: null })).toBe(true);
  });

  test('excluye por tipo de negocio cuando business_types no incluye el actual', () => {
    const article = makeArticle({ business_types: JSON.stringify(['farmacia']) });
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'basico', businessType: 'colmado' })).toBe(false);
    expect(articleAppliesToUser(article, { roleCode: 'cajero', planCode: 'basico', businessType: 'farmacia' })).toBe(true);
  });
});

describe('assistant-knowledge.service — searchArticles/listArticles (con query mockeado)', () => {
  function mockQueryReturning(rows) {
    return jest.fn().mockResolvedValue(rows);
  }

  test('searchArticles devuelve solo artículos con score > 0, ordenados por relevancia', async () => {
    const rows = [
      makeArticle({ id: 1, title: 'Abrir y cerrar caja', keywords: 'abrir caja, cerrar caja' }),
      makeArticle({ id: 2, title: 'Registrar una compra', keywords: 'compra, proveedor', content: 'Compras y gastos.' }),
    ];
    const query = mockQueryReturning(rows);
    const results = await searchArticles(query, {
      question: '¿cómo abro la caja?',
      roleCode: 'cajero',
      planCode: 'basico',
      businessType: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
  });

  test('searchArticles respeta el filtro de rol/plan antes de puntuar', async () => {
    const rows = [makeArticle({ id: 1, role_scope: JSON.stringify(['administrador_general']) })];
    const query = mockQueryReturning(rows);
    const results = await searchArticles(query, {
      question: 'como abro la caja',
      roleCode: 'cajero',
      planCode: 'basico',
      businessType: null,
    });
    expect(results).toHaveLength(0);
  });

  test('listArticles filtra por módulo cuando se indica', async () => {
    const rows = [
      makeArticle({ id: 1, module: 'caja' }),
      makeArticle({ id: 2, module: 'ventas', title: 'Vender productos' }),
      makeArticle({ id: 3, module: null, title: 'Artículo general' }),
    ];
    const query = mockQueryReturning(rows);
    const results = await listArticles(query, { module: 'caja', roleCode: 'cajero', planCode: 'basico', businessType: null });
    expect(results.map((a) => a.id).sort()).toEqual([1, 3]);
  });

  test('la consulta SQL solo pide artículos activos', async () => {
    const query = mockQueryReturning([]);
    await listArticles(query, { roleCode: 'cajero', planCode: 'basico', businessType: null });
    expect(query.mock.calls[0][0]).toMatch(/is_active = 1/);
  });
});
