(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesasSeleccion = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const redondear = (n) => Math.round(n * 100) / 100;
  function expandir(elementos, ids) {
    const elegidos = new Set(ids);
    const grupos = new Set(elementos.filter((e) => elegidos.has(e.id) && e.grupoId).map((e) => e.grupoId));
    return new Set(elementos.filter((e) => elegidos.has(e.id) || (e.grupoId && grupos.has(e.grupoId))).map((e) => e.id));
  }
  function limites(items) {
    const cajas = items.map((e) => {
      const a = (e.rotacion || 0) * Math.PI / 180;
      const w = Math.abs(Math.cos(a)) * e.ancho + Math.abs(Math.sin(a)) * e.alto;
      const h = Math.abs(Math.sin(a)) * e.ancho + Math.abs(Math.cos(a)) * e.alto;
      return { x: e.x + e.ancho / 2 - w / 2, y: e.y + e.alto / 2 - h / 2, w, h };
    });
    const x = Math.min(...cajas.map((e) => e.x)), y = Math.min(...cajas.map((e) => e.y));
    return { x, y, ancho: Math.max(...cajas.map((e) => e.x + e.w)) - x, alto: Math.max(...cajas.map((e) => e.y + e.h)) - y };
  }
  function trasladar(items, dx, dy) {
    if (!items.length) return [];
    const b = limites(items);
    const limitar = (v, min, max) => min > max ? 0 : Math.max(min, Math.min(max, v));
    dx = limitar(dx, -b.x, 1600 - b.x - b.ancho); dy = limitar(dy, -b.y, 1000 - b.y - b.alto);
    return items.map((e) => ({ ...e, x: redondear(e.x + dx), y: redondear(e.y + dy) }));
  }
  function escalar(items, factor) {
    if (!items.length) return [];
    const b = limites(items), cx = b.x + b.ancho / 2, cy = b.y + b.alto / 2;
    const minimo = Math.max(...items.map((e) => Math.max(16 / e.ancho, 16 / e.alto, .75 / (e.textoEscala || 1))));
    const maximo = Math.min(1600 / b.ancho, 1000 / b.alto, ...items.map((e) => 3 / (e.textoEscala || 1)));
    if (minimo > maximo) return items.map((e) => ({ ...e }));
    factor = Math.max(minimo, Math.min(maximo, factor));
    const escalados = items.map((e) => ({ ...e, x: redondear(cx + (e.x - cx) * factor), y: redondear(cy + (e.y - cy) * factor),
      ancho: redondear(e.ancho * factor), alto: redondear(e.alto * factor), textoEscala: Math.max(.75, Math.min(3, (e.textoEscala || 1) * factor)) }));
    return trasladar(escalados, 0, 0);
  }
  return { expandir, limites, trasladar, escalar };
});
