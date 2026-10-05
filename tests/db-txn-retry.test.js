/**
 * Clasificación de errores transitorios de concurrencia MySQL para el reintento
 * de transacciones (multicaja: varias PC contra un MySQL por Tailscale).
 */
const { _isTransientTxnError: classify } = require('../db');

describe('isTransientTxnError', () => {
  test('reintenta ER_LOCK_WAIT_TIMEOUT (1205)', () => {
    expect(classify({ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })).toMatchObject({ retry: true, kind: 'lock_timeout' });
    expect(classify({ errno: 1205 })).toMatchObject({ retry: true });
  });

  test('reintenta ER_LOCK_DEADLOCK (1213)', () => {
    expect(classify({ code: 'ER_LOCK_DEADLOCK', errno: 1213 })).toMatchObject({ retry: true, kind: 'deadlock' });
  });

  test('reintenta ER_CHECKREAD (1020) — conflicto de snapshot de MariaDB 11.6+', () => {
    expect(classify({ code: 'ER_CHECKREAD', errno: 1020, message: "Record has changed since last read in table 'config'" }))
      .toMatchObject({ retry: true, kind: 'snapshot_conflict' });
  });

  test('no reintenta la misma venta reenviada (client_request_id)', () => {
    expect(classify({ code: 'ER_DUP_ENTRY', errno: 1062, message: "Duplicate entry 'abc' for key 'sales.uq_sales_client_request_id'" }))
      .toMatchObject({ retry: false });
  });

  test('reintenta ER_DUP_ENTRY solo si es de invoice_number', () => {
    expect(classify({ code: 'ER_DUP_ENTRY', errno: 1062, message: "Duplicate entry 'FAC-00001050' for key 'sales.invoice_number'" }))
      .toMatchObject({ retry: true, kind: 'dup_invoice' });
    // dup en otra tabla/clave -> NO reintentar
    expect(classify({ code: 'ER_DUP_ENTRY', errno: 1062, message: "Duplicate entry 'x' for key 'clients.cedula'" }))
      .toMatchObject({ retry: false });
  });

  test('no reintenta errores de negocio ni de esquema', () => {
    expect(classify({ statusCode: 409, message: 'No hay caja abierta' })).toMatchObject({ retry: false });
    expect(classify({ code: 'ER_NO_SUCH_TABLE', errno: 1146 })).toMatchObject({ retry: false });
    expect(classify(new Error('cualquier cosa'))).toMatchObject({ retry: false });
  });
});

describe('withTransactionRetry en SQLite (sin concurrencia entre procesos)', () => {
  test('NO reintenta — propaga el error al primer intento', async () => {
    const { withTransactionRetry } = require('../db');
    let attempts = 0;
    await expect(
      withTransactionRetry(async () => {
        attempts += 1;
        const e = new Error('lock'); e.code = 'ER_LOCK_WAIT_TIMEOUT'; e.errno = 1205;
        throw e;
      })
    ).rejects.toThrow('lock');
    expect(attempts).toBe(1);
  });
});
