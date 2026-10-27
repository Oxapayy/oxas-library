import { sha256 } from '@noble/hashes/sha2.js';

// The shared model needs synchronous stable identities, not Node's crypto API.
export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw Error('Unsupported identity hash.');
  const hash = sha256.create();
  return {
    update(value: string | Uint8Array) {
      hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return this;
    },
    digest(format: string) {
      if (format !== 'hex') throw Error('Unsupported identity encoding.');
      return Array.from(hash.digest(), x => x.toString(16).padStart(2, '0')).join('');
    }
  };
}
