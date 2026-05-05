import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config.js';

// Derive separate 32-byte subkeys from the master key:
//   - encKey: encrypts API keys with ChaCha20-Poly1305 (AEAD)
//   - macKey: HMAC-SHA256 for stable, non-reversible fingerprinting
const masterBytes = Buffer.from(env.MIGRATOR_MASTER_KEY, 'utf8');
const salt = Buffer.from('migrator/v1', 'utf8');

const encKey = Buffer.from(hkdfSync('sha256', masterBytes, salt, Buffer.from('pinecone-key'), 32));
const macKey = Buffer.from(hkdfSync('sha256', masterBytes, salt, Buffer.from('fingerprint'), 32));

const ALGO = 'chacha20-poly1305';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt a Pinecone API key for at-rest storage. Returns base64(nonce || ciphertext || authTag). */
export function encryptApiKey(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, encKey, nonce, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

/** Decrypt a previously-encrypted Pinecone API key. */
export function decryptApiKey(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encKey, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Stable, non-reversible fingerprint for an API key (HMAC-SHA256 truncated). Used to detect
 * duplicate connections without ever putting a plaintext key into a log line or DB index.
 */
export function fingerprintApiKey(plaintext: string): string {
  return createHmac('sha256', macKey).update(plaintext, 'utf8').digest('hex').slice(0, 32);
}

/** Generate a fresh random session token for users who want server-side session-only keys. */
export function newSessionToken(): string {
  return randomBytes(24).toString('base64url');
}
