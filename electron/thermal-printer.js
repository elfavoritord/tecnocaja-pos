'use strict';

/**
 * Tecno Caja — Motor de impresión térmica ESC/POS
 * Soporta 58mm (32 cols) y 80mm (48 cols)
 * Envía bytes raw directamente a la impresora via Windows API (PowerShell)
 * Sin dependencias externas — funciona con Node.js puro
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constantes ESC/POS ───────────────────────────────────────────────────────
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

// ─── Tabla de caracteres especiales (CP437 / CP850 — valores reales del codepage) ──
const CHAR_MAP = {
  'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3,
  'Á': 0xB5, 'É': 0x90, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9,
  'ñ': 0xA4, 'Ñ': 0xA5,
  'ü': 0x81, 'Ü': 0x9A,
  'ç': 0x87, 'Ç': 0x80,
  '¿': 0xA8, '¡': 0xAD, '°': 0xF8,
};

/**
 * Convierte string a Buffer con encoding correcto para impresora térmica
 */
function encodeText(str) {
  const bytes = [];
  for (const ch of String(str || '')) {
    const code = CHAR_MAP[ch];
    if (code !== undefined) {
      bytes.push(code);
    } else if (ch.charCodeAt(0) < 256) {
      bytes.push(ch.charCodeAt(0));
    } else {
      bytes.push(0x3F); // '?' para caracteres no soportados
    }
  }
  return Buffer.from(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASE PRINCIPAL: Constructor de comandos ESC/POS
// ─────────────────────────────────────────────────────────────────────────────
class ESCPOSBuilder {
  /**
   * @param {'58mm'|'80mm'} paperWidth
   */
  constructor(paperWidth = '80mm') {
    this.paperWidth = paperWidth;
    this.cols = paperWidth === '58mm' ? 32 : 48;
    this._chunks = [];
  }

  // ── Control básico ──────────────────────────────────────────────────────────

  /** Inicializar impresora (ESC @) */
  init() {
    this._push([ESC, 0x40]);
    // CP437 (default universal) — el CHAR_MAP usa valores reales de este codepage
    this._push([ESC, 0x74, 0x00]);
    return this;
  }

  /** Avance de línea */
  feed(lines = 1) {
    for (let i = 0; i < lines; i++) this._push([LF]);
    return this;
  }

  // ── Formato de texto ────────────────────────────────────────────────────────

  /** Alineación: 0=izquierda, 1=centro, 2=derecha */
  align(a) {
    this._push([ESC, 0x61, a & 0x03]);
    return this;
  }

  /** Negrita */
  bold(on = true) {
    this._push([ESC, 0x45, on ? 1 : 0]);
    return this;
  }

  /** Subrayado */
  underline(on = true) {
    this._push([ESC, 0x2D, on ? 1 : 0]);
    return this;
  }

  /**
   * Tamaño de fuente
   * @param {1|2} w ancho (1=normal, 2=doble)
   * @param {1|2} h alto (1=normal, 2=doble)
   */
  size(w = 1, h = 1) {
    const n = (((h - 1) & 0x07) | (((w - 1) & 0x07) << 4));
    this._push([GS, 0x21, n]);
    return this;
  }

  /** Fuente normal (reset tamaño) */
  normalSize() {
    return this.size(1, 1);
  }

  // ── Texto ───────────────────────────────────────────────────────────────────

  /** Escribe texto con salto de línea al final */
  text(str) {
    this._chunks.push(encodeText(str));
    this._push([LF]);
    return this;
  }

  /** Escribe texto SIN salto de línea */
  write(str) {
    this._chunks.push(encodeText(str));
    return this;
  }

  // ── Layouts ─────────────────────────────────────────────────────────────────

  /** Línea separadora */
  separator(char = '-') {
    return this.text(char.repeat(this.cols));
  }

  /** Doble separador (=) */
  doubleSep() {
    return this.text('='.repeat(this.cols));
  }

  /**
   * Dos columnas: texto izquierda y texto derecha
   * @param {string} left
   * @param {string} right
   */
  row2(left, right) {
    const l = String(left || '');
    const r = String(right || '');
    const gap = this.cols - l.length - r.length;
    if (gap <= 0) {
      // Si no cabe, trunca left
      const maxLeft = this.cols - r.length - 1;
      return this.text(l.substring(0, maxLeft) + ' ' + r);
    }
    return this.text(l + ' '.repeat(gap) + r);
  }

  /**
   * Tres columnas para ítems de venta: cantidad | descripción | precio
   * @param {string|number} qty
   * @param {string} desc
   * @param {string|number} price
   */
  itemRow(qty, desc, price) {
    const qtyStr   = String(qty).padEnd(4);
    const priceStr = String(price).padStart(10);
    const descMax  = this.cols - 4 - 10;
    const descStr  = String(desc).substring(0, descMax).padEnd(descMax);
    return this.text(qtyStr + descStr + priceStr);
  }

  /**
   * Encabezado centrado con negrita opcional
   */
  header(text, bold = true) {
    this.align(1);
    if (bold) this.bold(true);
    this.text(text);
    if (bold) this.bold(false);
    this.align(0);
    return this;
  }

  /**
   * Línea centrada grande (doble alto)
   */
  bigLine(text) {
    this.align(1).size(1, 2).bold(true);
    this.text(text);
    this.bold(false).size(1, 1).align(0);
    return this;
  }

  // ── QR Code (ESC/POS Modelo 2) ──────────────────────────────────────────────

  /**
   * Imprime QR centrado
   * @param {string} data   — datos del QR (URL, texto, etc.)
   * @param {number} size   — tamaño del módulo 1–16 (default 6)
   */
  qrCode(data, size = 6) {
    const str = String(data || '');
    if (!str) return this;

    const dataLen = str.length + 3;
    const pL = dataLen & 0xFF;
    const pH = (dataLen >> 8) & 0xFF;

    this.align(1);

    // Seleccionar Modelo 2
    this._push([GS, 0x28, 0x6B, 4, 0, 0x31, 0x41, 0x32, 0x00]);
    // Tamaño del módulo
    this._push([GS, 0x28, 0x6B, 3, 0, 0x31, 0x43, Math.max(1, Math.min(16, size))]);
    // Corrección de errores nivel M
    this._push([GS, 0x28, 0x6B, 3, 0, 0x31, 0x45, 0x31]);
    // Almacenar datos
    this._push([GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]);
    this._chunks.push(encodeText(str));
    // Imprimir QR
    this._push([GS, 0x28, 0x6B, 3, 0, 0x31, 0x51, 0x30]);

    this.align(0);
    return this;
  }

  // ── Hardware ─────────────────────────────────────────────────────────────────

  /**
   * Corte de papel
   * @param {boolean} partial true=corte parcial, false=corte completo
   */
  cut(partial = false) {
    this._push([GS, 0x56, partial ? 0x41 : 0x42, 0x00]);
    return this;
  }

  /**
   * Pulso para abrir gaveta registradora
   * @param {0|1} pin 0=pin2, 1=pin5
   */
  openDrawer(pin = 0) {
    this._push([ESC, 0x70, pin & 0x01, 0x19, 0xFA]);
    return this;
  }

  // ── Imagen raster ESC/POS (GS v 0) ─────────────────────────────────────────
  /**
   * Imprime imagen monocromática (1 bit/pixel).
   * @param {{ width, height, bytesPerLine, data: number[] }} logoMono
   */
  rasterImage(logoMono) {
    if (!logoMono?.data?.length || !logoMono.width || !logoMono.height) return this;
    const { bytesPerLine, height, data } = logoMono;
    const xL = bytesPerLine & 0xFF;
    const xH = (bytesPerLine >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;
    this._push([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    this._chunks.push(Buffer.from(data));
    return this;
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  /** Genera el Buffer final con todos los comandos */
  build() {
    return Buffer.concat(this._chunks);
  }

  // ── Interno ──────────────────────────────────────────────────────────────────
  _push(bytes) {
    this._chunks.push(Buffer.from(bytes));
    return this;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR DE RECIBO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye el buffer ESC/POS completo de un recibo de venta
 *
 * @param {object} data
 * @param {object} data.negocio        — { nombre, rnc, direccion, telefono }
 * @param {object} data.venta          — { numeroFactura, fecha, cajero, cliente, items[], subtotal, descuento, impuesto, total, pagos[], cambio }
 * @param {object} data.config         — { paperWidth, cortarPapel, abrirGaveta, mostrarQR, qrData, mensaje }
 * @returns {Buffer}
 */
function formatEscPosDate(value) {
  const str = String(value || '').trim();
  if (!str) return new Date().toLocaleDateString('es-DO');
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
    }
  }
  return str;
}

function buildReceipt(data) {
  const { negocio = {}, venta = {}, config = {} } = data;
  const paperWidth = config.paperWidth || '80mm';
  const p = new ESCPOSBuilder(paperWidth);
  const COLS = p.cols;
  const is58 = paperWidth === '58mm';

  const fmtAmt = (n) => Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = (n) => { const v = Number(n || 0); return Number.isInteger(v) ? String(v) : v.toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  const padR = (s, n) => String(s || '').substring(0, n).padEnd(n);
  const padL = (s, n) => String(s || '').substring(0, n).padStart(n);

  p.init();

  // ── Logo (si existe) ────────────────────────────────────────────────────────
  if (negocio.logoMono) {
    p.align(1);
    p.rasterImage(negocio.logoMono);
    p.feed(1).align(0);
  }

  // halfCols se calcula después, lo calculamos aquí anticipando su uso en el encabezado.
  const halfCols = Math.floor(COLS / 2);

  // ── Encabezado negocio (centrado) ──────────────────────────────────────────
  p.align(1);
  if (negocio.nombre) {
    const nombreSize = negocio.nombre.length <= halfCols ? [1, 2] : [1, 1];
    p.bold(true).size(...nombreSize).text(negocio.nombre).size(1, 1).bold(false);
  }
  if (negocio.rnc)       p.text(`RNC: ${negocio.rnc}`);
  if (negocio.direccion) p.text(negocio.direccion);
  if (negocio.telefono)  p.text(`Tel: ${negocio.telefono}`);
  p.align(0);
  p.separator('-');

  // ── Tipo de documento (centrado) ───────────────────────────────────────────
  const documentTitle = String(
    venta.documentTitle
    || (venta.tipoComprobante === 'factura-electronica' ? 'FACTURA ELECTRONICA' : 'FACTURA DE VENTA')
  );
  p.align(1);
  p.bold(true).size(1, 2).text(documentTitle).size(1, 1).bold(false);
  p.bold(true).text(String(venta.documentNumber || `Factura ${venta.numeroFactura || ''}`)).bold(false);
  if (venta.estadoFiscal) p.bold(true).text(String(venta.estadoFiscal).toUpperCase()).bold(false);
  p.align(0);
  p.separator('-');

  // ── Datos del comprobante ──────────────────────────────────────────────────
  p.align(1).bold(true).text(String(venta.dataSectionTitle || 'DATOS DEL COMPROBANTE')).bold(false).align(0);

  const detailRows = [
    [String(venta.primaryLabel || 'FACTURA').toUpperCase(), venta.numeroFactura || ''],
    ['FECHA',   formatEscPosDate(venta.fecha)],
    ['CAJERO',  venta.cajero || ''],
    ['CLIENTE', venta.cliente || 'Consumidor Final'],
    [String(venta.methodRowLabel || 'METODO').toUpperCase(), venta.metodo || 'Efectivo'],
  ];
  if (venta.ncf) detailRows.push(['NCF', venta.ncf]);
  detailRows.filter(([, v]) => String(v || '').trim()).forEach(([lbl, val]) => {
    p.row2(lbl, String(val));
  });
  p.separator('-');

  // ── Cabecera y filas de ítems (4 columnas) ─────────────────────────────────
  const totalCol = is58 ? 7 : 9;
  const priceCol = is58 ? 7 : 8;
  const qtyCol   = is58 ? 3 : 4;
  const nameCol  = COLS - qtyCol - priceCol - totalCol - 3;

  p.bold(true).text(`${padR('ARTICULO', nameCol)} ${padL('CANT', qtyCol)} ${padL('VALOR', priceCol)} ${padL('TOTAL', totalCol)}`).bold(false);
  p.separator('-');

  const items = Array.isArray(venta.items) ? venta.items : [];
  for (const item of items) {
    const desc  = String(item.descripcion || item.nombre || '');
    const qty   = Number(item.cantidad || 1);
    const qtyText = String(item.cantidadTexto || fmtQty(qty));
    const price = Number(item.precio || 0);
    const total = Number(item.subtotal ?? (price * qty));

    const nameLines = [];
    for (let i = 0; i < desc.length; i += nameCol) {
      nameLines.push(desc.substring(i, i + nameCol));
      if (nameLines.length >= (is58 ? 3 : 4)) break;
    }
    if (!nameLines.length) nameLines.push('');

    p.text(`${padR(nameLines[0], nameCol)} ${padL(qtyText, qtyCol)} ${padL(fmtAmt(price), priceCol)} ${padL(fmtAmt(total), totalCol)}`);
    nameLines.slice(1).forEach((line) => p.text(line));
    if (item.variante) p.text(`  > ${item.variante}`);
    if (item.notas)    p.text(`  * ${item.notas}`);
  }

  p.separator('-');

  // ── Totales ────────────────────────────────────────────────────────────────
  if (Number(venta.descuento) > 0) {
    p.row2('Subtotal:', fmtAmt(venta.subtotal));
    p.row2('Descuento:', `-${fmtAmt(venta.descuento)}`);
  } else {
    p.row2('Subtotal:', fmtAmt(venta.subtotal));
  }
  if (Number(venta.impuesto) > 0) {
    p.row2('ITBIS:', fmtAmt(venta.impuesto));
  }
  p.separator('=');
  p.bold(true).size(1, 2).row2('TOTAL', fmtAmt(venta.total)).size(1, 1).bold(false);

  if (Number(venta.cambio) > 0) {
    p.row2('Cambio:', fmtAmt(venta.cambio));
  }

  // ── QR ────────────────────────────────────────────────────────────────────
  if (config.mostrarQR && config.qrData) {
    p.align(1).feed(1);
    p.qrCode(config.qrData, is58 ? 4 : 6);
    p.feed(1).align(0);
  }

  // ── Mensaje final ─────────────────────────────────────────────────────────
  p.feed(1).align(1).text(config.mensaje || '¡Gracias por su compra!').align(0);

  p.feed(3);

  if (config.abrirGaveta) p.openDrawer(0);
  if (config.cortarPapel !== false) p.cut(false);

  return p.build();
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVÍO RAW A IMPRESORA WINDOWS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envía bytes ESC/POS directamente a una impresora de Windows
 * usando Windows API (OpenPrinter/WritePrinter) vía PowerShell.
 *
 * @param {string} printerName — nombre exacto de la impresora en Windows
 * @param {Buffer} data        — buffer ESC/POS
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
const RAW_PRINT_HELPER_VERSION = 1;

function ensureRawPrintHelperScript() {
  const helperDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Tecno Caja');
  const helperPath = path.join(helperDir, `rawprint-helper-v${RAW_PRINT_HELPER_VERSION}.ps1`);
  const helperScript = `
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$BinPath
)

$ErrorActionPreference = 'Stop'

$dllDir  = Join-Path $env:LOCALAPPDATA 'Tecno Caja'
$dllPath = Join-Path $dllDir 'rawprint.dll'

if (-not (Test-Path $dllDir)) {
  New-Item -ItemType Directory -Path $dllDir -Force | Out-Null
}

$typeCode = @"
using System;
using System.Runtime.InteropServices;
public class Tecno CajaRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int Level, [In] DOCINFO pDocInfo);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBuf, int cbBuf, out int pcWritten);
}
"@

$needCompile = $true
if (Test-Path $dllPath) {
  try {
    Add-Type -Path $dllPath -ErrorAction Stop
    $needCompile = $false
  } catch {
    Remove-Item $dllPath -Force -ErrorAction SilentlyContinue
  }
}
if ($needCompile) {
  Add-Type -TypeDefinition $typeCode -OutputAssembly $dllPath -ErrorAction Stop
  try { Add-Type -Path $dllPath -ErrorAction Stop } catch { }
}

function Get-Win32Message([int]$code) {
  if ($code -le 0) {
    return 'Error desconocido'
  }
  return ([ComponentModel.Win32Exception]::new($code)).Message
}

if (-not (Test-Path $BinPath)) {
  throw "No se encontro el archivo temporal de impresion: $BinPath"
}

$hPrinter = [IntPtr]::Zero
$docStarted = $false
$pageStarted = $false
$ptr = [IntPtr]::Zero

try {
  if (-not [Tecno CajaRawPrint]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "OpenPrinter fallo en '$PrinterName': $(Get-Win32Message $code) (Win32 $code)"
  }

  $di = New-Object Tecno CajaRawPrint+DOCINFO
  $di.pDocName = "Tecno Caja-Recibo"
  $di.pOutputFile = $null
  $di.pDataType = "RAW"

  $jobId = [Tecno CajaRawPrint]::StartDocPrinter($hPrinter, 1, $di)
  if ($jobId -eq 0) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "StartDocPrinter fallo en '$PrinterName': $(Get-Win32Message $code) (Win32 $code)"
  }
  $docStarted = $true

  if (-not [Tecno CajaRawPrint]::StartPagePrinter($hPrinter)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "StartPagePrinter fallo en '$PrinterName': $(Get-Win32Message $code) (Win32 $code)"
  }
  $pageStarted = $true

  $bytes = [System.IO.File]::ReadAllBytes($BinPath)
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  $written = 0
  $ok = [Tecno CajaRawPrint]::WritePrinter($hPrinter, $ptr, $bytes.Length, [ref]$written)
  $writeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $ok) {
    throw "WritePrinter fallo en '$PrinterName': $(Get-Win32Message $writeError) (Win32 $writeError)"
  }
  if ($written -lt $bytes.Length) {
    throw "WritePrinter incompleto en '$PrinterName': enviados $written de $($bytes.Length) bytes"
  }

  [Console]::Out.WriteLine("RAW_OK:$written")
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  }
  if ($pageStarted) {
    [Tecno CajaRawPrint]::EndPagePrinter($hPrinter) | Out-Null
  }
  if ($docStarted) {
    [Tecno CajaRawPrint]::EndDocPrinter($hPrinter) | Out-Null
  }
  if ($hPrinter -ne [IntPtr]::Zero) {
    [Tecno CajaRawPrint]::ClosePrinter($hPrinter) | Out-Null
  }
}
`;

  fs.mkdirSync(helperDir, { recursive: true });
  const currentScript = fs.existsSync(helperPath) ? fs.readFileSync(helperPath, 'utf8') : '';
  if (currentScript !== helperScript) {
    fs.writeFileSync(helperPath, helperScript, 'utf8');
  }
  return helperPath;
}

async function sendRawToPrinter(printerName, data) {
  const ts = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const binFile = path.join(os.tmpdir(), `tecnocaja-esc-${ts}.bin`);
  let helperPath = '';

  return new Promise((resolve) => {
    try {
      fs.writeFileSync(binFile, data);
      helperPath = ensureRawPrintHelperScript();
    } catch (err) {
      return resolve({ ok: false, error: `Error preparando la impresión RAW: ${err.message}` });
    }

    const cleanup = () => {
      try { fs.unlinkSync(binFile); } catch {}
    };

    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, printerName, binFile],
      { timeout: 12000 },
      (err, stdout, stderr) => {
        cleanup();
        if (err) {
          const msg = (stderr || err.message || 'Error desconocido').trim();
          resolve({ ok: false, error: msg });
        } else {
          resolve({ ok: true });
        }
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Imprime un recibo completo en una impresora térmica
 *
 * @param {string} printerName
 * @param {object} receiptData  — mismo formato que buildReceipt()
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function printReceipt(printerName, receiptData) {
  try {
    const buffer = buildReceipt(receiptData);
    return await sendRawToPrinter(printerName, buffer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Envía solo el pulso de apertura de gaveta a la impresora
 *
 * @param {string} printerName
 * @param {0|1}   pin  0=pin2 (más común), 1=pin5
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function openCashDrawer(printerName, pin = 0) {
  try {
    const buffer = new ESCPOSBuilder()
      .init()
      .openDrawer(pin)
      .build();
    return await sendRawToPrinter(printerName, buffer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  ESCPOSBuilder,
  buildReceipt,
  printReceipt,
  openCashDrawer,
  sendRawToPrinter,
  encodeText,
};
