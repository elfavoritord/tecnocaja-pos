const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'assets', 'icons', 'icon.png');
const outputPath = path.join(projectRoot, 'assets', 'icons', 'app_icon.png');

function getAlpha(data, width, x, y) {
  return data[(y * width + x) * 4 + 3];
}

async function detectPrimaryMarkBounds() {
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const columns = [];
  for (let x = 0; x < info.width; x += 1) {
    let hits = 0;
    for (let y = 0; y < info.height; y += 1) {
      if (getAlpha(data, info.width, x, y) > 8) hits += 1;
    }
    columns.push(hits);
  }

  const ranges = [];
  let start = null;
  for (let x = 0; x < columns.length; x += 1) {
    if (columns[x] > 0 && start === null) {
      start = x;
    }
    const isLast = x === columns.length - 1;
    if ((columns[x] === 0 || isLast) && start !== null) {
      const end = columns[x] === 0 ? x - 1 : x;
      if (end - start + 1 > 32) {
        ranges.push({ start, end, width: end - start + 1 });
      }
      start = null;
    }
  }

  const primaryRange = ranges[0];
  if (!primaryRange) {
    throw new Error('No se pudo detectar el isotipo principal del logo.');
  }

  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = primaryRange.start; x <= primaryRange.end; x += 1) {
      if (getAlpha(data, info.width, x, y) > 8) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxY < 0) {
    throw new Error('No se pudo calcular la altura del isotipo principal.');
  }

  return {
    left: primaryRange.start,
    top: minY,
    width: primaryRange.width,
    height: maxY - minY + 1,
    imageWidth: info.width,
    imageHeight: info.height,
  };
}

async function generateSquareIconSource() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`No existe el logo fuente: ${sourcePath}`);
  }

  const bounds = await detectPrimaryMarkBounds();
  const maxSide = Math.max(bounds.width, bounds.height);
  const paddedSide = Math.min(
    Math.max(Math.round(maxSide * 1.55), maxSide + 64),
    Math.min(bounds.imageWidth, bounds.imageHeight),
  );

  let left = Math.round(bounds.left - (paddedSide - bounds.width) / 2);
  let top = Math.round(bounds.top - (paddedSide - bounds.height) / 2);

  left = Math.max(0, Math.min(left, bounds.imageWidth - paddedSide));
  top = Math.max(0, Math.min(top, bounds.imageHeight - paddedSide));

  await sharp(sourcePath)
    .extract({
      left,
      top,
      width: paddedSide,
      height: paddedSide,
    })
    .resize(1024, 1024)
    .png()
    .toFile(outputPath);

  console.log(`[generate_app_icon_source] Icono cuadrado generado en ${outputPath}`);
}

if (require.main === module) {
  generateSquareIconSource().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  generateSquareIconSource,
};
