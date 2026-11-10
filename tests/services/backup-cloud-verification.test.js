'use strict';
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  return { S3Client: class { send(...args) { return mockSend(...args); } }, PutObjectCommand: Command, GetObjectCommand: Command, ListObjectsV2Command: Command,
    DeleteObjectCommand: Command, HeadBucketCommand: Command, HeadObjectCommand: Command };
});
const crypto = require('crypto');
const storage = require('../../server/services/r2-storage');
let original;
beforeEach(() => {
  original = { ...process.env };
  Object.assign(process.env, { R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture', R2_ENDPOINT: 'https://s3.test.backblazeb2.com', R2_BUCKET: 'test' });
  storage.resetClient(); mockSend.mockReset();
});
afterEach(() => { process.env = original; });
test('no confirma nube hasta verificar tamaño y SHA del objeto guardado', async () => {
  const buffer = Buffer.from('fixture'); const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: buffer.length, Metadata: { sha256 } });
  expect((await storage.upload('backups/empresa/test.tcbak', buffer)).sha256).toBe(sha256);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls[0][0].input.Metadata.sha256).toBe(sha256);
});
test('un tamaño o huella distintos dejan el envío pendiente', async () => {
  mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ ContentLength: 0, Metadata: { sha256: 'incorrecto' } });
  await expect(storage.upload('backups/empresa/test.tcbak', Buffer.from('fixture'))).rejects.toThrow(/Permanece pendiente/);
});
