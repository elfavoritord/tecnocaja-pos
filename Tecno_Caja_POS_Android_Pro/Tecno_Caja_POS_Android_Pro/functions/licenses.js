'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const getMyBusinessLicense = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(uid).get();
  const user = userDoc.data() || {};
  const businessId = String(user.businessId || '').trim();
  if (!userDoc.exists || !businessId) {
    throw new HttpsError('failed-precondition', 'La cuenta no tiene una empresa vinculada.');
  }

  let licenseDoc = await db.collection('licencias').doc(businessId).get();
  if (!licenseDoc.exists) {
    const query = await db.collection('licencias')
      .where('businessId', '==', businessId).limit(1).get();
    if (!query.empty) licenseDoc = query.docs[0];
  }
  if (!licenseDoc.exists) {
    return {
      businessId,
      status: 'expired',
      planCode: null,
      message: 'Esta empresa no tiene una licencia registrada.',
      checkedAt: new Date().toISOString(),
    };
  }

  const license = licenseDoc.data() || {};
  let status = String(license.status || 'expired').toLowerCase();
  const toDate = (value) => value?.toDate?.() || (value ? new Date(value) : null);
  const trialEndsAt = toDate(license.trialEndsAt);
  const expiresAt = toDate(license.expiresAt || license.expirationDate);
  const now = new Date();
  if (status === 'trial' && trialEndsAt && trialEndsAt <= now) status = 'expired';
  if (status === 'active' && expiresAt && expiresAt <= now) status = 'expired';
  if (!['trial', 'active', 'suspended', 'expired'].includes(status)) {
    status = 'suspended';
  }

  return {
    businessId,
    status,
    planCode: license.planCode || null,
    planName: license.planName || null,
    trialEndsAt: trialEndsAt?.toISOString() || null,
    expiresAt: expiresAt?.toISOString() || null,
    maxUsers: license.maxUsers ?? null,
    maxDevices: license.maxDevices ?? null,
    maxBranches: license.maxBranches ?? null,
    maxRegisters: license.maxRegisters ?? license.maxCashRegisters ?? null,
    modules: Array.isArray(license.modules) ? license.modules : [],
    message: license.message || null,
    checkedAt: now.toISOString(),
  };
});

module.exports = { getMyBusinessLicense };
