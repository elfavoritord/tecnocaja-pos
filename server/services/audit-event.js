'use strict';
const { randomUUID } = require('crypto');
const SECRET = /password|contrase|token|secret|private.?key|credential|authorization|cookie|certificate|certificado|pfx|pin|cvv|cardnumber|numero.?tarjeta/i;
function scrub(value, depth = 0) {
  if (depth > 8) return '[límite]';
  if (Array.isArray(value)) return value.slice(0, 200).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET.test(k)).slice(0, 200).map(([k, v]) => [k, scrub(v, depth + 1)]));
  if (typeof value === 'string') return value.slice(0, 4000).replace(/Bearer\s+\S+/gi, 'Bearer [oculto]');
  return value ?? null;
}
async function append(executor, event) {
  const id = event.eventId || randomUUID();
  await executor(`INSERT INTO audit_logs (event_id, user_id, user_name, user_role, module_name, action_name, detail, created_at,
    branch_id, cash_register_id, client_id, document_type, document_ref, amount, payment_method, business_id,
    cash_session_id, device_id, result, reason, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, event.userId || null, event.userName || 'Sistema', event.userRole || 'Sistema', event.moduleName || 'Sistema', event.actionName || 'Operación',
    String(event.detail || '').slice(0, 4000), new Date().toISOString().slice(0,19).replace('T',' '), event.branchId || null, event.cashRegisterId || null, event.clientId || null,
    event.documentType || null, event.documentRef || null, event.amount ?? null, event.paymentMethod || null, event.businessId || null,
    event.cashSessionId || null, event.deviceId || require('os').hostname(), event.result || 'exito', event.reason || null,
    event.before == null ? null : JSON.stringify(scrub(event.before)), event.after == null ? null : JSON.stringify(scrub(event.after))]);
  return id;
}
module.exports = { append, scrub };
