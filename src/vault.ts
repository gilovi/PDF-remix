/**
 * Pure crypto core of the signature vault (WebCrypto only; no storage, no UI, no WebAuthn).
 *
 * Envelope encryption: a random 256-bit data key encrypts the contents with AES-GCM (fresh
 * IV on every write). The data key is stored only wrapped, once per unlock method. A vault is
 * a plain structured-cloneable object, and every function here returns a new vault instead of
 * mutating its input.
 */

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERSION = 1;

const NS = 'pdf-remix-vault/v1';
const HKDF_INFO = `${NS}/passkey-wrap-key`;
const CONTENTS_AAD = `${NS}/contents`;

export type PassphraseWrap = {
  kind: 'passphrase';
  salt: Uint8Array;
  iterations: number;
  iv: Uint8Array;
  wrapped: Uint8Array;
};
export type PasskeyWrap = {
  kind: 'passkey';
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  label: string;
  iv: Uint8Array;
  wrapped: Uint8Array;
};
export type Wrap = PassphraseWrap | PasskeyWrap;

export type Vault = {
  version: 1;
  /** IV of the current contents ciphertext. Replaced on every write. */
  iv: Uint8Array;
  ciphertext: Uint8Array;
  /** Always exactly one passphrase wrap (first), plus any number of passkey wraps. */
  wraps: Wrap[];
};

/** The in-memory session: holds the data key. Never persist it. */
export type Unlocked = { dataKey: CryptoKey };

export type KdfOptions = { iterations?: number };
export type PasskeyInfo = { credentialId: Uint8Array; prfSalt: Uint8Array; label: string };

export type VaultErrorCode =
  | 'weak-passphrase'
  | 'wrong-credentials'
  | 'no-such-wrap'
  | 'duplicate-wrap'
  | 'invalid-input'
  | 'corrupt';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const bs = (u: Uint8Array) => u as unknown as BufferSource;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError('weak-passphrase', `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

function checkIterations(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS) {
    throw new VaultError('corrupt', 'The vault has an invalid key-derivation setting.');
  }
}

// Additional data binds each wrap to its method and parameters, so a wrap cannot be moved to
// another method, credential or iteration count. The label is deliberately not bound (renamable).
const passphraseAad = (iterations: number) => enc.encode(`${NS}/wrap/passphrase/${iterations}`);
const passkeyAad = (credentialId: Uint8Array, prfSalt: Uint8Array) =>
  enc.encode(`${NS}/wrap/passkey/${hex(credentialId)}/${hex(prfSalt)}`);

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function prfKey(prfBytes: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  if (prfBytes.length === 0) throw new VaultError('invalid-input', 'The passkey returned no key material.');
  const base = await crypto.subtle.importKey('raw', bs(prfBytes), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(prfSalt), info: enc.encode(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapDataKey(
  wrappingKey: CryptoKey,
  dataKey: CryptoKey,
  aad: Uint8Array,
): Promise<{ iv: Uint8Array; wrapped: Uint8Array }> {
  const raw = await crypto.subtle.exportKey('raw', dataKey);
  const iv = randomBytes(IV_BYTES);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) },
    wrappingKey,
    raw,
  );
  return { iv, wrapped: new Uint8Array(wrapped) };
}

async function unwrapDataKey(
  wrappingKey: CryptoKey,
  wrap: { iv: Uint8Array; wrapped: Uint8Array },
  aad: Uint8Array,
  failure: string,
): Promise<Unlocked> {
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(wrap.iv), additionalData: bs(aad) },
      wrappingKey,
      bs(wrap.wrapped),
    );
  } catch {
    throw new VaultError('wrong-credentials', failure);
  }
  if (raw.byteLength !== 32) throw new VaultError('corrupt', 'The vault key has an unexpected size.');
  // Extractable so that further wraps can be created while the session is unlocked.
  const dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  return { dataKey };
}

async function makePassphraseWrap(
  dataKey: CryptoKey,
  passphrase: string,
  iterations: number,
): Promise<PassphraseWrap> {
  const salt = randomBytes(SALT_BYTES);
  const key = await passphraseKey(passphrase, salt, iterations);
  const { iv, wrapped } = await wrapDataKey(key, dataKey, passphraseAad(iterations));
  return { kind: 'passphrase', salt, iterations, iv, wrapped };
}

async function encryptContents(dataKey: CryptoKey, contents: Uint8Array): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: enc.encode(CONTENTS_AAD) },
    dataKey,
    bs(contents),
  );
  return { iv, ciphertext: new Uint8Array(ct) };
}

function checkVault(vault: Vault): void {
  if (vault.version !== VERSION) throw new VaultError('corrupt', 'This vault was made by an unsupported version.');
}

/** Create a vault holding `contents`. Returns it together with the unlocked session. */
export async function createVault(
  passphrase: string,
  contents: Uint8Array,
  options: KdfOptions = {},
): Promise<{ vault: Vault; unlocked: Unlocked }> {
  checkPassphrase(passphrase);
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrap = await makePassphraseWrap(dataKey, passphrase, iterations);
  const { iv, ciphertext } = await encryptContents(dataKey, contents);
  return { vault: { version: VERSION, iv, ciphertext, wraps: [wrap] }, unlocked: { dataKey } };
}

export async function unlockWithPassphrase(vault: Vault, passphrase: string): Promise<Unlocked> {
  checkVault(vault);
  const wrap = vault.wraps.find((w): w is PassphraseWrap => w.kind === 'passphrase');
  if (!wrap) throw new VaultError('corrupt', 'The vault has no passphrase entry.');
  checkIterations(wrap.iterations);
  const key = await passphraseKey(passphrase, wrap.salt, wrap.iterations);
  return unwrapDataKey(key, wrap, passphraseAad(wrap.iterations), 'Wrong passphrase.');
}

/** `prfBytes` is the already-obtained WebAuthn PRF output for the wrap's `prfSalt`. */
export async function unlockWithPrf(vault: Vault, credentialId: Uint8Array, prfBytes: Uint8Array): Promise<Unlocked> {
  checkVault(vault);
  const wrap = vault.wraps.find((w): w is PasskeyWrap => w.kind === 'passkey' && sameBytes(w.credentialId, credentialId));
  if (!wrap) throw new VaultError('no-such-wrap', 'This passkey is not registered for the vault.');
  const key = await prfKey(prfBytes, wrap.prfSalt);
  return unwrapDataKey(key, wrap, passkeyAad(wrap.credentialId, wrap.prfSalt), 'The passkey could not unlock the vault.');
}

export async function addPasskeyWrap(
  vault: Vault,
  unlocked: Unlocked,
  info: PasskeyInfo,
  prfBytes: Uint8Array,
): Promise<Vault> {
  checkVault(vault);
  if (vault.wraps.some((w) => w.kind === 'passkey' && sameBytes(w.credentialId, info.credentialId))) {
    throw new VaultError('duplicate-wrap', 'This passkey is already registered for the vault.');
  }
  const key = await prfKey(prfBytes, info.prfSalt);
  const { iv, wrapped } = await wrapDataKey(key, unlocked.dataKey, passkeyAad(info.credentialId, info.prfSalt));
  const wrap: PasskeyWrap = {
    kind: 'passkey',
    credentialId: info.credentialId.slice(),
    prfSalt: info.prfSalt.slice(),
    label: info.label,
    iv,
    wrapped,
  };
  return { ...vault, wraps: [...vault.wraps, wrap] };
}

/** Removes one passkey wrap. The passphrase wrap cannot be addressed, so it can never be removed. */
export function removePasskeyWrap(vault: Vault, credentialId: Uint8Array): Vault {
  const keep = vault.wraps.filter((w) => !(w.kind === 'passkey' && sameBytes(w.credentialId, credentialId)));
  if (keep.length === vault.wraps.length) {
    throw new VaultError('no-such-wrap', 'This passkey is not registered for the vault.');
  }
  return { ...vault, wraps: keep };
}

/** Replaces the passphrase wrap (new salt, optionally a higher iteration count). Contents are untouched. */
export async function changePassphrase(
  vault: Vault,
  unlocked: Unlocked,
  newPassphrase: string,
  options: KdfOptions = {},
): Promise<Vault> {
  checkVault(vault);
  checkPassphrase(newPassphrase);
  const wrap = await makePassphraseWrap(unlocked.dataKey, newPassphrase, options.iterations ?? DEFAULT_PBKDF2_ITERATIONS);
  return { ...vault, wraps: [wrap, ...vault.wraps.filter((w) => w.kind !== 'passphrase')] };
}

/** Encrypts `contents` under a fresh IV and returns the updated vault. */
export async function writeContents(vault: Vault, unlocked: Unlocked, contents: Uint8Array): Promise<Vault> {
  checkVault(vault);
  const { iv, ciphertext } = await encryptContents(unlocked.dataKey, contents);
  return { ...vault, iv, ciphertext };
}

export async function readContents(vault: Vault, unlocked: Unlocked): Promise<Uint8Array> {
  checkVault(vault);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(vault.iv), additionalData: enc.encode(CONTENTS_AAD) },
      unlocked.dataKey,
      bs(vault.ciphertext),
    );
    return new Uint8Array(pt);
  } catch {
    throw new VaultError('corrupt', 'The vault contents are damaged or have been tampered with.');
  }
}

export function writeJson(vault: Vault, unlocked: Unlocked, value: unknown): Promise<Vault> {
  return writeContents(vault, unlocked, enc.encode(JSON.stringify(value)));
}

export async function readJson<T = unknown>(vault: Vault, unlocked: Unlocked): Promise<T> {
  const bytes = await readContents(vault, unlocked);
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } catch {
    throw new VaultError('corrupt', 'The vault contents are not valid data.');
  }
}
