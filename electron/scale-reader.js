'use strict';

const net        = require('net');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SERIAL_WAIT_MS = 1600;

function encodePowerShell(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function runPowerShell(script, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(script)
      ],
      {
        windowsHide: true,
        timeout: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || stdout?.trim() || error.message || 'PowerShell execution failed.'));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

async function listSerialPorts() {
  const script = `
    $deviceMap = @{}
    try {
      Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object {
        if ($_.Name -match '\\((COM\\d+)\\)') {
          $deviceMap[$matches[1]] = $_.Name
        }
      }
    } catch {}
    $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object | ForEach-Object {
      [pscustomobject]@{
        path = $_
        label = if ($deviceMap.ContainsKey($_)) { $deviceMap[$_] } else { $_ }
      }
    })
    @{ ok = $true; ports = $ports } | ConvertTo-Json -Compress -Depth 5
  `;

  const output = await runPowerShell(script, { timeoutMs: 4000 });
  const parsed = JSON.parse(output || '{"ok":true,"ports":[]}');
  return {
    ok: true,
    ports: Array.isArray(parsed.ports) ? parsed.ports : []
  };
}

function normalizeSerialPortConfig(config = {}) {
  return {
    port: String(config.port || config.serialPort || '').trim(),
    baudRate: Math.max(300, Math.min(256000, Number(config.baudRate || config.scaleSerialBaudRate || 9600) || 9600)),
    readTimeoutMs: Math.max(250, Math.min(8000, Number(config.readTimeoutMs || DEFAULT_SERIAL_WAIT_MS) || DEFAULT_SERIAL_WAIT_MS))
  };
}

async function readWeightFromSerial(config = {}) {
  const normalized = normalizeSerialPortConfig(config);
  if (!normalized.port) {
    return { ok: false, error: 'Debes configurar el puerto COM de la báscula.' };
  }

  const portLiteral = JSON.stringify(normalized.port);
  const baudLiteral = JSON.stringify(normalized.baudRate);
  const timeoutLiteral = JSON.stringify(normalized.readTimeoutMs);

  const script = `
    $portName = ${portLiteral}
    $baudRate = ${baudLiteral}
    $waitMs = ${timeoutLiteral}
    $serial = $null
    try {
      $serial = New-Object System.IO.Ports.SerialPort $portName, $baudRate, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
      $serial.ReadTimeout = 150
      $serial.WriteTimeout = 150
      $serial.DtrEnable = $false
      $serial.RtsEnable = $false
      $serial.Open()
      $serial.DiscardInBuffer()
      Start-Sleep -Milliseconds 250

      $buffer = New-Object System.Text.StringBuilder
      $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
      while ([DateTime]::UtcNow -lt $deadline) {
        $chunk = $serial.ReadExisting()
        if (-not [string]::IsNullOrWhiteSpace($chunk)) {
          [void]$buffer.Append($chunk)
          Start-Sleep -Milliseconds 120
          if ($serial.BytesToRead -le 0) { break }
        } else {
          Start-Sleep -Milliseconds 60
        }
      }

      $raw = $buffer.ToString()
      if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'No se recibió ningún peso desde la báscula.'
      }

      @{ ok = $true; raw = $raw; port = $portName; baudRate = $baudRate } | ConvertTo-Json -Compress -Depth 5
    } finally {
      if ($serial -and $serial.IsOpen) {
        $serial.Close()
      }
      if ($serial) {
        $serial.Dispose()
      }
    }
  `;

  try {
    const output = await runPowerShell(script, {
      timeoutMs: normalized.readTimeoutMs + 2500
    });
    return JSON.parse(output || '{}');
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'No se pudo leer la báscula por puerto serial.'
    };
  }
}

module.exports = {
  listSerialPorts,
  readWeightFromSerial
};
