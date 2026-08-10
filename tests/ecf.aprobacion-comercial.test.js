'use strict';

const {
  normalizeAcecfDateTime,
  parseOfficialAcecfFilename,
  resolveAcecfDatasetDateTime,
} = require('../modules/ecf/services/ecf.service');

describe('Paso 3 - Aprobaciones Comerciales', () => {
  test('extrae RNC y fecha del nombre oficial DGII', () => {
    const info = parseOfficialAcecfFilename('40211932609-09082026215825.xlsx');
    expect(info.rncComprador).toBe('40211932609');
    expect(normalizeAcecfDateTime(info.generatedAt)).toBe('09-08-2026 21:58:25');
  });

  test('conserva la fecha del conjunto aunque el nombre corresponda a una descarga posterior', () => {
    const info = parseOfficialAcecfFilename('40211932609-09082026221048.xlsx');
    expect(resolveAcecfDatasetDateTime(info, '09-08-2026 21:58:24'))
      .toBe('09-08-2026 21:58:24');
  });

  test('conserva la fecha de la celda cuando corresponde al archivo actual', () => {
    const info = parseOfficialAcecfFilename('40211932609-21072026193710.xlsx');
    expect(resolveAcecfDatasetDateTime(info, '21-07-2026 19:37:09'))
      .toBe('21-07-2026 19:37:09');
  });

  test('no inventa una fecha desde el nombre cuando la celda está vacía o es inválida', () => {
    const info = parseOfficialAcecfFilename('40211932609-09082026221048.xlsx');
    expect(resolveAcecfDatasetDateTime(info, '')).toBe('');
    expect(resolveAcecfDatasetDateTime(info, 'fecha-invalida')).toBe('');
  });

  test('rechaza nombres renombrados o sin el patrón oficial', () => {
    expect(parseOfficialAcecfFilename('aprobaciones-nuevas.xlsx')).toBeNull();
  });

  test('normaliza la fecha que DGII devuelve con AM/PM', () => {
    expect(normalizeAcecfDateTime('8/9/2026 9:58:24 PM'))
      .toBe('09-08-2026 21:58:24');
  });
});
