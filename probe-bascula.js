'use strict';
/**
 * probe-bascula.js v2 — Descubridor activo de protocolo Merkato MK-LSP1
 * Corre con: node probe-bascula.js
 */
const net = require('net');

const SCALE_IP = '192.168.100.244';
const WAIT_MS  = 3000;

// Comandos a probar en cada puerto (distintos protocolos de básculas de red)
const COMMANDS = [
  { name: 'W+CRLF',      buf: Buffer.from('W\r\n') },
  { name: 'W solo',       buf: Buffer.from('W') },
  { name: 'CR+LF',        buf: Buffer.from('\r\n') },
  { name: 'CR solo',      buf: Buffer.from('\r') },
  { name: 'ESC+p (CAS)',  buf: Buffer.from([0x1B, 0x70]) },
  { name: 'ENQ (0x05)',   buf: Buffer.from([0x05]) },
  { name: 'STX W ETX',   buf: Buffer.from([0x02, 0x57, 0x03]) },
  { name: 'R+CRLF',       buf: Buffer.from('R\r\n') },
  { name: 'P+CRLF',       buf: Buffer.from('P\r\n') },
  { name: 'SWT+CRLF',     buf: Buffer.from('SWT\r\n') },
  { name: 'GET /weight',  buf: Buffer.from('GET /weight HTTP/1.0\r\nHost: ' + SCALE_IP + '\r\n\r\n') },
];

// Puertos más probables para este tipo de báscula
const PORTS = [4196, 8008, 8000, 5000, 5001, 3001, 9100, 10001, 4001, 80, 23];

// Modbus TCP — query registro
const MODBUS_REQUEST = Buffer.from([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x06,
  0x01, 0x03, 0x00, 0x00, 0x00, 0x02
]);

function tryCommandOnPort(ip, port, cmd) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = Buffer.alloc(0);
    socket.setTimeout(WAIT_MS);

    socket.connect(port, ip, () => {
      socket.write(cmd.buf);
    });

    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      setTimeout(() => { socket.destroy(); }, 400);
    });

    socket.on('timeout', () => { socket.destroy(); });
    socket.on('error', () => { resolve(null); });
    socket.on('close', () => {
      if (data.length > 0) {
        resolve({
          cmd: cmd.name,
          hex: data.toString('hex').match(/.{1,2}/g).join(' '),
          ascii: data.toString('ascii').replace(/[\x00-\x1f\x7f]/g, '.'),
          raw: data
        });
      } else {
        resolve(null);
      }
    });
  });
}

function tryModbus(ip) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = Buffer.alloc(0);
    socket.setTimeout(2000);
    socket.connect(502, ip, () => { socket.write(MODBUS_REQUEST); });
    socket.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
    socket.on('timeout', () => { socket.destroy(); });
    socket.on('error', () => resolve(null));
    socket.on('close', () => resolve(data.length > 0 ? data : null));
  });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Tecno Caja — Probe v2 (modo activo)                ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\nBáscula: ${SCALE_IP}\n`);

  const hits = [];

  // 1. Probar Modbus TCP (puerto 502)
  process.stdout.write('Probando Modbus TCP (puerto 502)... ');
  const modbus = await tryModbus(SCALE_IP);
  if (modbus) {
    console.log('RESPUESTA MODBUS:');
    console.log('   HEX:', modbus.toString('hex').match(/.{1,2}/g).join(' '));
    hits.push({ port: 502, protocol: 'Modbus TCP', data: modbus.toString('hex') });
  } else {
    console.log('sin respuesta.');
  }

  // 2. Probar puertos con todos los comandos
  for (const port of PORTS) {
    console.log(`\nPuerto ${port}:`);
    let portHit = false;
    for (const cmd of COMMANDS) {
      process.stdout.write(`  -> ${cmd.name.padEnd(15)} `);
      const result = await tryCommandOnPort(SCALE_IP, port, cmd);
      if (result) {
        console.log('*** RESPUESTA! ***');
        console.log(`     HEX  : ${result.hex}`);
        console.log(`     ASCII: "${result.ascii}"`);
        hits.push({ port, cmd: result.cmd, hex: result.hex, ascii: result.ascii });
        portHit = true;
        break;
      } else {
        console.log('sin respuesta');
      }
    }
    if (!portHit) {
      console.log(`  (sin respuesta en ningun comando)`);
    }
  }

  console.log('\n===================================================');
  console.log('RESUMEN FINAL:');
  if (hits.length === 0) {
    console.log('  NINGUNA combinacion produjo respuesta.');
    console.log('  Verifica que la bascula este en modo TCP/IP activo.');
    console.log('  Puede necesitar activacion desde el menu de la bascula.');
  } else {
    console.log(`  ${hits.length} combinacion(es) funcionaron:`);
    hits.forEach(h => {
      if (h.protocol === 'Modbus TCP') {
        console.log(`  - Puerto 502 (Modbus TCP): ${h.data}`);
      } else {
        console.log(`  - Puerto ${h.port} | Comando "${h.cmd}" | ASCII: "${h.ascii}"`);
      }
    });
  }
  console.log('\n  >>> COPIA ESTE OUTPUT COMPLETO Y PASASELO A CLAUDE <<<');
  console.log('===================================================\n');
}

main().catch(console.error);
