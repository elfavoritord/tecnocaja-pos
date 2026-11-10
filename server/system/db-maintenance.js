'use strict';
const { AsyncLocalStorage } = require('async_hooks');
function createDatabaseMaintenance() {
  const owner = new AsyncLocalStorage();
  let exclusive = false, active = 0;
  const blocked = () => Object.assign(new Error('Base de datos en recuperación. Reintenta al terminar.'), { code: 'RESTORE_IN_PROGRESS', statusCode: 503 });
  async function guard(work) {
    if (owner.getStore()) return work();
    if (exclusive) throw blocked();
    active++;
    try { return await owner.run(false, work); } finally { active--; }
  }
  async function runExclusive(work, timeoutMs = 15000) {
    if (exclusive) throw blocked();
    exclusive = true;
    try {
      const until = Date.now() + timeoutMs;
      while (active) {
        if (Date.now() >= until) throw new Error('Hay tareas de base de datos activas. No se inició la recuperación.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return await owner.run(true, work);
    } finally { exclusive = false; }
  }
  return { guard, runExclusive };
}
module.exports = { createDatabaseMaintenance };
