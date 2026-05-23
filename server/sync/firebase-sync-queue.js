/**
 * firebase-sync-queue.js
 *
 * Administra una cola local de sincronización usando SQLite.
 * Cada item pendiente se intenta sincronizar automáticamente.
 */

const { query, withTransaction } = require('../../db');

// Estados posibles de un item en la cola
const SYNC_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ERROR: 'error'
};

class FirebaseSyncQueue {
  /**
   * Inicializa la tabla de sincronización (si no existe).
   */
  static async init() {
    try {
      // Tabla compatible con SQLite y MySQL
      await query(`
        CREATE TABLE IF NOT EXISTS firebase_sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          data_payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '${SYNC_STATUS.PENDING}',
          error_message TEXT DEFAULT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_retry_at DATETIME DEFAULT NULL,
          next_retry_at DATETIME DEFAULT NULL,
          synced_at DATETIME DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Índices separados (SQLite no soporta KEY inline en CREATE TABLE)
      await query(`CREATE INDEX IF NOT EXISTS idx_fsq_status ON firebase_sync_queue (status)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_fsq_entity ON firebase_sync_queue (entity_type, entity_id)`).catch(() => {});
      await query(`CREATE INDEX IF NOT EXISTS idx_fsq_next_retry ON firebase_sync_queue (next_retry_at)`).catch(() => {});
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fsq_pending ON firebase_sync_queue (entity_type, entity_id, status)`).catch(() => {});
      console.log('✓ Tabla firebase_sync_queue inicializada');
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.error('Error inicializando firebase_sync_queue:', err);
      }
    }
  }

  /**
   * Agrega un item a la cola de sincronización.
   * @param {string} entityType - Tipo de entidad (sale, cash_closing, etc.)
   * @param {string} entityId - ID único de la entidad
   * @param {object} payload - Datos a sincronizar
   */
  static async enqueue(entityType, entityId, payload) {
    try {
      const payloadJson = JSON.stringify(payload);

      // Intenta actualizar si ya existe, sino crea uno nuevo
      const existing = await query(
        'SELECT id FROM firebase_sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN (?, ?)',
        [entityType, entityId, SYNC_STATUS.PENDING, SYNC_STATUS.ERROR]
      );

      if (Array.isArray(existing) && existing.length > 0) {
        // Actualizar existente
        await query(
          `UPDATE firebase_sync_queue
           SET data_payload = ?, status = ?, error_message = NULL, retry_count = 0, updated_at = datetime('now')
           WHERE id = ?`,
          [payloadJson, SYNC_STATUS.PENDING, existing[0].id]
        );
      } else {
        // Crear nuevo
        await query(
          `INSERT INTO firebase_sync_queue (entity_type, entity_id, data_payload, status)
           VALUES (?, ?, ?, ?)`,
          [entityType, entityId, payloadJson, SYNC_STATUS.PENDING]
        );
      }

      console.log(`✓ Enqueued ${entityType}:${entityId} for sync`);
    } catch (err) {
      console.error('Error enqueueing sync item:', err);
    }
  }

  /**
   * Obtiene items pendientes para sincronizar.
   * @param {number} limit - Máximo de items a retornar
   */
  static async getPending(limit = 10) {
    try {
      const results = await query(
        `SELECT * FROM firebase_sync_queue
         WHERE status IN (?, ?) AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
         ORDER BY created_at ASC
         LIMIT ?`,
        [SYNC_STATUS.PENDING, SYNC_STATUS.ERROR, limit]
      );
      return Array.isArray(results) ? results : (results ? [results] : []);
    } catch (err) {
      console.error('Error getting pending items:', err);
      return [];
    }
  }

  /**
   * Marca un item como sincronizado.
   */
  static async markSynced(id) {
    try {
      await query(
        `UPDATE firebase_sync_queue
         SET status = ?, synced_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [SYNC_STATUS.SYNCED, id]
      );
    } catch (err) {
      console.error('Error marking as synced:', err);
    }
  }

  /**
   * Marca un item con error y programa reintento.
   * @param {number} id - ID del item
   * @param {string} errorMsg - Mensaje de error
   */
  static async markError(id, errorMsg) {
    try {
      const retryCount = (await query(
        'SELECT retry_count FROM firebase_sync_queue WHERE id = ?',
        [id]
      ))[0]?.retry_count || 0;

      // Backoff exponencial: 30s, 1m, 2m, 5m, 10m, etc.
      const delaySeconds = Math.min(30 * Math.pow(2, retryCount), 3600); // Max 1 hora
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

      await query(
        `UPDATE firebase_sync_queue
         SET status = ?, error_message = ?, retry_count = retry_count + 1,
             last_retry_at = datetime('now'), next_retry_at = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [SYNC_STATUS.ERROR, errorMsg.substring(0, 255), nextRetryAt, id]
      );

      console.warn(`⚠ Reintentando en ${delaySeconds}s: ${errorMsg}`);
    } catch (err) {
      console.error('Error marking as error:', err);
    }
  }

  /**
   * Obtiene estadísticas de la cola.
   */
  static async getStats() {
    try {
      const stats = await query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = '${SYNC_STATUS.PENDING}' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = '${SYNC_STATUS.SYNCING}' THEN 1 ELSE 0 END) as syncing,
          SUM(CASE WHEN status = '${SYNC_STATUS.SYNCED}' THEN 1 ELSE 0 END) as synced,
          SUM(CASE WHEN status = '${SYNC_STATUS.ERROR}' THEN 1 ELSE 0 END) as errors
        FROM firebase_sync_queue
      `);
      return stats[0] || { total: 0, pending: 0, syncing: 0, synced: 0, errors: 0 };
    } catch (err) {
      console.error('Error getting stats:', err);
      return { total: 0, pending: 0, syncing: 0, synced: 0, errors: 0 };
    }
  }

  /**
   * Limpia items sincrón izados hace más de X días.
   */
  static async cleanup(daysOld = 7) {
    try {
      const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      const result = await query(
        `DELETE FROM firebase_sync_queue WHERE status = ? AND synced_at < ?`,
        [SYNC_STATUS.SYNCED, cutoff]
      );
      console.log(`✓ Cleaned up ${result.affectedRows || 0} old synced items`);
    } catch (err) {
      console.error('Error cleaning up:', err);
    }
  }
}

module.exports = {
  FirebaseSyncQueue,
  SYNC_STATUS
};
