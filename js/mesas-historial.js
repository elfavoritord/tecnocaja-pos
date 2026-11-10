(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MesasHistorial = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  class HistorialPlano {
    constructor(elementos, { maxPasos = 80, maxCaracteres = 8000000 } = {}) {
      this.maxPasos = maxPasos; this.maxCaracteres = maxCaracteres;
      this.estados = [{ datos: JSON.stringify(elementos), seleccion: [], principal: null }]; this.indice = 0;
    }
    get puedeDeshacer() { return this.indice > 0; }
    get puedeRehacer() { return this.indice < this.estados.length - 1; }
    registrar(elementos, seleccion = [], principal = null) {
      const estado = { datos: JSON.stringify(elementos), seleccion: [...seleccion], principal };
      if (estado.datos === this.estados[this.indice].datos) { Object.assign(this.estados[this.indice], { seleccion: estado.seleccion, principal }); return false; }
      this.estados.splice(this.indice + 1);
      this.estados.push(estado); this.indice++;
      while (this.estados.length > 1 && (this.estados.length > this.maxPasos + 1 || this.estados.reduce((n, e) => n + e.datos.length, 0) > this.maxCaracteres)) {
        this.estados.shift(); this.indice--;
      }
      return true;
    }
    sincronizar(elementos, seleccion = [], principal = null) {
      this.estados[this.indice] = { datos: JSON.stringify(elementos), seleccion: [...seleccion], principal };
    }
    actual() {
      const e = this.estados[this.indice];
      return { elementos: JSON.parse(e.datos), seleccion: [...e.seleccion], principal: e.principal };
    }
    deshacer() { if (!this.puedeDeshacer) return null; this.indice--; return this.actual(); }
    rehacer() { if (!this.puedeRehacer) return null; this.indice++; return this.actual(); }
  }
  return { HistorialPlano };
});
