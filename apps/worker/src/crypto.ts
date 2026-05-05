import { createDecipheriv, hkdfSync } from 'node:crypto';
import { env } from './config.js';

const masterBytes = Buffer.from(env.MIGRATOR_MASTER_KEY, 'utf8');
const salt = Buffer.from('migrator/v1', 'utf8');
const encKey = Buffer.from(hkdfSync('sha256', masterBytes, salt, Buffer.from('pinecone-key'), 32));

const ALGO = 'chacha20-poly1305';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Decrypt a Pinecone API key stored by the API service. */
export function decryptApiKey(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encKey, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
