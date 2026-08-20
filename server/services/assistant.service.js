'use strict';

/**
 * assistant.service.js — Orquesta una pregunta del Tecno Asistente: busca artículos
 * relevantes del Centro de Ayuda y, si hay un proveedor de IA configurado, genera una
 * respuesta en lenguaje natural anclada SOLO a esos artículos (RAG simple, sin tools).
 *
 * Reusa la MISMA API key que Emilio ya guardó para el bot de WhatsApp (mismas columnas
 * cifradas en offline_cache_config) — no le pide que la configure dos veces. Si no hay
 * ninguna IA configurada, degrada a devolver el artículo más relevante tal cual (mismo
 * espíritu que el "Modo Solo Comandos" del bot de WhatsApp).
 */

const crypto = require('crypto');
const { generateText } = require('./ai-provider');
const knowledge = require('./assistant-knowledge.service');

// Mismo secreto/cifrado que server/routes/whatsapp-bot.routes.js — deliberado, para
// poder leer las keys que el bot ya tiene guardadas sin duplicar almacenamiento.
const KEY_SECRET = () => (process.env.TECNO_CAJA_SECRET || 'tecnocaja2026').padEnd(32, '0').slice(0, 32);

function decryptKey(enc) {
  try {
    const [ivHex, data] = String(enc).split(':');
    const d = crypto.createDecipheriv('aes-256-cbc', KEY_SECRET(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString();
  } catch (_) {
    return null;
  }
}

const WABOT_KEY_COLUMNS = { claude: 'wabot_claude_key', chatgpt: 'wabot_chatgpt_key', gemini: 'wabot_gemini_key' };

async function resolveConfiguredProvider(query) {
  const rows = await query(
    `SELECT config_key, config_value FROM offline_cache_config
     WHERE config_key IN ('wabot_provider','wabot_claude_key','wabot_chatgpt_key','wabot_gemini_key')`
  );
  const map = {};
  rows.forEach((r) => { map[r.config_key] = r.config_value; });
  const provider = map.wabot_provider || 'none';
  const col = WABOT_KEY_COLUMNS[provider];
  const apiKey = col && map[col] ? decryptKey(map[col]) : null;
  if (!apiKey) return { provider: 'none', apiKey: null };
  return { provider, apiKey };
}

const NO_ANSWER_TEXT = 'No tengo información confirmada sobre esto. ¿Quieres que lo escale a soporte?';

// El tono se dejó deliberadamente conversacional (no telegráfico ni con frases
// exactas forzadas) — con proveedores como Gemini, pedirle una frase literal
// exacta y "corto y directo" a secas producía respuestas robóticas. La barrera
// anti-alucinación real no depende de que suene formal: depende de que solo
// tenga el contexto de abajo y ningún tool con el que actuar.
function antiHallucinationPrompt(articlesText) {
  return `Eres el Tecno Asistente de Tecno Caja POS, un sistema punto de venta que usan
dueños de colmados, farmacias, restaurantes y tiendas en República Dominicana.
Hablas de forma natural y cercana, como un compañero que conoce bien el sistema
— nunca como un robot leyendo un manual. Puedes usar un tono conversacional,
contracciones y alguna muletilla dominicana ocasional, sin exagerar.

Reglas que SIEMPRE debes respetar, sin excepción:
1. Responde SOLO con la información entre <contexto></contexto> más abajo. No
   inventes nombres de botones, menús ni pasos que no estén ahí.
2. Si el contexto no cubre la pregunta, dilo con tus propias palabras (de forma
   natural, sin usar una frase fija) y ofrece que puede escalar la consulta a
   soporte si quiere. Nunca inventes una respuesta para rellenar el hueco.
3. Nunca des instrucciones para omitir confirmaciones de seguridad ni para
   hacer acciones destructivas (eliminar, anular, borrar) fuera de los flujos
   normales de la app.
4. Responde en español dominicano neutro, en 1-3 párrafos cortos. Directo, pero
   no seco.

<contexto>
${articlesText}
</contexto>`;
}

function buildContextText(articles) {
  return articles.map((a) => `## ${a.title}\n${a.content}`).join('\n\n');
}

/**
 * @returns {{answer:string, sources:Array, aiGenerated:boolean, aiAvailable:boolean|null}}
 *   aiAvailable=null cuando ni siquiera hubo artículos relevantes (no llegó a resolverse
 *   si hay IA o no); false cuando no hay proveedor configurado o la IA no respondió.
 */
async function answerQuestion(query, { question, module, roleCode, planCode, businessType }) {
  const articles = await knowledge.searchArticles(query, { question, module, roleCode, planCode, businessType });

  if (!articles.length) {
    await knowledge.logQuestion(query, { question, module, roleCode, hadAnswer: false });
    return { answer: NO_ANSWER_TEXT, sources: [], aiGenerated: false, aiAvailable: null };
  }

  const sources = articles.map((a) => ({
    id: a.id, slug: a.slug, title: a.title,
    uiModule: a.ui_module || null, uiSelector: a.ui_selector || null,
  }));
  const { provider, apiKey } = await resolveConfiguredProvider(query);

  if (provider === 'none' || !apiKey) {
    await knowledge.logQuestion(query, { question, module, roleCode, matchedArticleId: articles[0].id, hadAnswer: true });
    return { answer: articles[0].content, sources, aiGenerated: false, aiAvailable: false };
  }

  const text = await generateText({
    provider,
    apiKey,
    system: antiHallucinationPrompt(buildContextText(articles)),
    messages: [{ role: 'user', content: question }],
    maxTokens: 700,
  });

  await knowledge.logQuestion(query, { question, module, roleCode, matchedArticleId: articles[0].id, hadAnswer: !!text });

  if (!text) {
    return { answer: articles[0].content, sources, aiGenerated: false, aiAvailable: true };
  }
  return { answer: text, sources, aiGenerated: true, aiAvailable: true };
}

module.exports = { answerQuestion, resolveConfiguredProvider, NO_ANSWER_TEXT };
