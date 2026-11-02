'use strict';

// Vista previa de "Personalizar tienda": la misma página de la tienda servida por el
// POS, con su catálogo y el borrador. La tienda publicada no se deja poner dentro de
// otra ventana (frame-ancestors), y así se ve el cambio antes de publicarlo.
// No recibe pedidos.

const path = require('path');
const express = require('express');

const RAIZ_TIENDA = path.join(__dirname, '..', '..', 'cloud', 'tienda-online');
const SLUG = 'vista-previa';
const VIGENCIA_MS = 20000;

function decodificarDataUrl(valor) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(valor || ''));
  return m ? { mime: m[1], data: Buffer.from(m[2], 'base64') } : null;
}

function createVistaPreviaRouter({ tienda, readLocalImage }) {
  const router = express.Router();
  let vistas = null;

  // Es la misma cuenta de precios y fotos que hace la nube. Se carga al usarla: que
  // falte la vista previa nunca debe impedir que arranque el POS.
  function cuentas() {
    if (!vistas) {
      // eslint-disable-next-line global-require
      const { createTiendas } = require(path.join(RAIZ_TIENDA, 'lib', 'tiendas'));
      vistas = createTiendas({ db: null });
    }
    return vistas;
  }

  let memo = { en: 0, valor: null };

  async function construir({ fresco = false } = {}) {
    if (!fresco && memo.valor && Date.now() - memo.en < VIGENCIA_MS) return memo.valor;
    await tienda.ensureReady();
    const store = await tienda.settingsStore.read();
    // Sin marcar productos como nuevos: mirar la vista previa no cambia nada.
    const built = await tienda.catalogBuilder.build({ store: { ...store, enabled: false } });
    memo = { en: Date.now(), valor: { built, store } };
    return memo.valor;
  }

  router.get(`/t/${SLUG}`, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(RAIZ_TIENDA, 'public', 'index.html'));
  });
  router.use('/static', express.static(path.join(RAIZ_TIENDA, 'public'), { index: false, maxAge: 0 }));

  router.get(`/api/tiendas/${SLUG}`, async (_req, res) => {
    try {
      const { built, store } = await construir({ fresco: true });
      const stock = { items: {} };
      for (const [clave, s] of Object.entries(built.stock || {})) stock.items[clave] = { s };
      const perfil = { ...built.perfil, diseno: store.settings.disenoBorrador || store.settings.diseno };
      const vista = cuentas().vistaPublica(SLUG, { perfil, lista: built.productos, stock }, new Date());
      vista.tienda.abierta = true;
      vista.tienda.aceptaFueraDeHorario = true;
      res.set('Cache-Control', 'no-store');
      res.json(vista);
    } catch (error) {
      console.error('[tienda-online] Vista previa:', error);
      res.status(500).json({ error: 'No se pudo preparar la vista previa.' });
    }
  });

  router.get(`/api/tiendas/${SLUG}/img/:clave`, async (req, res) => {
    try {
      const { built } = await construir();
      const img = built.imagenes.find((x) => x.clave === req.params.clave);
      if (!img) return res.status(404).end();
      if (img.fuente.tipo === 'data') {
        const d = decodificarDataUrl(img.fuente.valor);
        if (!d) return res.status(404).end();
        res.type(d.mime);
        return res.send(d.data);
      }
      const data = await readLocalImage(img.fuente.valor);
      if (!data) return res.status(404).end();
      res.type('image/webp');
      return res.send(data);
    } catch (_error) {
      return res.status(404).end();
    }
  });

  router.post(`/api/tiendas/${SLUG}/:accion`, (_req, res) => {
    res.status(400).json({ error: 'Esta es la vista previa: aquí no se hacen pedidos.' });
  });

  return router;
}

module.exports = { createVistaPreviaRouter };
