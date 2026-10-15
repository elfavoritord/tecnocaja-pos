'use strict';

/**
 * Genera terminos.html para la página web (tecnocajapos.web.app) a partir de
 * legal/terminos-y-condiciones.md, el mismo texto que se ve desde el inicio de
 * sesión del POS. Así hay un solo documento y la web no se queda atrás.
 *
 * Uso:
 *   node scripts/legal/exportar-terminos-web.js "<carpeta de la página web>"
 * Por defecto: F:\sistema pos\tecno caja pos web\tecnocaja
 */

const fs = require('fs');
const path = require('path');
const { markdownAHtml } = require('../../js/terminos.js');

const RAIZ = path.join(__dirname, '..', '..');
const DOCUMENTO = path.join(RAIZ, 'legal', 'terminos-y-condiciones.md');
const DESTINO = path.resolve(process.argv[2] || 'F:\\sistema pos\\tecno caja pos web\\tecnocaja');
const URL_PAGINA = 'https://tecnocajapos.web.app/terminos';

function construirPagina(contenidoHtml) {
  return `<!DOCTYPE html>
<html lang="es-DO">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Términos y condiciones de uso | Tecno Caja POS</title>
<meta name="description" content="Términos y condiciones de uso de Tecno Caja POS, el sistema de punto de venta de Emilio Digital Solutions para negocios en República Dominicana.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${URL_PAGINA}">
<meta name="theme-color" content="#0B5CE0">
<link rel="icon" href="favicon.ico?v=2" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="icons/icon-32.png?v=2">
<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="css/styles.css">
<style>
  .legal-top{background:#fff;border-bottom:1px solid var(--line)}
  .legal-top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:72px}
  .legal-logo{display:flex;align-items:center;gap:10px;font-family:'Sora';font-weight:700;font-size:1.15rem}
  .legal-logo img{width:36px;height:36px;border-radius:9px}
  .legal-logo span{color:var(--blue)}
  .legal-back{font-family:'Sora';font-weight:600;font-size:.92rem;color:var(--blue)}
  .legal-main{padding:48px 0 72px}
  .legal-doc{max-width:860px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);padding:48px 56px;box-shadow:var(--shadow-sm)}
  .legal-doc h1{font-size:clamp(1.6rem,3.4vw,2.2rem);font-weight:700;margin-bottom:6px}
  .legal-doc h1 + h2{margin-top:0;font-size:1.05rem;font-weight:500;color:var(--slate);font-family:'Inter'}
  .legal-doc h2{font-size:1.3rem;font-weight:700;margin:36px 0 12px}
  .legal-doc h3{font-size:1.06rem;font-weight:600;margin:24px 0 8px}
  .legal-doc h4{font-size:.98rem;font-weight:600;margin:18px 0 6px}
  .legal-doc p,.legal-doc ul{margin:10px 0;color:#2E3A4C}
  .legal-doc ul{padding-left:22px}
  .legal-doc li+li{margin-top:3px}
  .legal-doc strong{color:var(--ink)}
  .legal-doc hr{border:0;border-top:1px solid var(--line);margin:32px 0}
  .tc-terms__tabla{overflow-x:auto}
  .legal-doc table{width:100%;border-collapse:collapse;margin:12px 0;font-size:.95rem}
  .legal-doc th,.legal-doc td{border:1px solid var(--line);padding:10px 14px;text-align:left;vertical-align:top}
  .legal-doc th{background:var(--bg);font-family:'Sora';font-size:.85rem}
  .legal-foot{text-align:center;font-size:.85rem;color:var(--slate);padding-bottom:40px}
  @media(max-width:640px){.legal-doc{padding:28px 20px;border-radius:var(--r)}}
</style>
</head>
<body>
<header class="legal-top">
  <div class="wrap">
    <a class="legal-logo" href="./"><img src="icons/icon-96.png?v=2" width="36" height="36" alt="Logo Tecno Caja POS">Tecno<span>Caja</span></a>
    <a class="legal-back" href="./">← Volver al inicio</a>
  </div>
</header>
<main class="legal-main">
  <div class="wrap">
    <article class="legal-doc">
${contenidoHtml}
    </article>
  </div>
</main>
<p class="legal-foot">© 2026 Emilio Digital Solutions · Tecno Caja POS · Yamasá, Monte Plata, República Dominicana</p>
</body>
</html>
`;
}

function main() {
  if (!fs.existsSync(DESTINO)) {
    console.error(`No existe la carpeta de la página web: ${DESTINO}`);
    process.exit(1);
  }
  const html = construirPagina(markdownAHtml(fs.readFileSync(DOCUMENTO, 'utf8')));
  const archivo = path.join(DESTINO, 'terminos.html');
  fs.writeFileSync(archivo, html, 'utf8');
  console.log(`Listo: ${archivo}`);
}

main();
