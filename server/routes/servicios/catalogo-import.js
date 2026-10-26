'use strict';

/**
 * catalogo-import.js — Importa servicios al catálogo de la Empresa de
 * Servicios (svc_services), leídos de un CSV por js/catalogo-csv.js en el
 * navegador (POS o Portal del Contador).
 *
 * Cada fila: si ya hay un servicio con ese código (o, sin código, con ese
 * nombre) se actualiza; si no, se crea. Al actualizar solo se cambian las
 * columnas que traía el archivo (fila.campos): un CSV con solo Código y
 * Precio sube precios sin tocar lo demás. Importar lo deja activo salvo que
 * la columna Estado diga Inactivo.
 *
 * Lo usan POST /api/servicios/catalogo/importar (catalogo.routes.js) y los
 * servicios importados desde el portal (server/sync/pending-servicios.js).
 */

const CAMPOS = ['codigo', 'nombre', 'descripcion', 'categoria', 'unidad', 'precio', 'itbisPct', 'duracionMin', 'activo'];

function texto(valor) { return String(valor == null ? '' : valor).trim(); }

function numeroNoNegativo(valor, porDefecto) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

// Categoría por nombre, como la crea el POS. Vacía o 'General' = sin categoría.
async function categoriaPorNombre(query, nombre) {
  const limpio = texto(nombre);
  if (!limpio || limpio.toLowerCase() === 'general') return null;
  const [cat] = await query('SELECT id FROM svc_service_categories WHERE LOWER(nombre) = LOWER(?) LIMIT 1', [limpio]);
  if (cat) return cat.id;
  const r = await query('INSERT INTO svc_service_categories (nombre) VALUES (?)', [limpio]);
  return r.insertId;
}

async function buscarExistente(query, codigo, nombre) {
  if (codigo) {
    const [porCodigo] = await query(
      "SELECT * FROM svc_services WHERE LOWER(COALESCE(codigo, '')) = LOWER(?) ORDER BY activo DESC, id LIMIT 1", [codigo]
    );
    if (porCodigo) return porCodigo;
  }
  if (!nombre) return null;
  const [porNombre] = await query(
    'SELECT * FROM svc_services WHERE LOWER(nombre) = LOWER(?) ORDER BY activo DESC, id LIMIT 1', [nombre]
  );
  return porNombre || null;
}

// → { creados, actualizados, omitidos, errores: ['Fila N: …'], ids: [id por fila aplicada] }
async function importarServicios(query, filas) {
  const resultado = { creados: 0, actualizados: 0, omitidos: 0, errores: [], ids: [] };
  for (const fila of filas || []) {
    const etiqueta = fila.fila ? `Fila ${fila.fila}` : (texto(fila.nombre) || 'Servicio');
    try {
      const codigo = texto(fila.codigo);
      const nombre = texto(fila.nombre);
      if (!codigo && !nombre) { resultado.omitidos += 1; continue; }
      const campos = new Set(Array.isArray(fila.campos) && fila.campos.length ? fila.campos : CAMPOS);
      const trae = (campo) => campos.has(campo) && fila[campo] !== undefined;
      const actual = await buscarExistente(query, codigo, nombre);

      if (actual) {
        const categoriaId = trae('categoria') ? await categoriaPorNombre(query, fila.categoria) : actual.categoria_id;
        await query(
          `UPDATE svc_services SET codigo = ?, nombre = ?, descripcion = ?, categoria_id = ?, precio = ?, itbis_pct = ?,
             unidad = ?, duracion_min = ?, activo = ?, updated_at = datetime('now') WHERE id = ?`,
          [
            // Mismo código con otras mayúsculas: se deja como estaba.
            (actual.codigo && codigo.toLowerCase() === String(actual.codigo).toLowerCase() ? actual.codigo : codigo) || actual.codigo || null,
            trae('nombre') && nombre ? nombre : actual.nombre,
            trae('descripcion') ? (texto(fila.descripcion) || null) : actual.descripcion,
            categoriaId,
            trae('precio') ? numeroNoNegativo(fila.precio, Number(actual.precio || 0)) : actual.precio,
            trae('itbisPct') ? numeroNoNegativo(fila.itbisPct, Number(actual.itbis_pct || 0)) : actual.itbis_pct,
            trae('unidad') ? (texto(fila.unidad) || 'servicio') : actual.unidad,
            trae('duracionMin') ? (fila.duracionMin == null || fila.duracionMin === '' ? null : numeroNoNegativo(fila.duracionMin, null)) : actual.duracion_min,
            trae('activo') ? (fila.activo === false ? 0 : 1) : 1,
            actual.id,
          ]
        );
        resultado.actualizados += 1;
        resultado.ids.push(actual.id);
        continue;
      }

      if (!nombre) throw new Error('el servicio nuevo necesita nombre.');
      const r = await query(
        `INSERT INTO svc_services (codigo, nombre, descripcion, categoria_id, precio, itbis_pct, unidad, duracion_min, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          codigo || null,
          nombre,
          texto(fila.descripcion) || null,
          await categoriaPorNombre(query, fila.categoria),
          numeroNoNegativo(fila.precio, 0),
          numeroNoNegativo(fila.itbisPct, 0),
          texto(fila.unidad) || 'servicio',
          fila.duracionMin == null || fila.duracionMin === '' ? null : numeroNoNegativo(fila.duracionMin, null),
          fila.activo === false ? 0 : 1,
        ]
      );
      resultado.creados += 1;
      resultado.ids.push(r.insertId);
    } catch (error) {
      resultado.omitidos += 1;
      resultado.errores.push(`${etiqueta}: ${error.message}`);
    }
  }
  return resultado;
}

module.exports = { importarServicios, categoriaPorNombre };
