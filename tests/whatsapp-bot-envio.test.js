'use strict';

/**
 * Envío del bot de WhatsApp a prueba de cambios de WhatsApp Web: nunca marca
 * el chat como leído antes de enviar (sendSeen rompía el envío de facturas) y,
 * si el envío por número falla, reintenta con el ID interno (@lid).
 */

const { _test } = require('../server/integrations/whatsapp-bot');

const { conEnvioSeguro } = _test;

function clienteFalso({ fallaNumero = false, lid = '123456789@lid' } = {}) {
  const llamadas = [];
  return {
    llamadas,
    async sendMessage(chatId, content, options) {
      llamadas.push({ chatId, content, options });
      if (fallaNumero && chatId.endsWith('@c.us')) {
        throw new Error("Data passed to getter must include an id property (it's how we memoize) but got undefined");
      }
      return { id: 'msg1', to: chatId };
    },
    async getContactLidAndPhone(ids) {
      return ids.map(() => ({ lid, pn: ids[0] }));
    },
  };
}

describe('envío seguro del bot de WhatsApp', () => {
  test('envía sin marcar el chat como leído', async () => {
    const c = conEnvioSeguro(clienteFalso());
    await c.sendMessage('18095551111@c.us', 'Hola', { caption: 'x' });
    expect(c.llamadas[0].options).toMatchObject({ sendSeen: false, caption: 'x' });
  });

  test('msg.reply() (quotedMessageId) también va sin sendSeen', async () => {
    const c = conEnvioSeguro(clienteFalso());
    await c.sendMessage('18095551111@c.us', 'Hola', { quotedMessageId: 'abc' });
    expect(c.llamadas[0].options).toEqual({ sendSeen: false, quotedMessageId: 'abc' });
  });

  test('si falla con el número, reintenta con el @lid del contacto', async () => {
    const c = conEnvioSeguro(clienteFalso({ fallaNumero: true }));
    const r = await c.sendMessage('18095551111@c.us', 'Factura');
    expect(r.to).toBe('123456789@lid');
    expect(c.llamadas.map((l) => l.chatId)).toEqual(['18095551111@c.us', '123456789@lid']);
  });

  test('sin @lid conocido, devuelve el error original', async () => {
    const c = conEnvioSeguro(clienteFalso({ fallaNumero: true, lid: null }));
    await expect(c.sendMessage('18095551111@c.us', 'Factura')).rejects.toThrow(/Data passed to getter/);
  });
});
