import type { Ink } from './ink';
import {
  VaultError,
  addPasskeyWrap,
  changePassphrase as setPassphraseWrap,
  cipherFor,
  createVault,
  createVaultWithPrf,
  readContents,
  readJson,
  removePasskeyWrap,
  unlockWithPassphrase,
  unlockWithPrf,
  writeJson,
  type Cipher,
  type KdfOptions,
  type PasskeyInfo,
  type PasskeyWrap,
  type Unlocked,
  type Vault,
} from './vault';

export type NewSavedSignature = { kind: 'ink'; ink: Ink } | { kind: 'image'; png: Uint8Array; width: number; height: number };
export type SavedSignature = NewSavedSignature & { id: string };

export interface VaultStorage {
  load(): Promise<Vault | null>;
  save(vault: Vault): Promise<void>;
  clear(): Promise<void>;
}

export type StoredSignature = { id: string; kind: 'ink'; ink: Ink } | { id: string; kind: 'image'; png: string; width: number; height: number };

/**
 * Browser storage is shared per origin, and every GitHub Pages site of an account
 * shares one, so any of them could read a vault kept there. Saving stays off on it.
 */
export function canUseVault(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host !== 'github.io' && !host.endsWith('.github.io');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const toStored = (s: SavedSignature): StoredSignature => (s.kind === 'ink' ? s : { ...s, png: toBase64(s.png) });
export const fromStored = (s: StoredSignature): SavedSignature => (s.kind === 'ink' ? s : { ...s, png: fromBase64(s.png) });

const encode = (list: SavedSignature[]) => new TextEncoder().encode(JSON.stringify(list.map(toStored)));

/** The saved signatures: encrypted in storage, and held in memory only while unlocked. */
export class SignatureVault {
  private session: Unlocked | null = null;
  private entries: SavedSignature[] = [];

  constructor(
    private storage: VaultStorage,
    private kdf: KdfOptions = {},
  ) {}

  async state(): Promise<'none' | 'locked' | 'unlocked'> {
    const stored = await this.storage.load();
    if (!stored) {
      this.lock();
      return 'none';
    }
    return this.session ? 'unlocked' : 'locked';
  }

  async create(passphrase: string): Promise<void> {
    if (await this.storage.load()) throw new VaultError('invalid-input', 'Saved signatures already exist on this device.');
    const { vault, unlocked } = await createVault(passphrase, encode([]), this.kdf);
    await this.storage.save(vault);
    this.session = unlocked;
    this.entries = [];
  }

  /** A vault with no passphrase: losing this passkey loses the signatures. */
  async createWithPasskey(info: PasskeyInfo, prf: Uint8Array): Promise<void> {
    if (await this.storage.load()) throw new VaultError('invalid-input', 'Saved signatures already exist on this device.');
    const { vault, unlocked } = await createVaultWithPrf(info, prf, encode([]));
    await this.storage.save(vault);
    this.session = unlocked;
    this.entries = [];
  }

  async hasPassphrase(): Promise<boolean> {
    const stored = await this.storage.load();
    return stored?.wraps.some((w) => w.kind === 'passphrase') ?? false;
  }

  /** Gives a passkey-only vault a passphrase too. Its passkeys keep working. */
  async addPassphrase(passphrase: string): Promise<void> {
    if (!this.session) throw new VaultError('invalid-input', 'Saved signatures are locked.');
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    await this.storage.save(await setPassphraseWrap(stored, this.session, passphrase, this.kdf));
  }

  async unlock(passphrase: string): Promise<SavedSignature[]> {
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    const session = await unlockWithPassphrase(stored, passphrase);
    this.entries = (await readJson<StoredSignature[]>(stored, session)).map(fromStored);
    this.session = session;
    return this.entries;
  }

  /** The registered passkeys. These aren't secret, and are needed to offer them while locked. */
  async passkeys(): Promise<PasskeyInfo[]> {
    const stored = await this.storage.load();
    return (stored?.wraps ?? [])
      .filter((w): w is PasskeyWrap => w.kind === 'passkey')
      .map(({ credentialId, prfSalt, label }) => ({ credentialId, prfSalt, label }));
  }

  async unlockWithPasskey(credentialId: Uint8Array, prf: Uint8Array): Promise<SavedSignature[]> {
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    const session = await unlockWithPrf(stored, credentialId, prf);
    this.entries = (await readJson<StoredSignature[]>(stored, session)).map(fromStored);
    this.session = session;
    return this.entries;
  }

  async addPasskey(info: PasskeyInfo, prf: Uint8Array): Promise<void> {
    if (!this.session) throw new VaultError('invalid-input', 'Saved signatures are locked.');
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    await this.storage.save(await addPasskeyWrap(stored, this.session, info, prf));
  }

  async removePasskey(credentialId: Uint8Array): Promise<void> {
    if (!this.session) throw new VaultError('invalid-input', 'Saved signatures are locked.');
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    await this.storage.save(removePasskeyWrap(stored, credentialId));
  }

  lock() {
    this.session = null;
    this.entries = [];
  }

  list(): SavedSignature[] {
    return this.entries;
  }

  /** The vault's key for encrypting other data, while unlocked. */
  cipher(): Cipher | null {
    return this.session ? cipherFor(this.session) : null;
  }

  /** Applies a change on top of what's stored now, so a second open tab's saves aren't overwritten. */
  private async update(change: (list: SavedSignature[]) => SavedSignature[]) {
    if (!this.session) throw new VaultError('invalid-input', 'Saved signatures are locked.');
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    const next = change((await readJson<StoredSignature[]>(stored, this.session)).map(fromStored));
    await this.storage.save(await writeJson(stored, this.session, next.map(toStored)));
    this.entries = next;
  }

  async add(signature: NewSavedSignature): Promise<SavedSignature> {
    const saved: SavedSignature = { ...signature, id: crypto.randomUUID() };
    await this.update((list) => [...list, saved]);
    return saved;
  }

  async remove(id: string): Promise<void> {
    await this.update((list) => list.filter((s) => s.id !== id));
  }

  /**
   * Re-encrypts under a new key, not just a new passphrase, so an older stolen copy
   * plus the old passphrase can't open what's saved from now on. Passkeys are tied to
   * the old key, so they're dropped and need adding again.
   */
  async changePassphrase(passphrase: string, rekey?: (before: Cipher, after: Cipher) => Promise<void>): Promise<void> {
    if (!this.session) throw new VaultError('invalid-input', 'Saved signatures are locked.');
    const stored = await this.storage.load();
    if (!stored) throw new VaultError('invalid-input', 'There are no saved signatures on this device.');
    const contents = await readContents(stored, this.session);
    const { vault, unlocked } = await createVault(passphrase, contents, this.kdf);
    await rekey?.(cipherFor(this.session), cipherFor(unlocked));
    await this.storage.save(vault);
    this.session = unlocked;
  }

  async destroy(): Promise<void> {
    await this.storage.clear();
    this.lock();
  }
}
