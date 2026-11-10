'use strict';
// Panel de usuario (dos columnas, permisos por casillas) y menú de un usuario
// con permisos propios, en Chrome sin cabeza contra el laboratorio de
// probar-permisos-usuarios.js (--ui). Falla ante cualquier error de JavaScript.
/* global DB, doLogin, showModule, openCreateUserModal, openEditUserModal, euSave, PermisosCatalogo */
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = async function verificarPanelUsuarios({ port, outputDir, cajera, cajeraId }) {
  if (![3485, 3487].includes(port)) throw new Error('Esta prueba solo admite los puertos de laboratorio de permisos.');
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await require('puppeteer').launch({ headless: true });
  const errores = [];
  // Cada usuario en su propio contexto: si no, la segunda página toma la
  // sesión guardada del primero.
  const abrir = async (usuario, clave) => {
    const contexto = await browser.createBrowserContext();
    const page = await contexto.newPage();
    page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED|favicon/i.test(m.text())) errores.push(`console: ${m.text()}`); });
    await page.setRequestInterception(true);
    page.on('request', (r) => (/^(data:|blob:)/.test(r.url()) || r.url().startsWith(`http://127.0.0.1:${port}/`) ? r.continue() : r.abort()));
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.evaluate(async (u, c) => {
      document.getElementById('login-user').value = u;
      document.getElementById('login-pass').value = c;
      await doLogin();
    }, usuario, clave);
    await page.waitForFunction(() => typeof DB !== 'undefined' && DB.currentUser, { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 1500));
    return page;
  };
  try {
    // ── Administrador: crear usuario ─────────────────────────────────────
    const page = await abrir('dueno', 'SoloLaboratorio2026!');
    const foto = (p, nombre) => p.screenshot({ path: path.join(outputDir, `${nombre}.png`) });
    await page.evaluate(() => { showModule('usuarios', document.querySelector('.nav-item[data-module="usuarios"]')); openCreateUserModal(); });
    await page.waitForSelector('#eu-overlay:not(.hidden) #eu-perms-section .eu-perm-check', { timeout: 10000 });
    const crear = await page.evaluate(() => {
      const nombre = document.getElementById('eu-nombre');
      nombre.value = 'María Fernández Peña';
      nombre.dispatchEvent(new Event('input'));
      return {
        pestanas: document.querySelectorAll('#eu-overlay .eu-tab').length,
        columnas: getComputedStyle(document.querySelector('#eu-overlay .eu-grid')).gridTemplateColumns.split(' ').length,
        casillas: document.querySelectorAll('#eu-perms-section .eu-perm-check').length,
        codigos: PermisosCatalogo.CODIGOS.length,
        usuarioSugerido: document.getElementById('eu-usuario').value,
        insignia: document.querySelector('#eu-perms-section .eu-badge').textContent.trim(),
        sincronizacionOculta: document.getElementById('eu-panel-sync').hidden,
      };
    });
    assert.equal(crear.pestanas, 0, 'sin pestañas: todo a la vista');
    assert.equal(crear.columnas, 2, 'dos columnas en pantalla ancha');
    assert.equal(crear.casillas, crear.codigos, 'una casilla por permiso del catálogo');
    assert.equal(crear.usuarioSugerido, 'maria.pena', 'usuario sugerido desde el nombre');
    assert.equal(crear.insignia, 'Según el rol');
    assert.equal(crear.sincronizacionOculta, true, 'al crear no se muestra la sincronización');
    await foto(page, 'usuario-crear');

    // Marcar una casilla lo deja "Personalizado"; volver al rol lo deshace.
    const casillas = await page.evaluate(() => {
      const inv = document.querySelector('#eu-perms-section .eu-perm-check[data-permiso="inventario"]');
      inv.click();
      const tras = { insignia: document.querySelector('#eu-perms-section .eu-badge').textContent.trim(), cambios: document.getElementById('eu-changes-pill').textContent };
      document.querySelector('#eu-perms-section .eu-link-btn').click();
      return { ...tras, despues: document.querySelector('#eu-perms-section .eu-badge').textContent.trim(), invMarcado: document.querySelector('#eu-perms-section .eu-perm-check[data-permiso="inventario"]').checked };
    });
    assert.equal(casillas.insignia, 'Personalizado');
    assert.match(casillas.cambios, /Permisos/);
    assert.deepEqual([casillas.despues, casillas.invMarcado], ['Según el rol', false]);
    // El administrador general tiene todo, sin poder quitarle nada.
    const admin = await page.evaluate(() => {
      document.querySelector('.eu-role-card[data-role="administrador_general"]').click();
      const checks = [...document.querySelectorAll('#eu-perms-section .eu-perm-check')];
      return { todos: checks.every((c) => c.checked), bloqueados: checks.every((c) => c.disabled) };
    });
    assert.deepEqual(admin, { todos: true, bloqueados: true });
    // Guardar vacío: avisa y resalta la sección con el problema.
    const validacion = await page.evaluate(async () => {
      document.querySelector('.eu-role-card[data-role="cajero"]').click();
      document.getElementById('eu-nombre').value = '';
      await euSave();
      return document.getElementById('eu-panel-info').classList.contains('eu-card--aviso');
    });
    assert.equal(validacion, true, 'resalta la sección con el campo que falta');
    await page.evaluate(() => euClose());

    // Editar al usuario personalizado: sus casillas y la insignia.
    await page.evaluate((id) => openEditUserModal(id), cajeraId);
    await page.waitForSelector('#eu-overlay:not(.hidden) #eu-perms-section .eu-perm-check', { timeout: 10000 });
    const editar = await page.evaluate(() => ({
      insignia: document.querySelector('#eu-perms-section .eu-badge').textContent.trim(),
      gaveta: document.querySelector('.eu-perm-check[data-permiso="abrir_gaveta"]').checked,
      inventario: document.querySelector('.eu-perm-check[data-permiso="inventario"]').checked,
      tabla: document.querySelector('#usuarios-tbody, #module-usuarios table')?.textContent.includes('Personalizado') ?? null,
    }));
    assert.deepEqual({ insignia: editar.insignia, gaveta: editar.gaveta, inventario: editar.inventario }, { insignia: 'Personalizado', gaveta: false, inventario: true });
    await page.evaluate(() => { document.getElementById('eu-panel-sync').open = true; });
    await foto(page, 'usuario-editar-personalizado');
    await page.evaluate(() => euClose());
    await foto(page, 'usuarios-lista');

    // ── El usuario personalizado: su menú sale de sus permisos ───────────
    const pc = await abrir(cajera.usuario, cajera.clave);
    const menu = await pc.evaluate(() => Object.fromEntries(['ventas', 'caja', 'inventario', 'productos', 'configuracion', 'usuarios', 'compras']
      .map((m) => [m, Boolean(document.querySelector(`.nav-item[data-module="${m}"]`) && !document.querySelector(`.nav-item[data-module="${m}"]`).classList.contains('hidden'))])));
    const quien = await pc.evaluate(() => JSON.stringify({ rol: DB.currentUser.roleCode, propios: DB.currentUser.permisosPropios, permisos: DB.currentUser.rolePermissions }));
    assert.deepEqual(menu, { ventas: true, caja: true, inventario: true, productos: false, configuracion: false, usuarios: false, compras: false }, `${JSON.stringify(menu)} ${quien}`);
    const puede = await pc.evaluate(() => ({ gaveta: currentUserCan('abrir_gaveta'), inventario: currentUserCan('inventario'), anular: currentUserCan('anular_ventas') }));
    assert.deepEqual(puede, { gaveta: false, inventario: true, anular: false });
    await foto(pc, 'menu-usuario-personalizado');

    assert.deepEqual(errores, [], `errores en la página:\n${errores.join('\n')}`);
    console.log(`OK pantallas de usuarios (capturas en ${outputDir})`);
  } finally { await browser.close(); }
};
