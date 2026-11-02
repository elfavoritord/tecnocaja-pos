// ===== AVISO DE ACTUALIZACIÓN LISTA =====
//
// El proceso principal descarga la versión nueva en segundo plano y avisa aquí cuando toca
// preguntar (electron/update-recordatorio.js). Esta tarjeta no tapa la venta ni le quita el
// foco al lector de códigos, y el reinicio siempre lo decide la persona.

(function () {
  'use strict';

  const escritorio = window.novaDesktop;
  if (!escritorio?.updaterOnEvent || !escritorio.updaterPromptRespuesta) return;

  const REVISAR_MS = 2000;
  const SIN_RESPUESTA_MS = 10 * 60 * 1000;

  let fase = 'libre'; // libre | aviso | esperando | instalando
  let datos = { version: '', esTerminal: false };
  let vigilante = null;
  let sinRespuesta = null;

  // ── Qué se está haciendo en esta computadora ───────────────────────────────
  let escriturasEnCurso = 0;
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = function fetchVigilado(url, opciones = {}) {
    const ruta = String(url?.url || url || '');
    const metodo = String(opciones?.method || url?.method || 'GET').toUpperCase();
    const cuenta = metodo !== 'GET' && metodo !== 'HEAD' && ruta.includes('/api/')
      && !/\/api\/(system\/|respaldos\/auto)/.test(ruta);
    if (!cuenta) return fetchOriginal(url, opciones);
    escriturasEnCurso += 1;
    const terminar = () => { escriturasEnCurso -= 1; };
    const peticion = fetchOriginal(url, opciones);
    peticion.then(terminar, terminar);
    return peticion;
  };

  const abierto = (selector) => {
    const el = document.querySelector(selector);
    return Boolean(el && el.offsetParent !== null && !el.classList.contains('hidden'));
  };

  function motivoLocal() {
    const db = typeof DB !== 'undefined' ? DB : null;
    if (escriturasEnCurso > 0) return 'Se está guardando una operación.';
    if (abierto('#modal-overlay') && document.querySelector('#modal-box.billing-modal')) return 'Hay un cobro en proceso.';
    if ((db?.saleItems || []).length > 0) return 'Hay una venta en curso.';
    if (document.querySelector('.srv-modal-back')) return 'Hay una factura o un formulario abierto.';
    if (abierto('#modal-overlay')) return 'Hay una ventana abierta.';
    return null;
  }

  // Esta PC atiende a las terminales: una venta de otra caja también la frena. En una terminal
  // no: su reinicio no afecta a nadie más.
  async function estadoDelServidor() {
    if (datos.esTerminal) return { activas: 0, otrasCajas: 0 };
    try {
      const r = await fetchOriginal('/api/system/operaciones-activas');
      return r.ok ? await r.json() : { activas: 0, otrasCajas: 0 };
    } catch (_) {
      return { activas: 0, otrasCajas: 0 };
    }
  }

  async function motivoParaEsperar() {
    const local = motivoLocal();
    if (local) return local;
    const { activas } = await estadoDelServidor();
    return activas > 0 ? 'Otra caja está guardando una operación.' : null;
  }

  // ── Tarjeta ────────────────────────────────────────────────────────────────
  function tarjeta() {
    let el = document.getElementById('upd-aviso');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'upd-aviso';
    el.className = 'upd-aviso';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-labelledby', 'upd-aviso-titulo');
    el.setAttribute('aria-describedby', 'upd-aviso-texto');
    document.body.appendChild(el);
    return el;
  }

  function quitar() {
    document.getElementById('upd-aviso')?.remove();
    document.getElementById('upd-aviso-fondo')?.remove();
    clearInterval(vigilante);
    clearTimeout(sinRespuesta);
    vigilante = null;
    sinRespuesta = null;
    fase = 'libre';
  }

  const responder = (accion) => Promise.resolve(escritorio.updaterPromptRespuesta(accion)).catch(() => {});

  function pintarAviso(otrasCajas) {
    const el = tarjeta();
    const cajas = otrasCajas > 0
      ? `<p class="upd-aviso__nota">Esta computadora atiende a ${otrasCajas === 1 ? 'otra caja' : `${otrasCajas} cajas más`}: mientras se reinicia pueden perder la conexión con ella.</p>`
      : '';
    el.innerHTML = `
      <h3 class="upd-aviso__titulo" id="upd-aviso-titulo">¡Nueva actualización disponible!</h3>
      <div id="upd-aviso-texto">
        <p>Se ha descargado y preparado una nueva versión de Tecno Caja POS. Para aplicar las mejoras y correcciones, es necesario reiniciar el sistema.</p>
        ${cajas}
        <p class="upd-aviso__pregunta">¿Desea reiniciar ahora?</p>
      </div>
      <div class="upd-aviso__botones">
        <button type="button" class="upd-aviso__btn upd-aviso__btn--sec" data-upd="luego">Recordármelo más tarde</button>
        <button type="button" class="upd-aviso__btn upd-aviso__btn--pri" data-upd="reiniciar">Instalar y reiniciar</button>
      </div>`;
    el.querySelector('[data-upd="luego"]').onclick = () => { quitar(); responder('posponer'); };
    el.querySelector('[data-upd="reiniciar"]').onclick = reiniciar;
  }

  function pintarEsperando(motivo) {
    const el = tarjeta();
    el.innerHTML = `
      <h3 class="upd-aviso__titulo" id="upd-aviso-titulo">Se reiniciará al terminar</h3>
      <p id="upd-aviso-texto"><span data-upd-motivo>${motivo}</span> Tecno Caja se reiniciará en cuanto termine; puedes seguir trabajando.</p>
      <div class="upd-aviso__botones">
        <button type="button" class="upd-aviso__btn upd-aviso__btn--sec" data-upd="cancelar">No reiniciar todavía</button>
      </div>`;
    el.querySelector('[data-upd="cancelar"]').onclick = () => { quitar(); responder('posponer'); };
  }

  function bloquear(mensaje, pie = '') {
    // Mientras se respalda y se cierra no se puede empezar otra venta.
    if (!document.getElementById('upd-aviso-fondo')) {
      const fondo = document.createElement('div');
      fondo.id = 'upd-aviso-fondo';
      fondo.className = 'upd-aviso-fondo';
      document.body.appendChild(fondo);
    }
    const el = tarjeta();
    el.classList.add('upd-aviso--centro');
    el.innerHTML = `
      <h3 class="upd-aviso__titulo" id="upd-aviso-titulo">Preparando el reinicio</h3>
      <p id="upd-aviso-texto">${mensaje}</p>
      ${pie}`;
  }

  // ── Mostrar el aviso ───────────────────────────────────────────────────────
  async function mostrar() {
    if (fase !== 'libre' || document.getElementById('setup-update-overlay')) return;
    if (await motivoParaEsperar()) return; // El proceso principal vuelve a preguntar en un rato.
    if (fase !== 'libre') return;
    fase = 'aviso';
    const { otrasCajas } = await estadoDelServidor();
    pintarAviso(otrasCajas);
    responder('mostrado');
    sinRespuesta = setTimeout(quitar, SIN_RESPUESTA_MS);
    vigilante = setInterval(() => {
      // Empezó una venta: se retira sin molestar y vuelve cuando quede libre.
      if (fase === 'aviso' && motivoLocal()) { quitar(); responder('aplazar'); }
    }, REVISAR_MS);
  }

  // ── Reiniciar ──────────────────────────────────────────────────────────────
  async function reiniciar() {
    clearTimeout(sinRespuesta);
    clearInterval(vigilante);
    const motivo = await motivoParaEsperar();
    if (motivo) esperar(motivo);
    else instalar();
  }

  function esperar(motivo) {
    fase = 'esperando';
    pintarEsperando(motivo);
    clearInterval(vigilante);
    vigilante = setInterval(async () => {
      if (fase !== 'esperando') return;
      const sigue = await motivoParaEsperar();
      if (fase !== 'esperando') return;
      if (!sigue) { clearInterval(vigilante); instalar(); return; }
      const texto = document.querySelector('[data-upd-motivo]');
      if (texto) texto.textContent = sigue;
    }, REVISAR_MS);
  }

  function respaldoActivado() {
    try {
      return JSON.parse(localStorage.getItem('tecnocaja_update_prefs') || '{}').backupBeforeUpdate !== false;
    } catch (_) {
      return true;
    }
  }

  async function pedirInstalacion(opciones) {
    try {
      return await escritorio.updaterInstall({ comprobarOperaciones: true, ...opciones });
    } catch (e) {
      return { ok: false, error: e?.message || 'No se pudo iniciar el instalador.' };
    }
  }

  async function instalar() {
    fase = 'instalando';
    clearInterval(vigilante);
    bloquear('Guardando los datos y creando un respaldo. Luego Tecno Caja se cerrará para instalar la versión nueva y volverá a abrir solo. No hay que hacer nada más.');
    let r = await pedirInstalacion({ skipBackup: !respaldoActivado() });
    if (r?.backupFailed) {
      const seguir = await window.showDeleteConfirm(
        `No se pudo crear el respaldo: ${r.error || 'motivo desconocido'}. Actualizar no borra ni cambia tus datos. ¿Reiniciar de todas formas?`,
        { confirmText: 'Reiniciar sin respaldo', cancelText: 'Ahora no' }
      );
      if (!seguir) { quitar(); responder('posponer'); return; }
      r = await pedirInstalacion({ skipBackup: true });
    }
    if (r?.ocupado) {
      document.getElementById('upd-aviso-fondo')?.remove();
      tarjeta().classList.remove('upd-aviso--centro');
      esperar('Otra caja está guardando una operación.');
      return;
    }
    if (r?.ok === false) {
      bloquear(`No se pudo reiniciar: ${r.error || 'motivo desconocido'}. Tus datos no cambiaron.`,
        '<div class="upd-aviso__botones"><button type="button" class="upd-aviso__btn upd-aviso__btn--sec" data-upd="cerrar">Seguir trabajando</button></div>');
      document.querySelector('[data-upd="cerrar"]').onclick = () => { quitar(); responder('posponer'); };
    }
    // Con ok: true la app se cierra aquí; el instalador la vuelve a abrir.
  }

  escritorio.updaterOnEvent((evento, carga) => {
    if (evento !== 'prompt') return;
    datos = { version: carga?.version || '', esTerminal: Boolean(carga?.esTerminal) };
    mostrar();
  });

  window.TcAvisoActualizacion = { motivoParaEsperar };
}());
