'use strict';

/**
 * assistant-knowledge.service.js — Búsqueda y filtrado de artículos del Centro de
 * Ayuda / Tecno Asistente. Búsqueda por coincidencia de palabras clave en Node (no
 * FULLTEXT/FTS5 — con docenas de artículos alcanza y evita depender de configuración
 * específica de MySQL/SQLite que no está probada en este proyecto).
 */

const { PLAN_LEVELS } = require('../../modules/plans');

function safeParseArray(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Un artículo aplica al usuario actual si: su rol está en role_scope (o role_scope
// es NULL = todos), su plan alcanza plan_scope, y su tipo de negocio está en
// business_types (o business_types es NULL = universal).
function articleAppliesToUser(row, { roleCode, planCode, businessType } = {}) {
  const roles = safeParseArray(row.role_scope);
  if (roles && roles.length && !roles.includes(roleCode)) return false;

  const requiredPlan = row.plan_scope || 'basico';
  const currentLevel = PLAN_LEVELS[planCode] || PLAN_LEVELS.basico;
  const requiredLevel = PLAN_LEVELS[requiredPlan] || PLAN_LEVELS.basico;
  if (currentLevel < requiredLevel) return false;

  const types = safeParseArray(row.business_types);
  if (types && types.length && businessType && !types.includes(businessType)) return false;

  return true;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    // Quita acentos comunes del español para que "caja"/"cája" empaten igual.
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u')
    .replace(/ñ/g, 'n')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function scoreArticle(article, questionTokens, moduleHint) {
  const titleTokens = tokenize(article.title);
  const keywordTokens = tokenize(article.keywords);
  const contentTokens = tokenize(article.content);
  let score = 0;
  for (const t of questionTokens) {
    if (titleTokens.includes(t)) score += 5;
    if (keywordTokens.includes(t)) score += 4;
    if (contentTokens.includes(t)) score += 1;
  }
  if (moduleHint && article.module === moduleHint) score += 3;
  return score;
}

async function fetchApplicableArticles(query, { roleCode, planCode, businessType } = {}) {
  const rows = await query('SELECT * FROM assistant_kb_articles WHERE is_active = 1');
  return rows.filter((row) => articleAppliesToUser(row, { roleCode, planCode, businessType }));
}

// Devuelve los artículos más relevantes para una pregunta libre, ya filtrados por
// rol/plan/tipo de negocio. Solo incluye artículos con score > 0 (coincidencia real).
async function searchArticles(query, { question, module, roleCode, planCode, businessType, limit = 4 } = {}) {
  const applicable = await fetchApplicableArticles(query, { roleCode, planCode, businessType });
  const questionTokens = tokenize(question);
  return applicable
    .map((article) => ({ ...article, _score: scoreArticle(article, questionTokens, module) }))
    .filter((a) => a._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// Para el Centro de Ayuda (listar/explorar, sin pregunta de por medio).
async function listArticles(query, { module, roleCode, planCode, businessType } = {}) {
  const applicable = await fetchApplicableArticles(query, { roleCode, planCode, businessType });
  return module ? applicable.filter((a) => !a.module || a.module === module) : applicable;
}

async function logQuestion(query, { question, module, roleCode, matchedArticleId, hadAnswer } = {}) {
  try {
    await query(
      'INSERT INTO assistant_questions_log (question, module, user_role, matched_article_id, had_answer) VALUES (?, ?, ?, ?, ?)',
      [question || '', module || null, roleCode || null, matchedArticleId || null, hadAnswer ? 1 : 0]
    );
  } catch (e) {
    console.warn('[assistant] No se pudo registrar la pregunta:', e.message);
  }
}

module.exports = {
  searchArticles,
  listArticles,
  logQuestion,
  articleAppliesToUser,
  scoreArticle,
  tokenize,
};
