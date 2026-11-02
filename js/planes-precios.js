/* Tecno Caja — Planes y precios, y lo que necesita el sistema.
 * Configuración → Datos del Negocio → "Ver planes y precios".
 * Solo muestra: los precios salen del servidor y aquí no se cambia nada. */
(function () {
  'use strict';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rd = (c) => (c === null || c === undefined ? 'Consultar' : `RD$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const PERMANENTE = 'LIFETIME_NO_SUBSCRIPTION';
  const ESTADOS = {
    activo: 'Activo', inactivo: 'No contratado', suspendido: 'Suspendido', vencido: 'Vencido', sin_contrato: 'Sin registrar',
  };
  const fecha = (v) => (v ? new Date(v).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

  function token() {
    return (typeof getStoredAuthToken === 'function' ? getStoredAuthToken() : '') || window.DB?.authToken || '';
  }

  async function pedir(ruta) {
    const res = await fetch(`/api/planes${ruta}`, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo cargar la información.');
    return data;
  }

  function precioServicio(s) {
    const partes = [];
    if (s.mensual !== null) partes.push(`${rd(s.mensual)} al mes`);
    if (s.anual !== null) partes.push(`${rd(s.anual)} al año`);
    return partes.length ? partes.join(' o ') : 'consultar precio';
  }

  function adicionales(p) {
    const filas = [];
    if (p.computadoraExtraMensual !== null) filas.push(`Computadora adicional: ${rd(p.computadoraExtraMensual)} al mes o ${rd(p.computadoraExtraAnual)} al año`);
    if (p.sucursalExtraMensual !== null) filas.push(`Sucursal adicional (con su computadora): ${rd(p.sucursalExtraMensual)} al mes o ${rd(p.sucursalExtraAnual)} al año`);
    if (p.computadoraExtraImplementacion !== null) filas.push(`Implementación por computadora adicional: ${rd(p.computadoraExtraImplementacion)}, una sola vez`);
    return filas;
  }

  function tarjeta(p, actual) {
    const incluye = p.sucursales > 1
      ? `${p.sucursales} sucursales, con 1 computadora en cada una`
      : `${p.computadoras} ${p.computadoras === 1 ? 'computadora' : 'computadoras'}`;
    const extra = adicionales(p);
    return `<article class="pp-plan${actual ? ' es-actual' : ''}">
      ${actual ? '<span class="pp-tu-plan">Tu plan</span>' : ''}
      <h3>${esc(p.nombre)}</h3>
      <p class="pp-desc">${esc(p.descripcion)}</p>
      <p class="pp-precio"><b>${rd(p.mensual)}</b> al mes</p>
      <p class="pp-anual"><b>${rd(p.anual)}</b> al año: pagas 9 meses y recibes 12</p>
      <p class="pp-impl">Implementación: <b>${rd(p.implementacion)}</b>, una sola vez</p>
      <p class="pp-perm">Pago único, sin mensualidad: <b>${rd(p.permanente)}</b></p>
      <p class="pp-incluye">Incluye ${esc(incluye)}</p>
      ${extra.length ? `<ul class="pp-extra">${extra.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </article>`;
  }

  function miLicencia(l) {
    if (!l) return '';
    const servicio = (nombre, s) => {
      if (!s) return '';
      return `<li><span>${esc(nombre)}</span><b class="pp-est ${esc(s.estado)}">${esc(ESTADOS[s.estado] || s.estado)}${s.venceEn ? ` · hasta ${esc(fecha(s.venceEn))}` : ''}</b></li>`;
    };
    const modalidad = l.modalidad === PERMANENTE ? 'Licencia permanente, sin mensualidad'
      : l.modalidad === 'anual' ? `Anual${l.expiresAt ? `, hasta ${fecha(l.expiresAt)}` : ''}`
        : l.modalidad === 'mensual' ? `Mensual${l.expiresAt ? `, hasta ${fecha(l.expiresAt)}` : ''}`
          : '';
    const s = l.servicios;
    if (!modalidad && !s?.conContrato) return '';
    return `<section class="pp-seccion"><h3>Tu licencia</h3>
      ${modalidad ? `<p>${esc(modalidad)}</p>` : ''}
      ${s ? `<ul class="pp-servicios">
        ${servicio('Facturación electrónica', s.ecf)}
        ${servicio('Soporte técnico', s.soporte)}
        ${servicio('Respaldo local', s.respaldoLocal)}
        ${servicio('Respaldo en la nube', s.respaldoNube)}
        ${servicio('Actualizaciones', s.actualizaciones)}
      </ul>` : ''}
    </section>`;
  }

  async function abrir() {
    const fondo = document.createElement('div');
    fondo.className = 'pp-fondo';
    fondo.innerHTML = `<div class="pp-caja" role="dialog" aria-modal="true" aria-labelledby="pp-titulo">
      <header><h2 id="pp-titulo">Planes y precios</h2><button type="button" class="pp-cerrar" data-pp-cerrar aria-label="Cerrar">✕</button></header>
      <div class="pp-cuerpo"><p class="pp-cargando">Cargando…</p></div>
    </div>`;
    const cerrar = () => { fondo.remove(); document.removeEventListener('keydown', alEsc); };
    const alEsc = (e) => { if (e.key === 'Escape') cerrar(); };
    document.addEventListener('keydown', alEsc);
    fondo.addEventListener('click', (e) => { if (e.target === fondo || e.target.closest('[data-pp-cerrar]')) cerrar(); });
    document.body.appendChild(fondo);
    const cuerpo = fondo.querySelector('.pp-cuerpo');
    try {
      const [c, licencia] = await Promise.all([pedir('/catalogo'), pedir('/mi-licencia').catch(() => null)]);
      const actual = licencia?.planCode;
      cuerpo.innerHTML = `
        ${miLicencia(licencia)}
        <div class="pp-planes">${c.planes.map((p) => tarjeta(p, p.codigo === actual)).join('')}</div>
        <p class="pp-nota">La implementación se paga una sola vez y no se vuelve a cobrar al renovar. Precios en pesos dominicanos.</p>
        <div class="pp-columnas">
          <section class="pp-seccion"><h3>Pago único permanente</h3>
            <ul>${c.incluye.permanente.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            <h4>No incluye</h4>
            <ul>${c.incluye.permanenteNoIncluye.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          </section>
          <section class="pp-seccion"><h3>Servicios aparte</h3>
            <ul>
              <li>Facturación electrónica DGII: ${precioServicio(c.servicios.ecf)}</li>
              <li>Soporte técnico: ${precioServicio(c.servicios.soporte)}</li>
            </ul>
            <h4>Qué necesitas para usarlo</h4>
            <ul>${c.requisitos.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          </section>
        </div>
        <a class="btn-primary pp-whatsapp" href="https://wa.me/18292812877?text=${encodeURIComponent('Hola, quiero información sobre los planes de Tecno Caja.')}" target="_blank" rel="noopener">Hablar por WhatsApp</a>`;
    } catch (error) {
      cuerpo.innerHTML = `<p class="pp-cargando">${esc(error.message)}</p>`;
    }
  }

  window.PlanesPrecios = { abrir };
})();
