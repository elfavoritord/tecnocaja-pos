'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const ADMIN_ROLES = new Set([
  'superadmin', 'businessOwner', 'admin', 'administrador',
  'Administrador', 'Administrador General', 'branchAdmin', 'branch_admin',
]);
const BUSINESS_WIDE_ADMIN_ROLES = new Set([
  'superadmin', 'businessOwner', 'admin', 'administrador',
  'Administrador', 'Administrador General',
]);

const createBusinessUser = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const callerDoc = await db.collection('users').doc(callerUid).get();
  const caller = callerDoc.data() || {};
  if (!callerDoc.exists || caller.isActive === false || !ADMIN_ROLES.has(String(caller.role || ''))) {
    throw new HttpsError('permission-denied', 'No tienes permiso para crear usuarios.');
  }

  const businessId = String(caller.businessId || '').trim();
  const email = String(request.data?.email || '').trim().toLowerCase();
  const password = String(request.data?.password || '');
  const displayName = String(request.data?.displayName || '').trim();
  const role = String(request.data?.role || 'cashier').trim();
  const requestedBranchId = String(request.data?.branchId || '').trim();
  const callerBranches = Array.isArray(caller.branchIds)
    ? caller.branchIds.map(String)
    : [];
  const branchId = requestedBranchId || callerBranches[0] || '';

  if (!businessId || !displayName || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'Nombre y correo válido son obligatorios.');
  }
  if (password.length < 6) {
    throw new HttpsError('invalid-argument', 'La contraseña temporal debe tener al menos 6 caracteres.');
  }
  if (!branchId || !callerBranches.includes(branchId)) {
    throw new HttpsError('permission-denied', 'Solo puedes asignar usuarios a una sucursal autorizada.');
  }

  let authUser;
  try {
    authUser = await admin.auth().createUser({
      email,
      password,
      displayName,
      disabled: false,
      emailVerified: false,
    });
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Ese correo ya pertenece a otra cuenta.');
    }
    throw error;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    displayName,
    email,
    role,
    isActive: true,
    businessId,
    businessIds: [businessId],
    branchIds: [branchId],
    allowedModules: [],
    source: 'mobile',
    createdBy: callerUid,
    createdAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  batch.set(db.collection('users').doc(authUser.uid), payload);
  batch.set(
    db.collection('businesses').doc(businessId).collection('users').doc(authUser.uid),
    payload
  );
  await batch.commit();

  return { uid: authUser.uid, businessId, branchId };
});

const updateBusinessUser = onCall({ cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');

  const db = admin.firestore();
  const callerDoc = await db.collection('users').doc(callerUid).get();
  const caller = callerDoc.data() || {};
  if (!callerDoc.exists || caller.isActive === false ||
      !ADMIN_ROLES.has(String(caller.role || ''))) {
    throw new HttpsError(
      'permission-denied',
      'No tienes permiso para administrar usuarios.'
    );
  }

  let targetUid = String(request.data?.uid || '').trim();
  const lookupEmail = String(
    request.data?.lookupEmail || request.data?.email || ''
  ).trim().toLowerCase();
  const posUserId = String(request.data?.posUserId || '').trim();
  const businessId = String(caller.businessId || '').trim();
  const businessUsers = db.collection('businesses').doc(businessId)
    .collection('users');

  if (!targetUid && posUserId) {
    const byPosId = await businessUsers
      .where('posUserId', '==', posUserId).limit(1).get();
    if (!byPosId.empty) targetUid = byPosId.docs[0].id;
  }
  if (!targetUid && lookupEmail) {
    const byEmail = await businessUsers
      .where('email', '==', lookupEmail).limit(1).get();
    if (!byEmail.empty) targetUid = byEmail.docs[0].id;
  }
  if (targetUid === callerUid && request.data?.isActive === false) {
    throw new HttpsError(
      'failed-precondition',
      'No puedes desactivar tu propia cuenta.'
    );
  }

  const callerBranches = Array.isArray(caller.branchIds)
    ? caller.branchIds.map(String)
    : [];
  let targetDoc = targetUid
    ? await db.collection('users').doc(targetUid).get()
    : null;
  let target = targetDoc?.data() || {};
  if ((!targetDoc || !targetDoc.exists) && lookupEmail) {
    try {
      const authUser = await admin.auth().getUserByEmail(lookupEmail);
      const authProfile = await db.collection('users').doc(authUser.uid).get();
      if (authProfile.exists) {
        targetUid = authUser.uid;
        targetDoc = authProfile;
        target = authProfile.data() || {};
      }
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
  }

  // Usuarios antiguos importados desde el POS pueden no tener cuenta Auth.
  // Un administrador autorizado puede vincularlos al crear su primer acceso.
  if ((!targetDoc || !targetDoc.exists) && !targetUid) {
    const password = String(request.data?.password || '');
    const displayName = String(request.data?.displayName || '').trim();
    const email = String(request.data?.email || '').trim().toLowerCase();
    if (password.length < 6) {
      throw new HttpsError(
        'failed-precondition',
        'Este usuario viene del POS. Indica una contraseña nueva de al menos 6 caracteres para activar su acceso móvil.'
      );
    }
    const branchId = String(request.data?.branchId || callerBranches[0] || '');
    if (!branchId || !callerBranches.includes(branchId)) {
      throw new HttpsError(
        'permission-denied',
        'No puedes vincular este usuario a esa sucursal.'
      );
    }
    const authUser = await admin.auth().createUser({
      email,
      password,
      displayName,
      disabled: request.data?.isActive === false,
    });
    targetUid = authUser.uid;
    const linkedProfile = {
      displayName,
      email,
      role: String(request.data?.role || 'cashier'),
      isActive: request.data?.isActive !== false,
      businessId,
      businessIds: [businessId],
      branchIds: [branchId],
      allowedModules: [],
      source: 'pos-linked',
      posUserId: posUserId || null,
      createdBy: callerUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const linkBatch = db.batch();
    linkBatch.set(db.collection('users').doc(targetUid), linkedProfile);
    linkBatch.set(businessUsers.doc(targetUid), linkedProfile);
    await linkBatch.commit();
    return { uid: targetUid, isActive: linkedProfile.isActive, linked: true };
  }

  const targetBranches = Array.isArray(target.branchIds)
    ? target.branchIds.map(String)
    : [];
  const callerIsBusinessWideAdmin = BUSINESS_WIDE_ADMIN_ROLES.has(
    String(caller.role || '')
  );
  if (!targetDoc || !targetDoc.exists ||
      String(target.businessId || '') !== businessId ||
      (!callerIsBusinessWideAdmin &&
       !targetBranches.some((branch) => callerBranches.includes(branch)))) {
    throw new HttpsError(
      'permission-denied',
      'Solo puedes administrar usuarios de tu empresa y sucursal.'
    );
  }

  const displayName = String(request.data?.displayName || '').trim();
  const email = String(request.data?.email || '').trim().toLowerCase();
  const password = String(request.data?.password || '');
  const role = String(request.data?.role || target.role || 'cashier').trim();
  const isActive = request.data?.isActive !== false;
  if (!displayName || !email.includes('@')) {
    throw new HttpsError(
      'invalid-argument',
      'Nombre y correo válido son obligatorios.'
    );
  }
  if (password && password.length < 6) {
    throw new HttpsError(
      'invalid-argument',
      'La nueva contraseña debe tener al menos 6 caracteres.'
    );
  }

  try {
    const authChanges = {
      displayName,
      email,
      disabled: !isActive,
    };
    if (password) authChanges.password = password;
    await admin.auth().updateUser(targetUid, authChanges);
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') {
      throw new HttpsError(
        'already-exists',
        'Ese correo ya pertenece a otra cuenta.'
      );
    }
    throw error;
  }

  const changes = {
    displayName,
    email,
    role,
    isActive,
    updatedBy: callerUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(db.collection('users').doc(targetUid), changes);
  batch.set(
    db.collection('businesses').doc(businessId)
      .collection('users').doc(targetUid),
    changes,
    { merge: true }
  );
  await batch.commit();
  return { uid: targetUid, isActive };
});

module.exports = { createBusinessUser, updateBusinessUser };
