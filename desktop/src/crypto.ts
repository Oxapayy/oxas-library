import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2,
} from "node:crypto";
import { promisify } from "node:util";
import { uuid } from "./model";
const deriveAsync = promisify(pbkdf2);
export const context = (owner: string, purpose: string) =>
  Buffer.from(`OxaLibrary:v1:${owner.toLowerCase()}:${purpose}`);
export function seal(
  data: Buffer,
  key: Buffer,
  owner: string,
  purpose: string,
  nonce = randomBytes(12),
) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context(owner, purpose));
  return Buffer.concat([
    nonce,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function open(
  value: string,
  key: Buffer,
  owner: string,
  purpose: string,
) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 28 || bytes.length > 524288)
    throw Error("Invalid encrypted connection.");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(context(owner, purpose));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]);
}
export async function derive(
  password: string,
  salt: Buffer,
  iterations: number,
) {
  if (
    salt.length !== 32 ||
    iterations < 600000 ||
    iterations > 2000000 ||
    Buffer.byteLength(password) > 1024
  )
    throw Error("Unsupported encrypted library settings.");
  return Buffer.from(
    await deriveAsync(password, salt, iterations, 32, "sha256"),
  );
}
export async function createVault(
  owner: string,
  password: string,
  key: Buffer = randomBytes(32),
  generation = uuid(),
) {
  if (password.length < 10) throw Error("Use at least 10 characters.");
  const salt = randomBytes(32),
    iterations = 600000;
  return {
    key,
    settings: {
      user_id: owner.toLowerCase(),
      generation,
      salt: salt.toString("base64"),
      iterations,
      wrapped_key: seal(
        key,
        await derive(password, salt, iterations),
        owner,
        `wrap:${generation.toUpperCase()}`,
      ),
    },
  };
}
export async function unlockVault(settings: any, password: string) {
  const key = await derive(
    password,
    Buffer.from(settings.salt, "base64"),
    settings.iterations,
  );
  return open(
    settings.wrapped_key,
    key,
    settings.user_id,
    `wrap:${settings.generation.toUpperCase()}`,
  );
}
