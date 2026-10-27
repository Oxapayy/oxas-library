const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (value: string) => encoder.encode(value);
export const unutf8 = (value: Uint8Array) => decoder.decode(value);
export function base64(value: Uint8Array) {
  let result = "";
  for (let i = 0; i < value.length; i += 16384)
    result += String.fromCharCode(...value.subarray(i, i + 16384));
  return btoa(result);
}
export function fromBase64(value: string) {
  if (typeof value !== "string" || value.length > 768 * 1024)
    throw Error("Invalid synced library data.");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export const encodeJSON = (value: unknown) =>
  base64(utf8(JSON.stringify(value)));
export const decodeJSON = (value: string) =>
  JSON.parse(unutf8(fromBase64(value)));
const context = (owner: string, purpose: string) =>
  utf8(`OxaLibrary:v1:${owner.toLowerCase()}:${purpose}`);
async function aesKey(key: Uint8Array, usages: KeyUsage[]) {
  if (key.length !== 32) throw Error("Invalid encrypted library key.");
  return crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    usages,
  );
}
export async function seal(
  data: Uint8Array,
  key: Uint8Array,
  owner: string,
  purpose: string,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
) {
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: context(owner, purpose) as BufferSource,
      },
      await aesKey(key, ["encrypt"]),
      data as BufferSource,
    ),
  );
  const combined = new Uint8Array(nonce.length + bytes.length);
  combined.set(nonce);
  combined.set(bytes, nonce.length);
  return base64(combined);
}
export async function open(
  value: string,
  key: Uint8Array,
  owner: string,
  purpose: string,
) {
  const bytes = fromBase64(value);
  if (bytes.length < 28 || bytes.length > 524288)
    throw Error("Invalid encrypted connection.");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12) as BufferSource,
        additionalData: context(owner, purpose) as BufferSource,
      },
      await aesKey(key, ["decrypt"]),
      bytes.subarray(12) as BufferSource,
    ),
  );
}
export async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
) {
  if (
    salt.length !== 32 ||
    !Number.isInteger(iterations) ||
    iterations < 600000 ||
    iterations > 2000000 ||
    utf8(password).length > 1024
  )
    throw Error("Unsupported encrypted library settings.");
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations,
        hash: "SHA-256",
      },
      material,
      256,
    ),
  );
}
export async function createVault(
  owner: string,
  password: string,
  key = crypto.getRandomValues(new Uint8Array(32)),
  generation = crypto.randomUUID().toUpperCase(),
) {
  if (password.length < 10) throw Error("Use at least 10 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(32)),
    iterations = 600000;
  return {
    key,
    settings: {
      user_id: owner.toLowerCase(),
      generation,
      salt: base64(salt),
      iterations,
      wrapped_key: await seal(
        key,
        await derive(password, salt, iterations),
        owner,
        `wrap:${generation.toUpperCase()}`,
      ),
    },
  };
}
export async function unlockVault(settings: any, password: string) {
  return open(
    settings.wrapped_key,
    await derive(password, fromBase64(settings.salt), settings.iterations),
    settings.user_id,
    `wrap:${settings.generation.toUpperCase()}`,
  );
}
