(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PosMoney = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function scaled(value, scale = 2) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Importe no válido.');
    const s = String(value ?? '0').trim();
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error('Usa un importe decimal válido.');
    const decimals = m[3] || '', unit = 10n ** BigInt(scale);
    let result = BigInt(m[2]) * unit + BigInt((decimals + '0'.repeat(scale)).slice(0,scale) || '0');
    if (Number(decimals[scale] || 0) >= 5) result++;
    return m[1] ? -result : result;
  }
  const cents = (v) => scaled(v, 2);
  function decimal(v, scale = 2) {
    const n = BigInt(v), a = n < 0 ? -n : n, unit = 10n ** BigInt(scale);
    return (n < 0 ? '-' : '') + String(a / unit) + (scale ? '.' + String(a % unit).padStart(scale, '0') : '');
  }
  function number(v) { if (BigInt(v) > 999999999999n || BigInt(v) < -999999999999n) throw new Error('El importe supera el límite permitido.'); return Number(decimal(v)); }
  function divide(n, d) { if (d <= 0n) throw new Error('Divisor no válido.'); const sign = n < 0n ? -1n : 1n, a = n < 0n ? -n : n; return sign * ((a + d / 2n) / d); }
  function percent(amount, rate) { return divide(BigInt(amount) * scaled(rate, 4), 1000000n); }
  function quantity(amount, qty) { return divide(BigInt(amount) * scaled(qty, 6), 1000000n); }
  return { scaled, cents, decimal, number, divide, percent, quantity };
});
