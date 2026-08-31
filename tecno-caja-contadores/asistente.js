'use strict';

/**
 * asistente.js — Asistente virtual (IA) para el portal del contador.
 *
 * Usa la API de Google Gemini (REST, sin dependencias extra). La API key es
 * POR CONTADOR: se guarda en su doc de Firestore (`gemini_api_key`), nunca
 * llega al navegador.
 *
 * El servidor arma el bucle de "function calling": el modelo pide herramientas,
 * el servidor las ejecuta contra Firestore (solo lectura, solo los datos del
 * contador) y le devuelve el resultado, hasta que el modelo responde en texto.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_STEPS = 4;
const FETCH_TIMEOUT_MS = 45000;

async function _fetchOnce(apiKey, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        // Cuota de la capa gratuita agotada (20 solicitudes/min).
        const rd = (data?.error?.details || []).find(d => /RetryInfo/.test(d['@type'] || ''))?.retryDelay || '';
        const seg = Math.ceil(parseFloat(String(rd).replace('s', '')) || 45);
        const err = new Error(`Alcanzaste el límite de la capa gratuita de Google (20 consultas por minuto). Espera ~${seg} segundos y vuelve a intentar. Con una API key de pago este límite desaparece.`);
        err.status = 429;
        throw err;
      }
      const msg = data?.error?.message || `Gemini respondió ${res.status}`;
      const err = new Error(msg);
      err.status = (res.status === 400 || res.status === 403) ? 400 : 502;
      err.retriable = [500, 502, 503].includes(res.status);
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('El asistente tardó demasiado en responder.'); err.status = 504; err.retriable = true; throw err; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Un reintento con backoff corto para errores transitorios del servidor
// (NO para 429 de cuota — reintentar ahí solo gasta otra solicitud).
async function geminiCall(apiKey, body) {
  try {
    return await _fetchOnce(apiKey, body);
  } catch (e) {
    if (!e.retriable) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return _fetchOnce(apiKey, body);
  }
}

// Prueba rápida de la API key (una llamada mínima).
async function testKey(apiKey) {
  await geminiCall(apiKey, { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
  return true;
}

/**
 * Corre una conversación con herramientas.
 * @param {object}   o
 * @param {string}   o.apiKey
 * @param {string}   o.systemPrompt
 * @param {Array}    o.history        [{ role: 'user'|'model', text }]
 * @param {Array}    o.tools          [{ name, description, parameters }]
 * @param {Function} o.executeTool    async (name, args) => any
 * @returns {Promise<{ reply: string, toolLog: Array }>}
 */
async function runChat({ apiKey, systemPrompt, history, tools, executeTool }) {
  const contents = (history || []).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(m.text || '') }],
  }));
  const toolDecls = (tools || []).map(t => ({
    name: t.name, description: t.description, parameters: t.parameters,
  }));
  const toolLog = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await geminiCall(apiKey, {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: toolDecls.length ? [{ functionDeclarations: toolDecls }] : undefined,
      generationConfig: { temperature: 0.3 },
    });

    const modelContent = data?.candidates?.[0]?.content || { role: 'model', parts: [] };
    const parts = modelContent.parts || [];
    const fcParts = parts.filter(p => p.functionCall);

    if (!fcParts.length) {
      const text = parts.map(p => p.text).filter(Boolean).join('\n').trim();
      return { reply: text || 'No pude generar una respuesta.', toolLog };
    }

    // Eco EXACTO del turno del modelo (conserva thoughtSignature, requerido por Gemini).
    contents.push({ role: 'model', parts });

    // Ejecutar cada herramienta y devolver los resultados
    const responseParts = [];
    for (const p of fcParts) {
      const call = p.functionCall;
      let result;
      try {
        result = await executeTool(call.name, call.args || {});
      } catch (e) {
        result = { error: e.message || 'Error ejecutando la herramienta.' };
      }
      toolLog.push({ name: call.name, args: call.args || {}, ok: !(result && result.error) });
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return { reply: 'La consulta necesitó demasiados pasos. Intenta ser más específico.', toolLog };
}

module.exports = { MODEL, testKey, runChat };
