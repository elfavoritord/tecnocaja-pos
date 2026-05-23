'use strict';

describe('modules/plans.syncLicenseFromFirebase', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    delete process.env.TECNO_CAJA_LICENSE_UID;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = envSnapshot;
    jest.dontMock('../../modules/firebase-admin');
  });

  it('sincroniza la licencia aunque TECNO_CAJA_LICENSE_UID no esté configurado', async () => {
    const fetchRemotePosLicenseState = jest.fn().mockResolvedValue({
      id: 'pos_demo_123',
      status: 'active',
      planCode: 'plus',
      trialEndsAt: new Date('2026-05-05T10:00:00.000Z'),
    });

    jest.doMock('../../modules/firebase-admin', () => ({
      fetchRemotePosLicenseState,
    }));

    const plans = require('../../modules/plans');
    const query = jest.fn(async (sql, params = []) => {
      if (sql.includes('SELECT business_name, plan_code, business_structure_mode FROM config')) {
        return [{ business_name: 'Demo POS', plan_code: 'basico', business_structure_mode: 'monocaja' }];
      }
      if (sql.includes('SELECT firebase_uid')) {
        return [{ firebase_uid: 'admin_uid_1' }];
      }
      if (sql.includes('UPDATE config')) {
        return [{ sql, params }];
      }
      return [];
    });

    const result = await plans.syncLicenseFromFirebase(query);

    expect(fetchRemotePosLicenseState).toHaveBeenCalledWith({
      business_name: 'Demo POS',
      principalFirebaseUid: 'admin_uid_1',
    });
    expect(result).toEqual({
      planCode: 'plus',
      status: 'active',
      planExpiresAt: new Date('2026-05-05T10:00:00.000Z'),
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE config'),
      ['plus', 'Tecno Caja Plus', '2026-05-05 10:00:00', 'active', 'multisucursal']
    );
  });
});
