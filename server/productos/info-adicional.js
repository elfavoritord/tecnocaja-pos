'use strict';
// Información adicional del producto (descripción, especificaciones técnicas,
// país de procedencia y observaciones) y su copia en cada línea de venta.
// Las reglas (limpieza, largos, qué sale en la factura) están en
// js/producto-info-adicional.js, compartido con la pantalla y la impresión.
//
//   products.info_adicional        JSON con los cuatro textos + mostrarEnFactura
//   config.info_adicional_factura  JSON con la configuración del negocio
//   sale_items.info_adicional      copia de lo que salió en la factura (null = nada)
//
// La copia de la línea es lo que se reimprime: si después cambia el producto,
// la factura vieja sigue igual. El XML del e-CF no la usa (decisión de Emilio).
const Info = require('../../js/producto-info-adicional');

function createInfoAdicional({ addColumnIfMissing }) {
  let columnasListas = null;

  // Una sola vez y fuera de la transacción de la venta (en MariaDB un ALTER
  // dentro de una transacción la confirma a medias).
  function asegurarColumnas() {
    if (!columnasListas) {
      columnasListas = (async () => {
        await addColumnIfMissing('products', 'info_adicional', 'LONGTEXT DEFAULT NULL');
        await addColumnIfMissing('sale_items', 'info_adicional', 'LONGTEXT DEFAULT NULL');
        await addColumnIfMissing('config', 'info_adicional_factura', 'LONGTEXT DEFAULT NULL');
      })().catch((error) => {
        columnasListas = null;
        throw error;
      });
    }
    return columnasListas;
  }

  // Ficha del producto → base. Solo si quien guarda lo manda (undefined = no se
  // toca): así lo que guarde un producto sin conocer este campo no lo borra.
  async function guardarEnProducto(conn, productId, raw) {
    if (raw === undefined || !productId) return;
    await conn.query('UPDATE products SET info_adicional = ? WHERE id = ?', [Info.serializar(raw), productId]);
  }

  // Lo que sale en la factura para esta línea, según el producto y el negocio.
  function copiaParaLinea(productRow, configRow) {
    if (!productRow || !configRow) return null;
    return Info.paraVenta(productRow.info_adicional, configRow.info_adicional_factura);
  }

  async function guardarEnLinea(conn, saleItemId, copia) {
    if (!copia || !saleItemId) return;
    await conn.query('UPDATE sale_items SET info_adicional = ? WHERE id = ?', [JSON.stringify(copia), saleItemId]);
  }

  // Para la venta que se manda a la pantalla (impresión y reimpresión).
  function deLineaGuardada(row) {
    const copia = Info.deLinea(row?.info_adicional);
    return copia ? { infoAdicional: copia } : {};
  }

  return {
    asegurarColumnas,
    guardarEnProducto,
    copiaParaLinea,
    guardarEnLinea,
    deLineaGuardada,
    deFila: (row) => Info.deFila(row?.info_adicional),
    configParaCliente: (row) => Info.configFactura(row?.info_adicional_factura),
    configParaGuardar: (raw) => JSON.stringify(Info.configFactura(raw)),
  };
}

module.exports = { createInfoAdicional };
