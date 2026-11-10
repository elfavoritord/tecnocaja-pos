'use strict';
const { createDatabaseMaintenance } = require('../../server/system/db-maintenance');
test('espera tareas previas, rechaza trabajos externos y permite la recuperación y luego vuelve a abrir', async () => {
  const gate = createDatabaseMaintenance();
  let endPrevious;
  const previous = gate.guard(() => new Promise((resolve) => { endPrevious = resolve; }));
  let entered = false, endRecovery;
  const recovery = gate.runExclusive(async () => {
    entered = true;
    expect(await gate.guard(() => 'permitido')).toBe('permitido');
    await new Promise((resolve) => { endRecovery = resolve; });
  });
  await expect(gate.guard(() => 'externo')).rejects.toMatchObject({ code: 'RESTORE_IN_PROGRESS' });
  expect(entered).toBe(false);
  endPrevious(); await previous;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(entered).toBe(true);
  await expect(gate.guard(() => 'externo')).rejects.toThrow(/recuperación/);
  endRecovery(); await recovery;
  expect(await gate.guard(() => 'normal')).toBe('normal');
});
test('libera el bloqueo si la restauración falla', async () => {
  const gate = createDatabaseMaintenance();
  await expect(gate.runExclusive(() => { throw new Error('fallo'); })).rejects.toThrow('fallo');
  expect(await gate.guard(() => 1)).toBe(1);
});
