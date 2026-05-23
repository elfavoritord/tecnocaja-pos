'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReceptionStorageService } = require('../modules/ecf/services/reception-storage.service');

describe('reception-storage.service', () => {
  let tempDir;
  let currentTime;
  let service;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tecnocaja-reception-'));
    currentTime = new Date('2026-05-21T04:20:30.000Z');
    service = new ReceptionStorageService({
      baseDir: tempDir,
      now: () => new Date(currentTime),
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('guarda XML enviado y archivos de track', () => {
    const sent = service.saveSentXml({
      xmlContent: '<ECF><Signature/></ECF>',
      environment: 'certecf',
      sourcePath: path.join(tempDir, 'entrada.xml'),
      filename: 'entrada.xml',
    });

    const track = service.saveTrack({
      trackId: 'TRK-123',
      mensaje: 'Documento recibido',
      environment: 'certecf',
      xmlPath: sent.xmlPath,
      httpStatus: 200,
    });

    const status = service.saveTrackStatus({
      trackId: 'TRK-123',
      payload: {
        estado: 'Aceptado',
        codigo: '0',
        descripcion: 'Procesado correctamente',
        rnc: '40211932609',
        encf: 'E470000000011',
        secuenciaUtilizada: true,
        fechaRecepcion: '2026-05-21T04:20:31Z',
        mensajes: [
          { valor: 'Documento aceptado', codigo: 100 },
        ],
      },
      environment: 'certecf',
      httpStatus: 200,
    });

    const state = service.getState();

    expect(fs.existsSync(path.join(tempDir, sent.xmlPath))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, track.trackPath))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, status.statusPath))).toBe(true);
    expect(state.latestSent).toMatchObject({
      environment: 'certecf',
      estado: 'ENVIADO',
    });
    expect(state.latestTrack).toMatchObject({
      trackId: 'TRK-123',
      estado: 'ENVIADO',
    });
    expect(state.latestTrackStatus).toMatchObject({
      trackId: 'TRK-123',
      estado: 'ACEPTADO',
      rnc: '40211932609',
      encf: 'E470000000011',
      secuenciaUtilizada: true,
      fechaRecepcion: '2026-05-21T04:20:31Z',
    });
    expect(state.latestTrackStatus.mensajes).toEqual([
      { valor: 'Documento aceptado', codigo: 100 },
    ]);
  });
});
