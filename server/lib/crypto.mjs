import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nativeRandomBytes,
} from 'node:crypto';
import { BoardError } from './errors.mjs';

function aad(context, keyId) {
  if (
    !context ||
    !['oauth-pkce', 'github-token-pair'].includes(context.purpose) ||
    typeof context.recordKey !== 'string' ||
    context.recordKey.length > 256 ||
    context.schemaVersion !== 1 ||
    context.ownerId !== 99961
  )
    throw new BoardError('service_unavailable');
  return Buffer.from(
    JSON.stringify([
      context.purpose,
      context.recordKey,
      context.schemaVersion,
      context.ownerId,
      keyId,
    ]),
  );
}

function decode(value, length, max = 65536) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new BoardError('service_unavailable');
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (length !== undefined && bytes.length !== length)
  )
    throw new BoardError('service_unavailable');
  return bytes;
}

export function createCrypto({ keyring, randomBytes = nativeRandomBytes }) {
  const keys = new Map(keyring.keys);
  if (
    !keys.has(keyring.currentId) ||
    [...keys.values()].some((key) => !Buffer.isBuffer(key) || key.length !== 32)
  )
    throw new BoardError('service_unavailable');
  return Object.freeze({
    encrypt(value, context) {
      try {
        const keyId = keyring.currentId;
        const nonce = randomBytes(12);
        if (!Buffer.isBuffer(nonce) || nonce.length !== 12)
          throw new Error('Invalid nonce');
        const cipher = createCipheriv('aes-256-gcm', keys.get(keyId), nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(aad(context, keyId));
        const plaintext = JSON.stringify(value);
        if (
          typeof plaintext !== 'string' ||
          Buffer.byteLength(plaintext) > 32768
        )
          throw new Error('Invalid plaintext');
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, 'utf8'),
          cipher.final(),
        ]);
        return {
          version: 1,
          keyId,
          nonce: nonce.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        };
      } catch {
        throw new BoardError('service_unavailable');
      }
    },
    decrypt(envelope, context) {
      try {
        if (
          !envelope ||
          envelope.version !== 1 ||
          !keys.has(envelope.keyId) ||
          Object.keys(envelope).sort().join(',') !==
            'ciphertext,keyId,nonce,tag,version'
        )
          throw new Error('Invalid envelope');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          keys.get(envelope.keyId),
          decode(envelope.nonce, 12),
          { authTagLength: 16 },
        );
        decipher.setAAD(aad(context, envelope.keyId));
        decipher.setAuthTag(decode(envelope.tag, 16));
        const bytes = Buffer.concat([
          decipher.update(decode(envelope.ciphertext)),
          decipher.final(),
        ]);
        if (bytes.length > 32768) throw new Error('Invalid plaintext');
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new BoardError('service_unavailable');
      }
    },
  });
}
