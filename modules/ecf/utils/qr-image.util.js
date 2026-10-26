const QRCode = require('qrcode');
const sharp = require('sharp');

const QR_OPTIONS = {
  width: 384,
  margin: 4,
  errorCorrectionLevel: 'M',
  color: {
    dark: '#000000',
    light: '#FFFFFF'
  }
};

async function generateQrDataUrl(text, format = 'png') {
  const payload = String(text || '').trim();
  if (!payload) throw new Error('El texto para el QR es obligatorio.');

  if (String(format).toLowerCase() === 'thermal-png') {
    // En papel térmico, L produce una matriz menos densa y módulos más
    // imprimibles; el texto codificado (URL DGII) permanece exactamente igual.
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'L' });
    const moduleDots = 4;
    const quietModules = 4;
    const matrixSize = qr.modules.size;
    const width = (matrixSize + quietModules * 2) * moduleDots;
    const pixels = Buffer.alloc(width * width, 255);

    // Construir directamente la cuadrícula binaria evita antialiasing y hace
    // que cada módulo mida exactamente 4 puntos de cabezal térmico.
    for (let moduleY = 0; moduleY < matrixSize; moduleY += 1) {
      for (let moduleX = 0; moduleX < matrixSize; moduleX += 1) {
        if (!qr.modules.data[moduleY * matrixSize + moduleX]) continue;
        const startX = (moduleX + quietModules) * moduleDots;
        const startY = (moduleY + quietModules) * moduleDots;
        for (let dotY = 0; dotY < moduleDots; dotY += 1) {
          pixels.fill(0, (startY + dotY) * width + startX, (startY + dotY) * width + startX + moduleDots);
        }
      }
    }

    const png = await sharp(pixels, {
      raw: { width, height: width, channels: 1 }
    }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const physicalWidthMm = width * 25.4 / 203;
    return { dataUrl, physicalWidthMm, width, matrixSize, moduleDots, quietModules };
  }

  if (String(format).toLowerCase() === 'svg') {
    const svg = await QRCode.toString(payload, { ...QR_OPTIONS, type: 'svg' });
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  }

  return QRCode.toDataURL(payload, QR_OPTIONS);
}

module.exports = { generateQrDataUrl };
