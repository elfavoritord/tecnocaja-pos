'use strict';

/**
 * El publicador no debe "cerrar" la tienda en la nube por una lectura rara al
 * arrancar el POS (pasó el 2026-10-11: la tienda dijo "no está recibiendo
 * pedidos" un par de minutos tras reiniciar Tecno Caja).
 */

const { createPublisher } = require('../../server/tienda-online/publisher');

function armar(lecturas) {
  const escritos = [];
  let i = 0;
  const publisher = createPublisher({
    nube: {
      writePerfil: async (perfil) => { escritos.push(perfil); },
      claimSlug: async () => ({ ok: true }),
    },
    catalogBuilder: { build: async () => { throw new Error('no debería publicar el catálogo'); } },
    settingsStore: { read: async () => lecturas[Math.min(i++, lecturas.length - 1)] },
    getLicenseId: () => 'pos_prueba',
    logger: { warn() {} },
  });
  return { publisher, escritos };
}

describe('tienda desactivada en el publicador', () => {
  test('sin fila de configuración no toca la nube', async () => {
    const { publisher, escritos } = armar([{ existe: false, enabled: false, slug: 'mi-tienda' }]);
    expect(await publisher.run()).toEqual({ omitido: 'sin_configuracion' });
    expect(await publisher.run({ force: true })).toEqual({ omitido: 'sin_configuracion' });
    expect(escritos).toHaveLength(0);
  });

  test('en el ciclo automático hace falta verla desactivada dos veces seguidas', async () => {
    const { publisher, escritos } = armar([{ existe: true, enabled: false, slug: 'mi-tienda' }]);
    expect(await publisher.run()).toEqual({ omitido: 'desactivada_por_confirmar' });
    expect(escritos).toHaveLength(0);
    expect(await publisher.run()).toEqual({ omitido: 'desactivada' });
    expect(escritos).toEqual([{ licenseId: 'pos_prueba', slug: 'mi-tienda', activa: false }]);
  });

  test('desactivarla a mano (guardar / Publicar ahora) cierra al momento', async () => {
    const { publisher, escritos } = armar([{ existe: true, enabled: false, slug: 'mi-tienda' }]);
    expect(await publisher.run({ force: true })).toEqual({ omitido: 'desactivada' });
    expect(escritos).toHaveLength(1);
  });
});
