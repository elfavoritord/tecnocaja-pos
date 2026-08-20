'use strict';

/**
 * ai-provider.js — Dispatcher parametrizado de proveedores de IA (Claude/ChatGPT/Gemini).
 *
 * Mismo comportamiento que callAi() de server/integrations/whatsapp-bot.js, pero sin
 * estado de módulo compartido: cada llamador pasa su propio provider/apiKey en vez de
 * leerlos de una variable global (_aiConfig allá). Eso permite que el Tecno Asistente y
 * el bot de WhatsApp usen proveedores/keys distintos (o uno apagado y el otro no) sin
 * pisarse. whatsapp-bot.js no se toca — sigue con su propia copia, ya probada en producción.
 */

const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CHATGPT_MODEL = 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

async function callClaudeText({ apiKey, system, messages, maxTokens }) {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  });
  return res.content[0]?.text || null;
}

async function callChatgptText({ apiKey, system, messages, maxTokens }) {
  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey });
  const res = await openai.chat.completions.create({
    model: CHATGPT_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  });
  return res.choices[0]?.message?.content || null;
}

async function callGeminiText({ apiKey, system, messages, maxTokens }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const http = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        // MINIMAL (usado para clasificación de intención en whatsapp-bot.js) hacía que
        // las respuestas sonaran telegráficas/robóticas para una conversación de ayuda.
        // MEDIUM es el mismo nivel que ya usa el turno del dueño con tool-use — más
        // natural, con un costo de latencia/tokens todavía razonable para un chat.
        generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: 'MEDIUM' } },
      }),
    }
  );
  const body = await http.json();
  if (!http.ok) throw new Error(body?.error?.message || `HTTP ${http.status}`);
  return body?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

/**
 * Genera texto con el proveedor indicado. Devuelve null (nunca lanza) si no hay
 * provider/apiKey válidos o si la llamada falla — el caller decide el fallback.
 */
async function generateText({ provider, apiKey, system, messages, maxTokens = 700 }) {
  if (!provider || provider === 'none' || !apiKey) return null;
  try {
    if (provider === 'claude') return await callClaudeText({ apiKey, system, messages, maxTokens });
    if (provider === 'chatgpt') return await callChatgptText({ apiKey, system, messages, maxTokens });
    if (provider === 'gemini') return await callGeminiText({ apiKey, system, messages, maxTokens });
  } catch (e) {
    console.error('[ai-provider] Error generando texto:', e.message);
  }
  return null;
}

module.exports = { generateText };
