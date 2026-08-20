// ===== TECNO ASISTENTE + CENTRO DE AYUDA (Fase 1) =====
// Botón flotante + panel de chat, y modal de Centro de Ayuda (se abre desde una
// tarjeta dentro de Configuración — ver setupCfgGroupCards() en app.js).
// Autocontenido a propósito: no depende del sistema de modal compartido
// (#modal-overlay) para no arriesgar su lógica especial de billing-modal.
'use strict';

(function () {
  const STATE = {
    open: false,
    currentModule: null,
    history: [], // { role: 'user'|'assistant', text }
    lastQuestion: null,
  };

  function currentPlanCode() {
    return typeof getEffectiveCurrentPlanCode === 'function' ? getEffectiveCurrentPlanCode() : 'basico';
  }

  function currentBusinessType() {
    return window.DB?.config?.tipoNegocio || null;
  }

  function isOffline() {
    return window.offlineManager?.getState?.()?.isOnline === false;
  }

  function injectStyles() {
    if (document.getElementById('assistant-style')) return;
    const style = document.createElement('style');
    style.id = 'assistant-style';
    style.textContent = `
      #assistant-float{position:fixed;bottom:1.5rem;left:1.5rem;z-index:9990;width:56px;height:56px;
        border-radius:50%;background:var(--accent,#6C63FF);color:#fff;border:none;cursor:pointer;
        box-shadow:0 4px 20px rgba(0,0,0,0.35);font-size:1.5rem;display:flex;align-items:center;
        justify-content:center;transition:transform .15s}
      #assistant-float:hover{transform:scale(1.07)}
      #assistant-panel{position:fixed;bottom:1.5rem;left:1.5rem;z-index:9991;width:360px;max-width:92vw;
        height:520px;max-height:75vh;background:var(--bg2);border:1px solid var(--border);
        border-radius:var(--radius,12px);box-shadow:0 10px 40px rgba(0,0,0,0.45);display:none;
        flex-direction:column;overflow:hidden;font-family:var(--font)}
      #assistant-panel.open{display:flex}
      #assistant-panel-header{padding:.85rem 1rem;background:var(--accent,#6C63FF);color:#fff;
        display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
      #assistant-panel-header strong{font-size:.95rem}
      #assistant-panel-close{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;
        opacity:.85;line-height:1}
      #assistant-panel-close:hover{opacity:1}
      #assistant-messages{flex:1;overflow-y:auto;padding:.85rem;display:flex;flex-direction:column;gap:.6rem}
      .assistant-msg{max-width:88%;padding:.55rem .75rem;border-radius:10px;font-size:.85rem;line-height:1.4;white-space:pre-wrap}
      .assistant-msg-user{align-self:flex-end;background:var(--accent,#6C63FF);color:#fff}
      .assistant-msg-bot{align-self:flex-start;background:var(--bg3);color:var(--text);border:1px solid var(--border)}
      .assistant-msg-sources{align-self:flex-start;font-size:.72rem;color:var(--text3);margin-top:-.3rem;padding:0 .2rem}
      .assistant-show-me-btn{align-self:flex-start;background:none;border:1px solid var(--accent,#6C63FF);
        color:var(--accent,#6C63FF);border-radius:8px;padding:.3rem .65rem;font-size:.76rem;cursor:pointer;margin-top:-.2rem}
      .assistant-show-me-btn:hover{background:var(--accent,#6C63FF);color:#fff}
      #assistant-escalate-link{flex-shrink:0;background:none;border:none;border-top:1px solid var(--border);
        color:var(--text3);font-size:.75rem;padding:.5rem .85rem;cursor:pointer;text-align:left}
      #assistant-escalate-link:hover{color:var(--warning,#FFB300)}
      #assistant-input-row{display:flex;gap:.5rem;padding:.75rem;border-top:1px solid var(--border);flex-shrink:0}
      #assistant-input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;
        color:var(--text);padding:.55rem .7rem;font-size:.85rem;resize:none}
      #assistant-send{background:var(--accent,#6C63FF);color:#fff;border:none;border-radius:8px;
        padding:0 1rem;cursor:pointer;font-size:.9rem}
      #assistant-send:disabled{opacity:.5;cursor:default}
      #assistant-help-modal{position:fixed;inset:0;z-index:9992;background:rgba(0,0,0,0.55);
        display:none;align-items:center;justify-content:center}
      #assistant-help-modal.open{display:flex}
      #assistant-help-box{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius,12px);
        width:640px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
      #assistant-help-header{padding:1rem 1.25rem;border-bottom:1px solid var(--border);
        display:flex;align-items:center;justify-content:space-between}
      #assistant-help-header h3{margin:0;font-size:1.05rem;color:var(--text)}
      #assistant-help-close{background:none;border:none;color:var(--text3);font-size:1.3rem;cursor:pointer}
      #assistant-help-search{margin:1rem 1.25rem 0;background:var(--bg);border:1px solid var(--border);
        border-radius:8px;padding:.6rem .8rem;color:var(--text);font-size:.9rem}
      #assistant-help-list{flex:1;overflow-y:auto;padding:1rem 1.25rem}
      .assistant-help-article{padding:.85rem;border:1px solid var(--border);border-radius:10px;
        margin-bottom:.7rem;cursor:pointer;background:var(--bg)}
      .assistant-help-article:hover{border-color:var(--accent,#6C63FF)}
      .assistant-help-article h4{margin:0 0 .35rem;font-size:.92rem;color:var(--text)}
      .assistant-help-article p{margin:0;font-size:.82rem;color:var(--text2);line-height:1.45;
        display:none;white-space:pre-wrap}
      .assistant-help-article.expanded p{display:block}
      .assistant-help-empty{color:var(--text3);font-size:.85rem;text-align:center;padding:2rem 0}
      #assistant-help-tutorials{padding:0 1.25rem;display:flex;gap:.6rem;flex-wrap:wrap}
      .assistant-tutorial-chip{display:flex;align-items:center;gap:.4rem;background:var(--bg);
        border:1px solid var(--accent,#6C63FF);color:var(--accent,#6C63FF);border-radius:999px;
        padding:.4rem .85rem;font-size:.78rem;cursor:pointer}
      .assistant-tutorial-chip:hover{background:var(--accent,#6C63FF);color:#fff}
      #assistant-help-tutorials-title{margin:1rem 1.25rem 0;font-size:.78rem;color:var(--text3);
        text-transform:uppercase;letter-spacing:.03em}

      /* "Muéstrame dónde": resalta el elemento objetivo con un pulso — visible
         en fondo oscuro y claro (usa var(--accent), no un color fijo). */
      .tecno-assistant-highlight{outline:3px solid var(--accent,#6C63FF)!important;outline-offset:3px!important;
        animation:tecnoAssistantPulse 1s ease-in-out 3;border-radius:6px}
      @keyframes tecnoAssistantPulse{0%,100%{outline-color:var(--accent,#6C63FF)}50%{outline-color:transparent}}

      #assistant-tutorial-bar{position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:9993;
        display:none;align-items:center;gap:.9rem;background:var(--bg2);border:1px solid var(--border);
        border-radius:999px;padding:.6rem .7rem .6rem 1.1rem;box-shadow:0 8px 30px rgba(0,0,0,0.4);
        max-width:92vw;font-family:var(--font)}
      #assistant-tutorial-bar.open{display:flex}
      #assistant-tutorial-text{font-size:.82rem;color:var(--text);max-width:320px}
      #assistant-tutorial-controls{display:flex;align-items:center;gap:.4rem;flex-shrink:0}
      #assistant-tutorial-progress{font-size:.72rem;color:var(--text3);white-space:nowrap}
      #assistant-tutorial-controls button{background:var(--bg3);border:1px solid var(--border);color:var(--text);
        border-radius:999px;padding:.35rem .75rem;font-size:.78rem;cursor:pointer;white-space:nowrap}
      #assistant-tutorial-controls button:hover{border-color:var(--accent,#6C63FF)}
      #assistant-tutorial-controls button:disabled{opacity:.4;cursor:default}
      #assistant-tutorial-next{background:var(--accent,#6C63FF)!important;color:#fff;border-color:var(--accent,#6C63FF)!important}
      #assistant-tutorial-close{background:none!important;border:none!important;font-size:1rem;padding:.2rem .3rem!important}
    `;
    document.head.appendChild(style);
  }

  function ensureFloatButton() {
    if (document.getElementById('assistant-float')) return;
    const btn = document.createElement('button');
    btn.id = 'assistant-float';
    btn.type = 'button';
    btn.title = 'Tecno Asistente';
    btn.textContent = '🤖';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
  }

  function ensurePanel() {
    if (document.getElementById('assistant-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'assistant-panel';
    panel.innerHTML = `
      <div id="assistant-panel-header">
        <strong>🤖 Tecno Asistente</strong>
        <button type="button" id="assistant-panel-close" aria-label="Cerrar">✕</button>
      </div>
      <div id="assistant-messages"></div>
      <button type="button" id="assistant-escalate-link">¿No resolvió tu duda? Escalar a soporte →</button>
      <div id="assistant-input-row">
        <textarea id="assistant-input" rows="1" placeholder="Escribe tu pregunta…"></textarea>
        <button type="button" id="assistant-send">Enviar</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#assistant-panel-close').addEventListener('click', close);
    panel.querySelector('#assistant-escalate-link').addEventListener('click', escalate);
    const input = panel.querySelector('#assistant-input');
    const sendBtn = panel.querySelector('#assistant-send');
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      ask(text);
    };
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
  }

  function scrollMessagesToBottom() {
    const box = document.getElementById('assistant-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function appendMessage(role, text) {
    const box = document.getElementById('assistant-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'assistant-msg ' + (role === 'user' ? 'assistant-msg-user' : 'assistant-msg-bot');
    div.textContent = text;
    box.appendChild(div);
    scrollMessagesToBottom();
    return div;
  }

  function appendSources(sources) {
    if (!sources || !sources.length) return;
    const box = document.getElementById('assistant-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'assistant-msg-sources';
    div.textContent = 'Fuente: ' + sources.map((s) => s.title).join(', ');
    box.appendChild(div);

    // "Muéstrame dónde" — solo si el artículo más relevante trae un selector
    // real de UI (ver ui_module/ui_selector en assistant_kb_articles, Fase 2).
    const top = sources[0];
    if (top?.uiSelector) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'assistant-show-me-btn';
      btn.textContent = '📍 Muéstrame dónde';
      btn.addEventListener('click', () => highlightTarget({ module: top.uiModule, selector: top.uiSelector }));
      box.appendChild(btn);
    }
    scrollMessagesToBottom();
  }

  // ── "Muéstrame dónde" ────────────────────────────────────────────────
  // Cambia de módulo si hace falta, espera un tick a que el DOM se acomode,
  // y resalta el elemento con un pulso. Cierra los paneles del asistente
  // primero para que no tapen el elemento resaltado (ambos viven abajo a la
  // izquierda, igual que el sidebar de navegación).
  async function highlightTarget({ module, selector }) {
    if (!selector) return false;
    close();
    closeHelpCenterModal();
    if (module && module !== STATE.currentModule && typeof showModule === 'function') {
      const navEl = document.querySelector(`[data-module="${module}"]`);
      showModule(module, navEl || undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
    const target = document.querySelector(selector);
    if (!target) {
      if (typeof showToast === 'function') showToast('No encontré ese elemento en la pantalla actual.', 'warning');
      return false;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('tecno-assistant-highlight');
    setTimeout(() => target.classList.remove('tecno-assistant-highlight'), 3000);
    return true;
  }

  // ── Tutoriales guiados paso a paso ──────────────────────────────────────
  const TUTORIAL_STATE = { tutorial: null, stepIndex: 0 };

  function ensureTutorialBar() {
    if (document.getElementById('assistant-tutorial-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'assistant-tutorial-bar';
    bar.innerHTML = `
      <div id="assistant-tutorial-text"></div>
      <div id="assistant-tutorial-controls">
        <span id="assistant-tutorial-progress"></span>
        <button type="button" id="assistant-tutorial-prev">← Atrás</button>
        <button type="button" id="assistant-tutorial-next">Siguiente →</button>
        <button type="button" id="assistant-tutorial-close" aria-label="Cerrar tutorial">✕</button>
      </div>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#assistant-tutorial-prev').addEventListener('click', () => stepTutorial(-1));
    bar.querySelector('#assistant-tutorial-next').addEventListener('click', () => stepTutorial(1));
    bar.querySelector('#assistant-tutorial-close').addEventListener('click', closeTutorial);
  }

  async function startTutorial(slug) {
    try {
      const tutorial = await api.getTutorial(slug, { planCode: currentPlanCode(), businessType: currentBusinessType() });
      if (!tutorial?.steps?.length) {
        if (typeof showToast === 'function') showToast('Este tutorial no tiene pasos configurados.', 'warning');
        return;
      }
      TUTORIAL_STATE.tutorial = tutorial;
      TUTORIAL_STATE.stepIndex = 0;
      injectStyles();
      ensureTutorialBar();
      document.getElementById('assistant-tutorial-bar')?.classList.add('open');
      await renderTutorialStep();
    } catch (err) {
      if (typeof showToast === 'function') showToast('No pude cargar el tutorial.', 'error');
      console.warn('[assistant] Error cargando tutorial:', err.message);
    }
  }

  async function renderTutorialStep() {
    const { tutorial, stepIndex } = TUTORIAL_STATE;
    if (!tutorial) return;
    const step = tutorial.steps[stepIndex];
    const textEl = document.getElementById('assistant-tutorial-text');
    if (textEl) textEl.textContent = step.text;
    const progressEl = document.getElementById('assistant-tutorial-progress');
    if (progressEl) progressEl.textContent = `Paso ${stepIndex + 1} de ${tutorial.steps.length}`;
    const prevBtn = document.getElementById('assistant-tutorial-prev');
    if (prevBtn) prevBtn.disabled = stepIndex === 0;
    const nextBtn = document.getElementById('assistant-tutorial-next');
    if (nextBtn) nextBtn.textContent = stepIndex === tutorial.steps.length - 1 ? 'Terminar ✓' : 'Siguiente →';
    // highlightTarget() cierra el panel de chat y el Centro de Ayuda (para no
    // tapar el elemento resaltado) pero no toca la barra de tutorial — vive en
    // la esquina inferior CENTRO, sin superponerse con ninguno de los dos.
    await highlightTarget({ module: step.module, selector: step.selector });
  }

  async function stepTutorial(delta) {
    const { tutorial, stepIndex } = TUTORIAL_STATE;
    if (!tutorial) return;
    const next = stepIndex + delta;
    if (next < 0) return;
    if (next >= tutorial.steps.length) {
      closeTutorial();
      if (typeof showToast === 'function') showToast('¡Tutorial completado!', 'success');
      return;
    }
    TUTORIAL_STATE.stepIndex = next;
    await renderTutorialStep();
  }

  function closeTutorial() {
    document.getElementById('assistant-tutorial-bar')?.classList.remove('open');
    TUTORIAL_STATE.tutorial = null;
  }

  function open() {
    injectStyles();
    ensureFloatButton();
    ensurePanel();
    document.getElementById('assistant-panel')?.classList.add('open');
    STATE.open = true;
    if (!STATE.history.length) {
      appendMessage('bot', isOffline()
        ? 'Estoy en modo local: puedo buscar en los artículos de ayuda guardados, aunque no haya conexión con la PC principal.'
        : '¡Hola! Soy el Tecno Asistente. Pregúntame cómo hacer algo en el sistema.');
    }
    document.getElementById('assistant-input')?.focus();
  }

  function close() {
    document.getElementById('assistant-panel')?.classList.remove('open');
    STATE.open = false;
  }

  function toggle() {
    STATE.open ? close() : open();
  }

  function setModuleContext(name) {
    STATE.currentModule = name || null;
  }

  async function ask(question) {
    appendMessage('user', question);
    STATE.history.push({ role: 'user', text: question });
    STATE.lastQuestion = question;

    const thinking = appendMessage('bot', 'Buscando…');

    try {
      const result = await api.askAssistant({
        question,
        module: STATE.currentModule,
        planCode: currentPlanCode(),
        businessType: currentBusinessType(),
      });
      thinking.textContent = result.answer;
      STATE.history.push({ role: 'assistant', text: result.answer });
      appendSources(result.sources);
    } catch (err) {
      thinking.textContent = isOffline()
        ? 'No pude consultar al asistente ahora mismo (sin conexión con la PC principal). Intenta de nuevo cuando vuelva la red.'
        : 'No pude procesar la pregunta. Intenta de nuevo.';
      console.warn('[assistant] Error en ask():', err.message);
    }
  }

  async function escalate() {
    const transcript = STATE.history.map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.text}`).join('\n\n');
    try {
      await api.escalateToSupport({ transcript, module: STATE.currentModule });
      appendMessage('bot', 'Listo, lo escalé a soporte. Te contactaremos pronto.');
      if (typeof showToast === 'function') showToast('Consulta escalada a soporte', 'success');
    } catch (err) {
      appendMessage('bot', 'No pude escalar la consulta ahora mismo. Intenta de nuevo en unos minutos.');
      console.warn('[assistant] Error en escalate():', err.message);
    }
  }

  // ── Centro de Ayuda (dentro de Configuración) ──────────────────────────
  let _helpArticlesCache = [];

  function ensureHelpCenterModal() {
    if (document.getElementById('assistant-help-modal')) return;
    injectStyles();
    const modal = document.createElement('div');
    modal.id = 'assistant-help-modal';
    modal.innerHTML = `
      <div id="assistant-help-box">
        <div id="assistant-help-header">
          <h3>❓ Centro de Ayuda</h3>
          <button type="button" id="assistant-help-close" aria-label="Cerrar">✕</button>
        </div>
        <input type="text" id="assistant-help-search" placeholder="Buscar en los artículos de ayuda…">
        <div id="assistant-help-tutorials-title">Tutoriales guiados</div>
        <div id="assistant-help-tutorials"></div>
        <div id="assistant-help-list"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeHelpCenterModal(); });
    modal.querySelector('#assistant-help-close').addEventListener('click', closeHelpCenterModal);
    modal.querySelector('#assistant-help-search').addEventListener('input', (e) => {
      renderHelpArticles(filterArticles(e.target.value));
    });
  }

  function filterArticles(term) {
    const t = String(term || '').trim().toLowerCase();
    if (!t) return _helpArticlesCache;
    return _helpArticlesCache.filter((a) =>
      a.title.toLowerCase().includes(t) || a.content.toLowerCase().includes(t)
    );
  }

  function renderHelpArticles(articles) {
    const list = document.getElementById('assistant-help-list');
    if (!list) return;
    if (!articles.length) {
      list.innerHTML = '<div class="assistant-help-empty">No encontré artículos para esa búsqueda.</div>';
      return;
    }
    list.innerHTML = '';
    articles.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'assistant-help-article';
      card.innerHTML = `<h4>${a.title}</h4><p></p>`;
      card.querySelector('p').textContent = a.content;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.assistant-show-me-btn')) return;
        card.classList.toggle('expanded');
      });
      if (a.uiSelector) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'assistant-show-me-btn';
        btn.textContent = '📍 Muéstrame dónde';
        btn.style.marginTop = '.5rem';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          highlightTarget({ module: a.uiModule, selector: a.uiSelector });
        });
        card.appendChild(btn);
      }
      list.appendChild(card);
    });
  }

  function renderHelpTutorials(tutorials) {
    const box = document.getElementById('assistant-help-tutorials');
    const title = document.getElementById('assistant-help-tutorials-title');
    if (!box) return;
    if (!tutorials.length) {
      box.style.display = 'none';
      if (title) title.style.display = 'none';
      return;
    }
    box.style.display = 'flex';
    if (title) title.style.display = 'block';
    box.innerHTML = '';
    tutorials.forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'assistant-tutorial-chip';
      chip.textContent = `▶ ${t.title}`;
      chip.title = t.description || '';
      chip.addEventListener('click', () => startTutorial(t.slug));
      box.appendChild(chip);
    });
  }

  async function openHelpCenterModal() {
    ensureHelpCenterModal();
    document.getElementById('assistant-help-modal')?.classList.add('open');
    const list = document.getElementById('assistant-help-list');
    if (list) list.innerHTML = '<div class="assistant-help-empty">Cargando…</div>';
    const ctx = { planCode: currentPlanCode(), businessType: currentBusinessType() };
    try {
      const [articlesRes, tutorialsRes] = await Promise.all([
        api.getHelpArticles(ctx),
        api.getTutorials(ctx).catch(() => ({ tutorials: [] })),
      ]);
      _helpArticlesCache = articlesRes.articles || [];
      renderHelpArticles(_helpArticlesCache);
      renderHelpTutorials(tutorialsRes.tutorials || []);
    } catch (err) {
      if (list) list.innerHTML = '<div class="assistant-help-empty">No se pudo cargar el Centro de Ayuda ahora mismo.</div>';
      console.warn('[assistant] Error cargando artículos:', err.message);
    }
  }

  function closeHelpCenterModal() {
    document.getElementById('assistant-help-modal')?.classList.remove('open');
  }

  window.TecnoAsistente = { open, close, toggle, setModuleContext, ask, escalate, highlightTarget, startTutorial };
  window.openHelpCenterModal = openHelpCenterModal;

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    ensureFloatButton();
    ensurePanel();
  });
})();
