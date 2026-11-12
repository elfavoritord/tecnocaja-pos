'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readWizardState, writeWizardState } = require('../modules/ecf/utils/cert-wizard-state.util');
const backups = require('../server/services/backup-components');

const stateFor = (step) => ({ currentStep: step, completedSteps: Array.from({ length: step - 1 }, (_, i) => i + 1),
  steps: { 1: { data: { rnc: '133607336' } }, 4: { data: { batchId: 'lote-existente', trackId: 'track-existente' } } },
  manualResetSteps: [], environment: 'certecf', updatedAt: '2026-11-12T12:00:00Z' });
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe('conservar certificación DGII al actualizar', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cert-preserve-')); });
  afterEach(() => {
    // Solo se elimina la carpeta temporal creada por esta prueba.
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('tc-cert-preserve-')) throw new Error('Carpeta de prueba inesperada');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  test.each([4, 5])('migra el paso %i a la ruta permanente y conserva lote, TrackID y reinicios manuales', (step) => {
    const legacy = path.join(root, 'instalado/storage/ecf/cert-wizard-state.json');
    const active = path.join(root, 'datos/storage/ecf/cert-wizard-state.json');
    const state = stateFor(step); state.manualResetSteps = [4];
    put(legacy, JSON.stringify(state));
    expect(readWizardState(active, [legacy])).toEqual(state);
    expect(JSON.parse(fs.readFileSync(active, 'utf8'))).toEqual(state);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  test('un avance actual o reinicio explícito prevalece sobre copias antiguas', () => {
    const file = path.join(root, 'state.json'); const legacy = path.join(root, 'legacy.json');
    writeWizardState(file, stateFor(1)); put(legacy, JSON.stringify(stateFor(5)));
    expect(readWizardState(file, [legacy]).currentStep).toBe(1);
  });

  test('recupera el último archivo válido si el principal está cortado y rechaza pasos inventados', () => {
    const file = path.join(root, 'state.json');
    writeWizardState(file, stateFor(4)); writeWizardState(file, stateFor(5));
    put(file, '{"currentStep":');
    expect(readWizardState(file)).toEqual(stateFor(4));
    expect(() => writeWizardState(file, { currentStep: 16, completedSteps: [] })).toThrow(/válidos/);
    expect(readWizardState(file)).toEqual(stateFor(4));
  });

  test('el respaldo incluye el avance y su copia junto con el E32 firmado', async () => {
    const prev = process.env.TECNO_CAJA_USER_DATA;
    process.env.TECNO_CAJA_USER_DATA = root;
    try {
      const component = backups.defaultComponents().find((c) => c.id === 'ecf-archivos');
      writeWizardState(path.join(component.root, 'cert-wizard-state.json'), stateFor(5));
      put(path.join(component.root, 'ecf-originales-locales/E320000000018.xml'), '<ECF>firmado</ECF>');
      put(path.join(component.root, 'secreto-no-incluido.json'), '{}');
      const archive = await backups.capturar({ components: [component] });
      expect(archive.archivos.map((f) => f.path).sort()).toEqual(['cert-wizard-state.json', 'cert-wizard-state.json.bak', 'ecf-originales-locales/E320000000018.xml']);
      put(path.join(component.root, 'cert-wizard-state.json'), 'cortado');
      const staged = await backups.preparar(archive, { components: [component] });
      await staged.commit(); await staged.terminar();
      expect(readWizardState(path.join(component.root, 'cert-wizard-state.json'))).toEqual(stateFor(5));
    } finally { if (prev === undefined) delete process.env.TECNO_CAJA_USER_DATA; else process.env.TECNO_CAJA_USER_DATA = prev; }
  });

  test.each([true, false])('el certificado preservado solo se usa si coincide su identidad: %s', async (matches) => {
    const directory = path.join(root, 'certificates');
    put(path.join(directory, 'business-1-active.p12'), 'certificado-fixture');
    const source = fs.readFileSync(path.join(__dirname, '../modules/ecf/services/ecf.service.js'), 'utf8');
    const start = source.indexOf('  async resolveCertificate()');
    const end = source.indexOf('\n  async getCertificateStatus()', start);
    const signatureService = {
      loadCertificate: jest.fn(() => ({ serialNumber: matches ? 'abcd' : 'otra', issuer: 'Emisor certificado' })),
      validateCertificate: jest.fn(() => ({ isValidNow: true })),
    };
    const ctx = vm.createContext({ fs, path, CERT_STORAGE_DIR: directory, signatureService, EcfError: Error, decryptTextWithLegacyFallback: () => 'clave' });
    vm.runInContext(source.slice(start, end).replace('async resolveCertificate()', 'async function resolveCertificate()'), ctx);
    const service = { config: {}, ensureReady: async () => {}, repository: {
      getCertificate: async () => ({ certificate_path: path.join(root, 'version-vieja/business-1-active.p12'), serial_number: 'ABCD', issuer: 'Emisor certificado' }),
      getResolvedEmitter: async () => ({ rnc: '133607336' }),
    } };
    const result = ctx.resolveCertificate.call(service);
    if (matches) {
      expect((await result).serialNumber).toBe('abcd');
      expect(signatureService.loadCertificate.mock.calls[0][0].certPath).toBe(path.join(directory, 'business-1-active.p12'));
      expect(signatureService.validateCertificate).toHaveBeenCalledWith(expect.anything(), { expectedRnc: '133607336' });
    } else {
      await expect(result).rejects.toThrow('no coincide');
      expect(signatureService.validateCertificate).not.toHaveBeenCalled();
    }
  });

  const windowsTest = process.platform === 'win32' ? test : test.skip;
  windowsTest('el instalador conserva XML, certificado y avance antes de reemplazar archivos, sin sobrescribir el lote actual', () => {
    const install = path.join(root, 'version vieja'); const data = path.join(root, 'datos permanentes');
    const rel = 'storage/ecf/ecf-originales-locales/E320000000018.xml';
    put(path.join(install, rel), '<ECF>anterior firmado</ECF>');
    put(path.join(data, rel), '<ECF>actual firmado</ECF>');
    put(path.join(install, 'storage/ecf/cert-wizard-state.json'), JSON.stringify(stateFor(5)));
    put(path.join(install, 'ecf/certificates/business-1-active.p12'), 'certificado-fixture');
    put(path.join(install, 'resources/firebase-key.json'), '{"type":"service_account","private_key":"fixture"}');
    const script = path.resolve(__dirname, '../build/preserve-certification.ps1');
    const run = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-InstallDir', install, '-UserDataPath', data, '-PreviousUserInstall', '', '-PreviousMachineInstall', ''], { windowsHide: true, env: { ...process.env, TECNO_CAJA_USER_DATA: '' }, encoding: 'utf8' });
    expect(run()).toContain('CERTIFICATION_PRESERVED');
    expect(run()).toContain('copied=0');
    expect(fs.readFileSync(path.join(data, rel), 'utf8')).toBe('<ECF>actual firmado</ECF>');
    expect(readWizardState(path.join(data, 'storage/ecf/cert-wizard-state.json'))).toEqual(stateFor(5));
    expect(fs.readFileSync(path.join(data, 'ecf/certificates/business-1-active.p12'), 'utf8')).toBe('certificado-fixture');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'config/firebase-key.json'), 'utf8')).private_key).toBe('fixture');
    expect(fs.readFileSync(path.join(install, rel), 'utf8')).toBe('<ECF>anterior firmado</ECF>');
    expect(fs.readdirSync(path.join(data, 'certification-recovery')).length).toBeGreaterThan(0);
  }, 30000);

  windowsTest('detiene la conservación si el destino sería borrado junto con la instalación', () => {
    const install = path.join(root, 'instalacion');
    const original = path.join(install, 'storage/ecf/cert-wizard-state.json');
    put(original, JSON.stringify(stateFor(5)));
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve(__dirname, '../build/preserve-certification.ps1'), '-InstallDir', install,
      '-UserDataPath', path.join(install, 'runtime-data')], {
      windowsHide: true, env: { ...process.env, TECNO_CAJA_USER_DATA: '' }, stdio: 'pipe',
    })).toThrow();
    expect(JSON.parse(fs.readFileSync(original, 'utf8'))).toEqual(stateFor(5));
  }, 30000);
});

describe('reanudar el asistente sin marcar ni reenviar pasos', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/ecf-cert-wizard.js'), 'utf8');
  const start = source.indexOf('  function defaultState()');
  const end = source.indexOf('\n  async function saveState(', start);
  async function load(server, local, rnc = '133607336') {
    const fiscalApi = jest.fn(async (method) => {
      if (method === 'GET') { if (server instanceof Error) throw server; return { state: server }; }
      return { ok: true };
    });
    const ctx = vm.createContext({ fiscalApi, localStorage: { getItem: () => JSON.stringify(local) },
      WZ: {}, STEPS: Array.from({ length: 15 }), DB: { config: { rnc } } });
    vm.runInContext(source.slice(start, end), ctx);
    await ctx.loadState();
    return { state: ctx.WZ.state, fiscalApi };
  }
  test.each([4, 5])('con servidor sin archivo recupera el paso %i de la copia local', async (step) => {
    const r = await load(null, stateFor(step));
    expect(r.state.currentStep).toBe(step);
    expect(r.fiscalApi.mock.calls.map((c) => c[0])).toEqual(['GET', 'POST']);
    expect(r.fiscalApi.mock.calls[1][1]).toBe('/wizard/state');
  });
  test('el estado del servidor prevalece aunque la copia local vaya más adelantada', async () => {
    const r = await load(stateFor(4), stateFor(5));
    expect(r.state.currentStep).toBe(4);
    expect(r.fiscalApi).toHaveBeenCalledTimes(1);
  });
  test('si falla la consulta conserva el avance local sin enviar comprobantes', async () => {
    expect((await load(new Error('sin conexión'), stateFor(5))).state.currentStep).toBe(5);
  });
  test('no importa el avance local de otra empresa', async () => {
    const r = await load(null, stateFor(5), '999999999');
    expect(r.state.currentStep).toBe(1);
    expect(r.fiscalApi).toHaveBeenCalledTimes(1);
  });
});
