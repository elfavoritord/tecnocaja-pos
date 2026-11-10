/* Reservaciones de mesas: reglas compartidas por el servidor
   (server/routes/mesas.routes.js) y el plano (js/mesas.js).
   Fechas y horas en hora local del negocio ("hoy" nunca sale de toISOString():
   de noche en RD daría el día siguiente). Una mesa se ve "Reservada" desde
   VENTANA_MIN antes de la hora hasta que la reserva se cierra (llegó, no vino
   o se canceló).
   Anticipo (opcional): lo que el cliente dejó para asegurar la reserva. Si es
   consumible se descuenta de su cuenta al cobrar; si no, o si no vino, se
   devuelve o queda al negocio según su política. Dinero en centavos
   (js/pos-money.js); en la página PosMoney se carga después de este archivo. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./pos-money'));
  else root.MesasReservas = factory(() => root.PosMoney);
})(typeof window !== 'undefined' ? window : globalThis, function (dinero) {
  'use strict';
  const VENTANA_MIN = 120;
  // Dos reservas de la misma mesa el mismo día deben separarse al menos esto.
  const SEPARACION_MIN = 120;
  const ESTADOS = ['activa', 'cumplida', 'no_vino', 'cancelada'];
  const METODOS_ANTICIPO = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' });
  const MAX_ANTICIPO = 1000000;
  // recibido: en poder del negocio y sin resolver · aplicado: se descontó completo
  // en la factura · devuelto / retenido: lo que quedaba se devolvió o quedó al negocio.
  const ESTADOS_ANTICIPO = ['recibido', 'aplicado', 'devuelto', 'retenido'];

  const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const centavos = (v) => dinero().cents(Number(v || 0).toFixed(2));
  const pesos = (c) => dinero().number(c);
  const dos = (n) => String(n).padStart(2, '0');
  const fechaLocal = (d = new Date()) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  const aFecha = (fecha, hora) => new Date(`${fecha}T${hora}:00`);
  const minutosDelDia = (hora) => { const [h, m] = String(hora).split(':').map(Number); return h * 60 + m; };

  function validarReserva(body, { ahora = new Date() } = {}) {
    const cliente = String(body?.cliente ?? '').trim().replace(/\s+/g, ' ');
    if (cliente.length < 2 || cliente.length > 120) throw fail('Escribe el nombre de quien reserva.');
    const telefono = String(body?.telefono ?? '').trim();
    if (telefono && (!/^[\d+\-() .]{7,40}$/.test(telefono) || (telefono.match(/\d/g) || []).length < 7)) throw fail('El teléfono no es válido.');
    const personas = Number(body?.personas ?? 1);
    if (!Number.isInteger(personas) || personas < 1 || personas > 500) throw fail('Indica cuántas personas vienen.');
    const fecha = String(body?.fecha ?? '');
    const hora = String(body?.hora ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(aFecha(fecha, '12:00').getTime()) || fechaLocal(aFecha(fecha, '12:00')) !== fecha) throw fail('La fecha de la reserva no es válida.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw fail('La hora de la reserva no es válida.');
    const cuando = aFecha(fecha, hora).getTime();
    if (cuando < ahora.getTime() - 15 * 60000) throw fail('Esa hora ya pasó. Elige una hora futura.');
    if (cuando > ahora.getTime() + 366 * 86400000) throw fail('Solo se reserva con hasta un año de anticipación.');
    const nota = String(body?.nota ?? '').trim().slice(0, 300);
    return { cliente, telefono: telefono || null, personas, fecha, hora, nota: nota || null };
  }

  // Otra reserva activa de la misma mesa, el mismo día y a menos de SEPARACION_MIN.
  function chocaCon(reservas, { elementoId, fecha, hora, excluirId = null }) {
    return (reservas || []).find((r) => r.estado === 'activa' && r.id !== excluirId && r.elemento_id === elementoId && r.fecha === fecha
      && Math.abs(minutosDelDia(r.hora) - minutosDelDia(hora)) < SEPARACION_MIN) || null;
  }

  // Reservas activas de hoy para una mesa, de la más temprana a la más tarde.
  function deHoy(reservas, elementoId, ahora = new Date()) {
    const hoy = fechaLocal(ahora);
    return (reservas || []).filter((r) => r.estado === 'activa' && r.elemento_id === elementoId && r.fecha === hoy)
      .sort((a, b) => a.hora.localeCompare(b.hora));
  }
  // La reserva que hoy pone la mesa en "Reservada" (ya dentro de la ventana).
  function vigente(reservas, elementoId, ahora = new Date()) {
    const minutos = ahora.getHours() * 60 + ahora.getMinutes();
    return deHoy(reservas, elementoId, ahora).find((r) => minutosDelDia(r.hora) - VENTANA_MIN <= minutos) || null;
  }
  // La próxima de hoy que todavía no entra en la ventana (para avisar en la mesa).
  function proxima(reservas, elementoId, ahora = new Date()) {
    const minutos = ahora.getHours() * 60 + ahora.getMinutes();
    return deHoy(reservas, elementoId, ahora).find((r) => minutosDelDia(r.hora) - VENTANA_MIN > minutos) || null;
  }
  const atrasada = (reserva, ahora = new Date()) => aFecha(reserva.fecha, reserva.hora).getTime() < ahora.getTime() - 15 * 60000;

  // ── Anticipo ───────────────────────────────────────────────────────────────
  // Sin monto (vacío o 0) no hay anticipo: devuelve null.
  function validarAnticipo(body) {
    const crudo = String(body?.anticipoMonto ?? '').trim().replace(/,/g, '');
    if (!crudo || /^0+(\.0+)?$/.test(crudo)) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(crudo)) throw fail('El anticipo no es un monto válido. Usa números con hasta 2 decimales.');
    const monto = pesos(centavos(crudo));
    if (!(monto > 0) || monto > MAX_ANTICIPO) throw fail('El anticipo debe ser mayor que cero y no pasar de RD$ 1,000,000.00.');
    const metodo = String(body?.anticipoMetodo ?? '');
    if (!METODOS_ANTICIPO[metodo]) throw fail('Indica cómo pagó el anticipo: efectivo, tarjeta o transferencia.');
    const referencia = String(body?.anticipoReferencia ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const consumible = [true, 1, '1', 'true', 'on', 'si', 'sí'].includes(body?.anticipoConsumible);
    return { monto, metodo, referencia: referencia || null, consumible };
  }
  // Lo que queda del anticipo en poder del negocio sin usar ni resolver.
  function saldoAnticipo(anticipo) {
    if (!anticipo || anticipo.estado !== 'recibido') return 0;
    const saldo = centavos(anticipo.monto) - centavos(anticipo.aplicado);
    return saldo > 0n ? pesos(saldo) : 0;
  }
  // Cuánto se descuenta al cobrar una cuenta de este total: solo un anticipo
  // consumible, recibido y que todavía no se usó en otra factura.
  function anticipoAplicable(anticipo, total) {
    if (!anticipo || !anticipo.consumible || anticipo.estado !== 'recibido' || anticipo.saleId) return 0;
    const monto = centavos(anticipo.monto), tope = centavos(Math.max(0, Number(total) || 0));
    return pesos(monto < tope ? monto : tope);
  }
  // Total de la factura menos el anticipo: lo que el cliente paga ahora.
  const restarAnticipo = (total, anticipo) => pesos(centavos(total) - centavos(anticipo));

  const fmtDinero = (v) => `RD$ ${Number(v || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const horaLegible = (hora) => { const [h, m] = String(hora).split(':').map(Number); return `${h % 12 || 12}:${dos(m)} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
  const fechaLegible = (fecha) => aFecha(fecha, '12:00').toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const numeroReserva = (id) => String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
  function estadoAnticipoTexto(a) {
    const aplicado = Number(a.aplicado || 0);
    if (a.estado === 'recibido') return aplicado > 0 ? `Usado ${fmtDinero(aplicado)} · quedan ${fmtDinero(saldoAnticipo(a))}` : 'Recibido';
    if (a.estado === 'aplicado') return `Descontado en la factura${a.factura ? ` ${a.factura}` : ''}`;
    const resto = a.estado === 'devuelto'
      ? `Devuelto ${fmtDinero(a.resueltoMonto)}${a.resueltoMetodo ? ` (${(METODOS_ANTICIPO[a.resueltoMetodo] || a.resueltoMetodo).toLowerCase()})` : ''}`
      : `Quedó al negocio ${fmtDinero(a.resueltoMonto)}`;
    return aplicado > 0 ? `Usado ${fmtDinero(aplicado)} · ${resto.charAt(0).toLowerCase()}${resto.slice(1)}` : resto;
  }
  // Constancia (recibo) de la reserva: secciones de filas [etiqueta, valor, negrita].
  // La misma estructura sirve para la pantalla, la impresora térmica y la hoja.
  function constancia(reserva, { mesa = '', usuario = '' } = {}) {
    const a = reserva.anticipo || null;
    const secciones = [{ titulo: 'Reserva', filas: [
      ['Nº', numeroReserva(reserva.id), true],
      ['Mesa', mesa || 'Mesa'],
      ['Fecha', fechaLegible(reserva.fecha)],
      ['Hora', horaLegible(reserva.hora), true],
      ['Personas', String(reserva.personas)],
      ['A nombre de', reserva.cliente, true],
      ...(reserva.telefono ? [['Teléfono', reserva.telefono]] : []),
      ...(reserva.nota ? [['Nota', reserva.nota]] : []),
    ] }];
    if (a) {
      secciones.push({ titulo: 'Anticipo', filas: [
        ['Monto recibido', fmtDinero(a.monto), true],
        ['Forma de pago', METODOS_ANTICIPO[a.metodo] || a.metodo],
        ...(a.referencia ? [['Referencia', a.referencia]] : []),
        ['Consumible', a.consumible ? 'Sí: se descuenta de la cuenta' : 'No se descuenta de la cuenta'],
        ['Estado', estadoAnticipoTexto(a)],
      ] });
    }
    const pie = [
      ...(usuario || reserva.usuario ? [[`Atendido por: ${usuario || reserva.usuario}`, '']] : []),
      ['La mesa se guarda desde la hora reservada. Avise si se retrasa o cancela.', ''],
      ...(a ? [[a.consumible
        ? 'El anticipo se descuenta del consumo al pagar. Si no se presenta, aplica la política del negocio.'
        : 'El anticipo no se descuenta del consumo. Su devolución depende de la política del negocio.', '']] : []),
      ['Documento informativo. No es factura ni comprobante fiscal.', ''],
    ];
    secciones.push({ titulo: 'Importante', filas: pie });
    return secciones;
  }

  return { VENTANA_MIN, SEPARACION_MIN, ESTADOS, METODOS_ANTICIPO, ESTADOS_ANTICIPO, validarReserva, chocaCon, vigente, proxima, atrasada,
    fechaLocal, fail, validarAnticipo, saldoAnticipo, anticipoAplicable, restarAnticipo, constancia, numeroReserva, estadoAnticipoTexto,
    fmtDinero, horaLegible, fechaLegible };
});
