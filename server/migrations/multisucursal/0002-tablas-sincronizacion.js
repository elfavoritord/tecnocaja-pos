'use strict';

/**
 * ms-0002 — Bandejas de sincronización (salida, entrada y cursores).
 *
 * Por qué no se reutiliza firebase_sync_queue: es una cola de "último estado"
 * (índice único entity_type+entity_id+status colapsa varios cambios de la
 * misma entidad), no tiene event_id ni versión, y se llena DESPUÉS del commit
 * de la venta. sync_outbox es un registro de eventos que se escribe dentro de
 * la misma transacción de la operación; firebase_sync_queue sigue igual para
 * la app de reportes.
 *
 * Fechas en texto ISO-8601 UTC ("2026-10-18T15:40:33.342Z"): el resto de la
 * base guarda hora local de RD y DATETIME no lleva zona; así no hay ambigüedad
 * entre sucursales y el orden alfabético es el cronológico.
 */

const TABLAS = ['sync_outbox', 'sync_inbox', 'sync_cursors'];

module.exports = {
  id: 'ms-0002-tablas-sincronizacion',
  descripcion: 'Bandeja de salida (sync_outbox), de entrada (sync_inbox) y cursores de descarga (sync_cursors)',
  TABLAS,

  async up(ctx) {
    const { pk, longText, text } = ctx.types;

    await ctx.query(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id ${pk},
        event_id VARCHAR(36) NOT NULL,
        company_uuid VARCHAR(36) DEFAULT NULL,
        branch_uuid VARCHAR(36) DEFAULT NULL,
        entity_type VARCHAR(40) NOT NULL,
        entity_uuid VARCHAR(36) NOT NULL,
        operation VARCHAR(20) NOT NULL,
        entity_version INT NOT NULL DEFAULT 1,
        payload ${longText} NOT NULL,
        created_at_utc VARCHAR(30) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at_utc VARCHAR(30) DEFAULT NULL,
        last_error ${text} DEFAULT NULL,
        acked_at_utc VARCHAR(30) DEFAULT NULL
      )
    `);
    await ctx.createIndex('sync_outbox', 'uq_sync_outbox_event', ['event_id'], { unique: true });
    await ctx.createIndex('sync_outbox', 'idx_sync_outbox_estado', ['status', 'next_attempt_at_utc']);
    await ctx.createIndex('sync_outbox', 'idx_sync_outbox_entidad', ['entity_type', 'entity_uuid']);

    await ctx.query(`
      CREATE TABLE IF NOT EXISTS sync_inbox (
        event_id VARCHAR(36) NOT NULL PRIMARY KEY,
        company_uuid VARCHAR(36) NOT NULL,
        origin_branch_uuid VARCHAR(36) DEFAULT NULL,
        entity_type VARCHAR(40) NOT NULL,
        entity_uuid VARCHAR(36) NOT NULL,
        entity_version INT NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'recibido',
        error ${text} DEFAULT NULL,
        received_at_utc VARCHAR(30) NOT NULL,
        applied_at_utc VARCHAR(30) DEFAULT NULL
      )
    `);
    await ctx.createIndex('sync_inbox', 'idx_sync_inbox_entidad', ['entity_type', 'entity_uuid']);

    await ctx.query(`
      CREATE TABLE IF NOT EXISTS sync_cursors (
        stream VARCHAR(60) NOT NULL PRIMARY KEY,
        cursor_value VARCHAR(120) DEFAULT NULL,
        updated_at_utc VARCHAR(30) NOT NULL
      )
    `);
  },

  async verificar(ctx) {
    for (const tabla of TABLAS) {
      if (!(await ctx.hasTable(tabla))) return false;
    }
    return ctx.hasIndex('sync_outbox', 'uq_sync_outbox_event');
  },

  // No se borra una bandeja de salida con eventos sin confirmar: serían
  // operaciones que la nube nunca recibió.
  async down(ctx) {
    if (await ctx.hasTable('sync_outbox')) {
      const sinConfirmar = await ctx.countRows('sync_outbox', "status <> 'sincronizado'");
      if (sinConfirmar > 0) {
        throw new Error(`sync_outbox tiene ${sinConfirmar} evento(s) sin confirmar; no se revierte para no perderlos.`);
      }
    }
    for (const tabla of [...TABLAS].reverse()) await ctx.dropTable(tabla);
  },
};
