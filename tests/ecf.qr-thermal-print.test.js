'use strict';

const jsQR = require('jsqr');
const sharp = require('sharp');
const { buildReceipt } = require('../electron/thermal-printer');
const { buildQrVerificationUrl } = require('../modules/ecf/utils/qr-url.util');
const { generateQrDataUrl } = require('../modules/ecf/utils/qr-image.util');

const SIGNED_ECF = `<?xml version="1.0" encoding="UTF-8"?>
<ECF><Encabezado><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000051</eNCF></IdDoc>
<Emisor><RNCEmisor>40211932609</RNCEmisor><FechaEmision>27-07-2026</FechaEmision></Emisor>
<Comprador><RNCComprador>131880681</RNCComprador></Comprador>
<Totales><MontoTotal>7080.00</MontoTotal></Totales></Encabezado>
<FechaHoraFirma>27-07-2026 14:40:41</FechaHoraFirma>
<Signature><SignatureValue>A+B/CdSampleSignatureValue==</SignatureValue></Signature></ECF>`;

const SIGNED_SMALL_E32 = `<?xml version="1.0" encoding="UTF-8"?>
<ECF><Encabezado><IdDoc><TipoeCF>32</TipoeCF><eNCF>E320000001155</eNCF></IdDoc>
<Emisor><RNCEmisor>40211932609</RNCEmisor><FechaEmision>23-10-2026</FechaEmision></Emisor>
<Totales><MontoTotal>1.18</MontoTotal></Totales></Encabezado>
<FechaHoraFirma>23-10-2026 19:37:00</FechaHoraFirma>
<Signature><SignatureValue>eQkus8ExampleSignature</SignatureValue></Signature></ECF>`;

// GS ( k <pL> <pH> 1 P 0 <datos>: comando nativo que guarda el texto del QR.
function extractNativeQr(receipt) {
  const store = Buffer.from([0x1d, 0x28, 0x6b]);
  for (let offset = receipt.indexOf(store); offset >= 0; offset = receipt.indexOf(store, offset + 1)) {
    if (receipt[offset + 5] === 0x31 && receipt[offset + 6] === 0x50 && receipt[offset + 7] === 0x30) {
      const length = (receipt[offset + 3] | (receipt[offset + 4] << 8)) - 3;
      const sizeOffset = receipt.lastIndexOf(Buffer.from([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x43]), offset);
      return {
        text: receipt.subarray(offset + 8, offset + 8 + length).toString('latin1'),
        moduleSize: receipt[sizeOffset + 7],
      };
    }
  }
  return null;
}

function receiptWithQr(url, paperWidth) {
  return buildReceipt({
    negocio: { nombre: 'Prueba QR' },
    venta: { numeroFactura: 'TEST-QR', items: [], total: 0 },
    config: { paperWidth, mostrarQR: true, qrData: url, cortarPapel: false },
  });
}

describe('QR e-CF en impresión ESC/POS térmica', () => {
  const url = buildQrVerificationUrl(SIGNED_ECF, 'certecf');

  test('conserva la URL exacta construida desde el XML firmado', () => {
    expect(url).toBe(
      'https://ecf.dgii.gov.do/CerteCF/ConsultaTimbre?' +
      'RncEmisor=40211932609' +
      '&RncComprador=131880681' +
      '&ENCF=E310000000051' +
      '&FechaEmision=27-07-2026' +
      '&MontoTotal=7080.00' +
      '&FechaFirma=27-07-2026%2014%3A40%3A41' +
      '&CodigoSeguridad=A%2BB%2FCd'
    );
  });

  test('el E32 menor de RD$250,000 usa la URL corta ConsultaTimbreFC', () => {
    expect(buildQrVerificationUrl(SIGNED_SMALL_E32, 'ecf')).toMatch(
      /^https:\/\/fc\.dgii\.gov\.do\/eCF\/ConsultaTimbreFC\?RncEmisor=40211932609&ENCF=E320000001155&MontoTotal=1\.18&CodigoSeguridad=/
    );
  });

  test('el recibo 80 mm usa el QR nativo de la impresora (módulo 6) con la URL íntegra', () => {
    const receipt = receiptWithQr(url, '80mm');
    const qr = extractNativeQr(receipt);
    expect(qr).not.toBeNull();
    expect(qr.text).toBe(url);
    expect(qr.moduleSize).toBe(6);
    // Sin imagen raster ni cambio de calor (ESC 7): salía de 60 mm y muy grande.
    expect(receipt.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(-1);
    expect(receipt.indexOf(Buffer.from([0x1b, 0x37]))).toBe(-1);
  });

  test('el recibo 58 mm usa módulo 4', () => {
    const qr = extractNativeQr(receiptWithQr(url, '58mm'));
    expect(qr.text).toBe(url);
    expect(qr.moduleSize).toBe(4);
  });

  test('el QR vectorial de impresión conserva la URL y se decodifica de forma independiente', async () => {
    const dataUrl = await generateQrDataUrl(url, 'svg');
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
    expect(svg).toMatch(/<svg[^>]+viewBox="0 0 (\d+) \1"/);
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('stroke="#000000"');

    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(info.height);
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
      inversionAttempts: 'dontInvert',
    });
    expect(decoded).not.toBeNull();
    expect(decoded.data).toBe(url);
  });

  test('el PNG térmico de la vista previa conserva la URL y usa módulos binarios alineados a 203 dpi', async () => {
    const pngResult = await generateQrDataUrl(url, 'thermal-png');
    expect(pngResult.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(pngResult.moduleDots).toBe(4);
    expect(pngResult.quietModules).toBe(4);
    expect(pngResult.physicalWidthMm).toBeGreaterThanOrEqual(30);
    expect(pngResult.physicalWidthMm).toBeLessThanOrEqual(35);

    const png = Buffer.from(pngResult.dataUrl.split(',')[1], 'base64');
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(info.height);
    expect([...new Set(data)].sort((a, b) => a - b)).toEqual([0, 255]);
    const decoded = jsQR(new Uint8ClampedArray(await sharp(png).ensureAlpha().raw().toBuffer()), info.width, info.height, {
      inversionAttempts: 'dontInvert',
    });
    expect(decoded).not.toBeNull();
    expect(decoded.data).toBe(url);
  });
});
