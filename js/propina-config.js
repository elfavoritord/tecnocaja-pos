// Propina legal 10 %: consumo en el local y su configuración del negocio.
// Recalcula el carrito y los totales que dependen de la propina.
function refrescarVentaPropina() {
  if (typeof renderSaleTable === 'function') renderSaleTable();
  if (typeof updateTotals === 'function') updateTotals();
}
// Tras cambiar la propina, el recibido sigue al total si lo puso el sistema
// (la propina quitada no puede salir como devuelta al cliente).
function despuesDeCambiarPropina(totalAntes) {
  if (typeof syncBillingModalTotals === 'function') syncBillingModalTotals();
  if (typeof ajustarRecibidoAlTotal === 'function') ajustarRecibidoAlTotal(totalAntes);
  if (DB.payMethod === 'mixto' && typeof calcMixto === 'function') calcMixto();
  window.CobroUI?.sync?.();
}
function setSaleConsumedHere(value) {
  const totalAntes = typeof totalCobroActual === 'function' ? totalCobroActual() : 0;
  DB.saleConsumedHere = value === true && !['delivery','recoger'].includes(DB.saleOrderType);
  refrescarVentaPropina();
  despuesDeCambiarPropina(totalAntes);
}
// Botón «Quitar propina / Cobrar propina» de Cobrar: solo para esta venta.
// La venta guarda que se quitó y cuánto (reporte de propinas y auditoría).
function toggleSaleTipWaived() {
  const totalAntes = typeof totalCobroActual === 'function' ? totalCobroActual() : 0;
  DB.saleTipWaived = !DB.saleTipWaived;
  refrescarVentaPropina();
  despuesDeCambiarPropina(totalAntes);
  if (typeof showToast === 'function') showToast(DB.saleTipWaived ? 'Esta venta no llevará propina legal.' : 'Se volvió a agregar la propina legal.', 'info');
}
function openLegalTipConfig() {
  const alcance = DB.config?.legalTipScope === 'marcados' ? 'marcados' : 'todos';
  document.getElementById('modal-title').textContent = 'Propina legal · configuración del negocio';
  document.getElementById('modal-body').innerHTML = `<p>Actívala si el negocio vende comidas o bebidas que se consumen en el establecimiento.</p>
    <label class="nc-check"><input id="legal-tip-enabled" type="checkbox" ${DB.config?.legalTipEnabled ? 'checked' : ''}> Cobrar propina legal del 10%</label>
    <fieldset class="propina-alcance"><legend>¿A qué productos se aplica?</legend>
      <label class="nc-radio"><input type="radio" name="legal-tip-scope" value="todos" ${alcance === 'todos' ? 'checked' : ''}> A todo lo consumido en el local (recomendado)</label>
      <label class="nc-radio"><input type="radio" name="legal-tip-scope" value="marcados" ${alcance === 'marcados' ? 'checked' : ''}> Solo a los productos marcados en Productos como «sujeto a propina legal»</label>
    </fieldset>
    <label class="cs-campo">Cobrarla solo desde este consumo (sin ITBIS), RD$
      <input id="legal-tip-minimum" type="number" min="0" step="0.01" class="form-input" value="${Number(DB.config?.legalTipMinimum || 0) || ''}" placeholder="0 = siempre"></label>
    <p class="cs-aviso">La ley no fija un monto mínimo para la propina legal. Usa este campo solo si es política del negocio y lo confirmaste con tu contador. Al cobrar, el cajero también puede quitarla en una venta con el botón «Quitar propina»; queda registrado.</p>
    <p>Se cobra en ventas de <strong>mesa</strong> y en mostrador cuando se marca «Consumo en el local» al cobrar. Delivery y para llevar quedan excluidos.
    Se calcula después de descuentos, sobre la base sin ITBIS, y sale separada en la venta, la factura y el e-CF. No incluye reparto a empleados.</p>`;
  document.getElementById('modal-footer').innerHTML = '<button class="btn-secondary" onclick="closeAllModals()">Cancelar</button><button class="btn-primary" onclick="saveLegalTipConfig()">Guardar</button>';
  document.getElementById('modal-overlay').classList.remove('hidden');
}
async function saveLegalTipConfig() {
  try {
    const alcance = document.querySelector('input[name="legal-tip-scope"]:checked')?.value || 'todos';
    const minimoTexto = String(document.getElementById('legal-tip-minimum')?.value || '').trim();
    const minimo = minimoTexto === '' ? 0 : Number(minimoTexto);
    if (!Number.isFinite(minimo) || minimo < 0) { showToast('Escribe un monto mínimo válido (0 = siempre).', 'error'); return; }
    const result = await api.request('/api/config/legal-tip', { method: 'PUT', body: JSON.stringify({ enabled: document.getElementById('legal-tip-enabled').checked, alcance, minimo }) });
    DB.config = { ...DB.config, ...result.config }; refrescarVentaPropina(); closeAllModals(); showToast('Configuración de propina guardada.', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
