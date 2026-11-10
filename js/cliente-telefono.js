(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClienteTelefono = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function normalize(input, country = 'DO') {
    const raw = String(input || '').trim();
    const fail = (error) => ({ ok: false, error, value: '' });
    if (!raw) return fail('El teléfono del cliente es obligatorio.');
    if (!/^\+?[\d\s().-]+$/.test(raw)) return fail('Escribe un teléfono válido, sin letras ni extensiones.');
    const digits = raw.replace(/\D/g, '');
    if (country === 'DO') {
      const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (national.length !== 10 || !/^(809|829|849)\d{7}$/.test(national)) return fail('Para República Dominicana usa 10 dígitos con prefijo 809, 829 o 849.');
      return { ok: true, value: '+1' + national, display: national.slice(0,3) + '-' + national.slice(3,6) + '-' + national.slice(6) };
    }
    if (!raw.startsWith('+') || !/^[1-9]\d{7,14}$/.test(digits)) return fail('Para otro país incluye +, el código de país y entre 8 y 15 dígitos.');
    return { ok: true, value: '+' + digits, display: '+' + digits };
  }
  function display(value, country = 'DO') { const v = normalize(value, country); return v.ok ? v.display : String(value || ''); }
  return { normalize, display };
});
