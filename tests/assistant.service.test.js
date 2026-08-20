'use strict';

const crypto = require('crypto');

jest.mock('../server/services/ai-provider');
const { generateText } = require('../server/services/ai-provider');
const { answerQuestion, NO_ANSWER_TEXT } = require('../server/services/assistant.service');

// Mismo esquema que server/routes/whatsapp-bot.routes.js (encryptKey) — se
// reproduce aquí solo para poder fabricar filas de offline_cache_config
// válidas en las pruebas, sin importar ese archivo (no expone encryptKey).
const KEY_SECRET = (process.env.TECNO_CAJA_SECRET || 'tecnocaja2026').padEnd(32, '0').slice(0, 32);
function encryptKey(text) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', KEY_SECRET, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}

const ARTICLE = {
  id: 7,
  slug: 'abrir-cerrar-caja',
  module: 'caja',
  title: 'Cómo abrir y cerrar caja',
  content: 'Para abrir caja entra al módulo Caja y registra el monto inicial.',
  keywords: 'abrir caja, cerrar caja',
  role_scope: null,
  plan_scope: 'basico',
  business_types: null,
  is_active: 1,
  ui_module: 'caja',
  ui_selector: '#btn-caja-action',
};

function buildQuery({ articles = [ARTICLE], configRows = [] } = {}) {
  return jest.fn(async (sql) => {
    if (/SELECT \* FROM assistant_kb_articles WHERE is_active = 1/i.test(sql)) return articles;
    if (/FROM offline_cache_config/i.test(sql)) return configRows;
    if (/INSERT INTO assistant_questions_log/i.test(sql)) return {};
    return [];
  });
}

describe('assistant.service — answerQuestion', () => {
  beforeEach(() => {
    generateText.mockReset();
  });

  test('sin artículos relevantes, no llega a resolver el proveedor de IA', async () => {
    const query = buildQuery({ articles: [] });
    const result = await answerQuestion(query, {
      question: 'algo totalmente fuera de tema', module: null, roleCode: 'cajero', planCode: 'basico', businessType: null,
    });
    expect(result).toEqual({ answer: NO_ANSWER_TEXT, sources: [], aiGenerated: false, aiAvailable: null });
    expect(generateText).not.toHaveBeenCalled();
  });

  test('sin proveedor de IA configurado, degrada al contenido del artículo', async () => {
    const query = buildQuery({ configRows: [] });
    const result = await answerQuestion(query, {
      question: '¿cómo abro la caja?', module: 'caja', roleCode: 'cajero', planCode: 'basico', businessType: null,
    });
    expect(result.aiGenerated).toBe(false);
    expect(result.aiAvailable).toBe(false);
    expect(result.answer).toBe(ARTICLE.content);
    expect(generateText).not.toHaveBeenCalled();
  });

  test('con proveedor configurado, genera respuesta anclada al contexto recuperado', async () => {
    const configRows = [
      { config_key: 'wabot_provider', config_value: 'claude' },
      { config_key: 'wabot_claude_key', config_value: encryptKey('sk-test-123') },
    ];
    const query = buildQuery({ configRows });
    generateText.mockResolvedValue('Para abrir caja, ve al módulo Caja y registra el monto inicial.');

    const result = await answerQuestion(query, {
      question: '¿cómo abro la caja?', module: 'caja', roleCode: 'cajero', planCode: 'basico', businessType: null,
    });

    expect(result.aiGenerated).toBe(true);
    expect(result.aiAvailable).toBe(true);
    expect(result.sources).toEqual([{
      id: 7, slug: 'abrir-cerrar-caja', title: 'Cómo abrir y cerrar caja',
      uiModule: 'caja', uiSelector: '#btn-caja-action',
    }]);
    expect(generateText).toHaveBeenCalledTimes(1);

    const call = generateText.mock.calls[0][0];
    expect(call.provider).toBe('claude');
    expect(call.apiKey).toBe('sk-test-123'); // se descifró correctamente
    expect(call.system).toContain(ARTICLE.content); // el prompt va anclado al artículo real
    // Anti-alucinación real: solo puede usar el contexto, sin tools disponibles.
    // Deliberadamente NO se le fuerza una frase literal exacta para el caso "no
    // sé" — eso es lo que sonaba robótico con Gemini (ver antiHallucinationPrompt).
    expect(call.system).toMatch(/SOLO.*contexto/is);
    expect(call.system).not.toContain(NO_ANSWER_TEXT);
  });

  test('si el proveedor está configurado pero no responde, degrada al artículo sin marcar aiAvailable en false', async () => {
    const configRows = [
      { config_key: 'wabot_provider', config_value: 'gemini' },
      { config_key: 'wabot_gemini_key', config_value: encryptKey('gm-test-456') },
    ];
    const query = buildQuery({ configRows });
    generateText.mockResolvedValue(null);

    const result = await answerQuestion(query, {
      question: '¿cómo abro la caja?', module: 'caja', roleCode: 'cajero', planCode: 'basico', businessType: null,
    });

    expect(result.aiGenerated).toBe(false);
    expect(result.aiAvailable).toBe(true); // sí había proveedor — solo no devolvió texto
    expect(result.answer).toBe(ARTICLE.content);
  });
});
