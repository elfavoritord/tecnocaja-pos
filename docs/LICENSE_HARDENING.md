# License Hardening for Tecno Caja

## Goal

Move the POS from trusting `config.license_status` to a hardened model where:

- Firebase is the source of truth.
- Local storage is only a signed/encrypted cache.
- Manual edits to SQLite do not activate the system.
- Offline mode is allowed only for a bounded grace period.

## What changed in code

- `server/licensing/license-service.js`
  - Centralizes license validation, cache encryption, signature checks, offline grace and tamper detection.
- `server/security/machine-identity.js`
  - Derives a stable `deviceId` from machine characteristics.
- `server/security/local-machine-crypto.js`
  - Encrypts the local SQLite file at rest and protects the local license cache envelope.
- `db.js`
  - Saves SQLite encrypted at rest using a machine-bound key.
- `server.js`
  - Routes, setup/bootstrap and Firestore watcher now consume the secure license service instead of trusting `config.license_status`.
- `modules/plans.js`
  - Plan-gated endpoints can now use the secure resolved plan instead of the mutable local config alone.

## Firestore license contract

Document: `licencias/{licenseId}`

Recommended fields:

- `licenseId`
- `businessName`
- `businessKey`
- `planCode`
- `status`
- `issuedAt`
- `expiresAt`
- `trialStartedAt`
- `trialEndsAt`
- `deviceLimit`
- `offlineGraceDays`
- `devices`
- `lastValidatedAt`
- `signatureAlg`
- `signature`
- `deviceSignatures`

## Signature payload

Canonical payload used by the POS:

`license_id | business_name | plan | status | issued_at | expires_at | device_id | device_limit | offline_grace_days`

The implementation accepts:

- `signature` for single-device setups.
- `deviceSignatures[deviceId]` for multi-device licenses.

## Production recommendation

The service supports HMAC because it matches the current rollout request, but the stronger production path is:

1. Sign in the backend with Ed25519 private key.
2. Ship only `TECNO_CAJA_LICENSE_PUBLIC_KEY` to the POS.
3. Set `TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE=true`.

If you temporarily stay on HMAC, place `TECNO_CAJA_LICENSE_HMAC_SECRET` outside the repository and rotate it from your deployment environment.

## Device control

On each online validation the POS:

1. Resolves its `deviceId`.
2. Checks current registered devices against `deviceLimit`.
3. Registers/refreshes `devices.{deviceId}` in Firestore when allowed.
4. Blocks locally if the limit is exceeded.

## Offline behavior

- The POS stores `lastValidatedAt` in the hardened cache.
- If the app cannot reach Firebase:
  - it uses the cache only within `offlineGraceDays`
  - it blocks after the grace is exhausted

## Tamper detection

Implemented:

- Encrypted local license cache envelope.
- HMAC integrity hash of the cached envelope.
- Encrypted SQLite file at rest.
- Clock rollback detection from the last trusted timestamps.
- Cross-validation between license fields, signature and current `deviceId`.

## Flutter admin app responsibilities

The admin app/backend should be able to:

- activate or suspend a license
- change `planCode`
- extend `expiresAt`
- set `deviceLimit`
- inspect `devices`
- regenerate signatures after any license field or device assignment changes

## Environment variables

See `.env.example` for:

- `TECNO_CAJA_LICENSE_PUBLIC_KEY`
- `TECNO_CAJA_LICENSE_HMAC_SECRET`
- `TECNO_CAJA_LICENSE_SIGNATURE_ALG`
- `TECNO_CAJA_LICENSE_REQUIRE_SIGNATURE`
- `TECNO_CAJA_LICENSE_OFFLINE_GRACE_DAYS`
- `TECNO_CAJA_LICENSE_STORAGE_SECRET`
- `TECNO_CAJA_DB_KEY_SALT`
- `TECNO_CAJA_DEVICE_SECRET`
