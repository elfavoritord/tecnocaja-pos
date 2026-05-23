'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_SEED_HISTORY,
  SeedStorageService,
} = require('../modules/ecf/services/seed-storage.service');

describe('seed-storage.service', () => {
  let tempDir;
  let currentTime;
  let service;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-seeds-'));
    currentTime = new Date('2026-05-20T22:08:47.000Z');
    service = new SeedStorageService({
      baseDir: tempDir,
      now: () => new Date(currentTime),
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('guarda la semilla actual, version firmada e historial en storage/ecf/seeds', () => {
    const entry = service.saveSeed({
      seedXml: '<SemillaModel><valor>123</valor></SemillaModel>',
      seedValue: '123',
      seedDate: '2026-05-20T22:08:47',
      environment: 'testecf',
    });

    const signed = service.markSigned({
      id: entry.id,
      signedXml: '<SemillaModel><valor>123</valor><Signature/></SemillaModel>',
    });

    const state = service.getState();
    const currentSeedPath = path.join(tempDir, 'storage', 'ecf', 'seeds', 'current-semilla.xml');
    const currentSignedSeedPath = path.join(tempDir, 'storage', 'ecf', 'seeds', 'current-semilla-firmada.xml');
    const historyPath = path.join(tempDir, 'storage', 'ecf', 'seeds', 'history.json');

    expect(fs.existsSync(currentSeedPath)).toBe(true);
    expect(fs.existsSync(currentSignedSeedPath)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, entry.xmlPath))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, signed.signedPath))).toBe(true);
    expect(fs.existsSync(historyPath)).toBe(true);
    expect(state.current).toMatchObject({
      id: entry.id,
      environment: 'testecf',
      estado: 'firmada',
      seedDetected: true,
      hasSignedXml: true,
    });
  });

  test('preserva el BOM y el contenido exacto del XML firmado', () => {
    const entry = service.saveSeed({
      seedXml: '<SemillaModel><valor>123</valor></SemillaModel>',
      seedValue: '123',
      environment: 'testecf',
    });

    const signedXml = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<SemillaModel><Signature/></SemillaModel>\r\n';
    service.markSigned({
      id: entry.id,
      signedXml,
    });

    const currentSignedSeedPath = path.join(tempDir, 'storage', 'ecf', 'seeds', 'current-semilla-firmada.xml');
    const saved = fs.readFileSync(currentSignedSeedPath, 'utf8');

    expect(saved).toBe(signedXml);
  });

  test('mantiene solo las ultimas 20 semillas y elimina las viejas', () => {
    for (let index = 0; index < MAX_SEED_HISTORY + 5; index += 1) {
      currentTime = new Date(currentTime.getTime() + 1000);
      service.saveSeed({
        seedXml: `<SemillaModel><valor>${index}</valor></SemillaModel>`,
        seedValue: String(index),
        environment: 'testecf',
      });
    }

    const state = service.getState();
    expect(state.history).toHaveLength(MAX_SEED_HISTORY);

    currentTime = new Date(currentTime.getTime() + (61 * 60 * 1000));
    const expiredState = service.getState();
    expect(expiredState.history).toHaveLength(0);
  });
});
