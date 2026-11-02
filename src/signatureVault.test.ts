import { describe, expect, it } from 'vitest';
import { SignatureVault, canUseVault, type VaultStorage } from './signatureVault';
import type { Sealed, Vault } from './vault';

const PASS = 'correct horse battery';
const ink = { paths: ['M0 0L10 0L10 5Z'], width: 10, height: 5 };
const png = new Uint8Array([137, 80, 78, 71, 200, 201]);

function memoryStorage(): VaultStorage & { value: Vault | null } {
  return {
    value: null,
    async load() {
      return this.value ? structuredClone(this.value) : null;
    },
    async save(vault) {
      this.value = structuredClone(vault);
    },
    async clear() {
      this.value = null;
    },
  };
}
const open = (storage: VaultStorage) => new SignatureVault(storage, { iterations: 1000 });

describe('canUseVault', () => {
  it('refuses the shared GitHub Pages origin, in any letter case', () => {
    expect(canUseVault('gilovi.github.io')).toBe(false);
    expect(canUseVault('GILOVI.GitHub.IO')).toBe(false);
  });

  it('allows an origin of its own', () => {
    expect(canUseVault('pdf-remix.pages.dev')).toBe(true);
    expect(canUseVault('localhost')).toBe(true);
    expect(canUseVault('sign.example.com')).toBe(true);
  });

  it('is not fooled by a look-alike name', () => {
    expect(canUseVault('github.io.example.com')).toBe(true);
    expect(canUseVault('notgithub.io')).toBe(true);
  });
});

describe('SignatureVault passkeys', () => {
  const key = { credentialId: new Uint8Array([1, 2, 3]), prfSalt: new Uint8Array(32).fill(4), label: 'Windows Hello' };
  const prf = new Uint8Array(32).fill(9);

  async function withPasskey() {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    await vault.add({ kind: 'ink', ink });
    await vault.addPasskey(key, prf);
    return { storage, vault };
  }

  it('lists passkeys while locked, so they can be offered, without their secrets', async () => {
    const { storage } = await withPasskey();
    const later = open(storage);
    expect(await later.state()).toBe('locked');
    expect(await later.passkeys()).toEqual([key]);
  });

  it('has no passkeys when there is no vault', async () => {
    expect(await open(memoryStorage()).passkeys()).toEqual([]);
  });

  it('unlocks with the passkey’s output, giving the same signatures', async () => {
    const { storage } = await withPasskey();
    const later = open(storage);
    const saved = await later.unlockWithPasskey(key.credentialId, prf);
    expect(saved).toHaveLength(1);
    expect(await later.state()).toBe('unlocked');
  });

  it('fails cleanly with the wrong output and stays locked', async () => {
    const { storage } = await withPasskey();
    const later = open(storage);
    await expect(later.unlockWithPasskey(key.credentialId, new Uint8Array(32).fill(1))).rejects.toThrow(/couldn.t unlock|could not unlock/i);
    expect(await later.state()).toBe('locked');
    expect(later.list()).toEqual([]);
  });

  it('keeps the passphrase working alongside a passkey', async () => {
    const { storage } = await withPasskey();
    expect(await open(storage).unlock(PASS)).toHaveLength(1);
  });

  it('holds several passkeys, each unlocking on its own', async () => {
    const { storage, vault } = await withPasskey();
    const other = { credentialId: new Uint8Array([5]), prfSalt: new Uint8Array(32).fill(6), label: 'Google Password Manager' };
    const otherPrf = new Uint8Array(32).fill(8);
    await vault.addPasskey(other, otherPrf);
    expect((await open(storage).passkeys()).map((p) => p.label)).toEqual(['Windows Hello', 'Google Password Manager']);
    expect(await open(storage).unlockWithPasskey(other.credentialId, otherPrf)).toHaveLength(1);
    expect(await open(storage).unlockWithPasskey(key.credentialId, prf)).toHaveLength(1);
  });

  it('sees signatures saved after the passkey was added', async () => {
    const { storage, vault } = await withPasskey();
    await vault.add({ kind: 'ink', ink });
    expect(await open(storage).unlockWithPasskey(key.credentialId, prf)).toHaveLength(2);
  });

  it('removes a passkey, which can then no longer unlock', async () => {
    const { storage, vault } = await withPasskey();
    await vault.removePasskey(key.credentialId);
    expect(await vault.passkeys()).toEqual([]);
    await expect(open(storage).unlockWithPasskey(key.credentialId, prf)).rejects.toThrow();
    expect(await open(storage).unlock(PASS)).toHaveLength(1);
  });

  it('needs the vault unlocked to add or remove a passkey', async () => {
    const { storage } = await withPasskey();
    const later = open(storage);
    await expect(later.addPasskey({ ...key, credentialId: new Uint8Array([7]) }, prf)).rejects.toThrow(/locked/i);
    await expect(later.removePasskey(key.credentialId)).rejects.toThrow(/locked/i);
  });

  it('drops passkeys when the passphrase changes, as they were tied to the old key', async () => {
    const { storage, vault } = await withPasskey();
    await vault.changePassphrase('a different passphrase');
    expect(await vault.passkeys()).toEqual([]);
    await expect(open(storage).unlockWithPasskey(key.credentialId, prf)).rejects.toThrow();
  });
});

describe('SignatureVault key for other data', () => {
  it('offers its key only while unlocked', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    expect(vault.cipher()).toBeNull();
    await vault.create(PASS);
    expect(vault.cipher()).not.toBeNull();
    vault.lock();
    expect(vault.cipher()).toBeNull();
  });

  it('gives the same key in a later session', async () => {
    const storage = memoryStorage();
    const first = open(storage);
    await first.create(PASS);
    const sealed = await first.cipher()!.seal(new Uint8Array([1, 2, 3]), 'x');
    const later = open(storage);
    await later.unlock(PASS);
    expect(await later.cipher()!.open(sealed, 'x')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('hands over the old and new key when the passphrase changes, before saving', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    const sealed = await vault.cipher()!.seal(new Uint8Array([5]), 'x');
    let resealed: Sealed | null = null;
    await vault.changePassphrase('a different passphrase', async (before, after) => {
      resealed = await after.seal(await before.open(sealed, 'x'), 'x');
    });
    expect(await vault.cipher()!.open(resealed!, 'x')).toEqual(new Uint8Array([5]));
    await expect(vault.cipher()!.open(sealed, 'x')).rejects.toThrow();
  });
});

describe('SignatureVault with only a passkey', () => {
  const key = { credentialId: new Uint8Array([1, 2, 3]), prfSalt: new Uint8Array(32).fill(4), label: 'Windows Hello' };
  const prf = new Uint8Array(32).fill(9);

  async function passkeyOnly() {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.createWithPasskey(key, prf);
    await vault.add({ kind: 'ink', ink });
    return { storage, vault };
  }

  it('is created unlocked, with no passphrase', async () => {
    const { vault } = await passkeyOnly();
    expect(await vault.state()).toBe('unlocked');
    expect(await vault.hasPassphrase()).toBe(false);
  });

  it('unlocks in a later session with the passkey', async () => {
    const { storage } = await passkeyOnly();
    const later = open(storage);
    expect(await later.state()).toBe('locked');
    expect(await later.unlockWithPasskey(key.credentialId, prf)).toHaveLength(1);
  });

  it('refuses to replace an existing vault', async () => {
    const { storage } = await passkeyOnly();
    await expect(open(storage).createWithPasskey(key, prf)).rejects.toThrow(/already/i);
  });

  it('won’t remove the last way in', async () => {
    const { storage, vault } = await passkeyOnly();
    await expect(vault.removePasskey(key.credentialId)).rejects.toThrow(/only way/i);
    expect(await open(storage).unlockWithPasskey(key.credentialId, prf)).toHaveLength(1);
  });

  it('can gain a passphrase later, keeping the passkey working', async () => {
    const { storage, vault } = await passkeyOnly();
    await vault.addPassphrase('a new passphrase');
    expect(await vault.hasPassphrase()).toBe(true);
    expect(await open(storage).unlock('a new passphrase')).toHaveLength(1);
    expect(await open(storage).unlockWithPasskey(key.credentialId, prf)).toHaveLength(1);
  });

  it('can then lose the passkey, as the passphrase remains', async () => {
    const { storage, vault } = await passkeyOnly();
    await vault.addPassphrase('a new passphrase');
    await vault.removePasskey(key.credentialId);
    expect(await open(storage).unlock('a new passphrase')).toHaveLength(1);
  });

  it('reports a passphrase on an ordinary vault, and none without a vault', async () => {
    const storage = memoryStorage();
    expect(await open(storage).hasPassphrase()).toBe(false);
    await open(storage).create(PASS);
    expect(await open(storage).hasPassphrase()).toBe(true);
  });

  it('accepts an 8-letter passphrase, and rejects 7', async () => {
    await expect(open(memoryStorage()).create('12345678')).resolves.toBeUndefined();
    await expect(open(memoryStorage()).create('1234567')).rejects.toThrow(/at least 8/);
  });
});

describe('SignatureVault', () => {
  it('starts with no vault, and is unlocked once created', async () => {
    const vault = open(memoryStorage());
    expect(await vault.state()).toBe('none');
    await vault.create(PASS);
    expect(await vault.state()).toBe('unlocked');
    expect(vault.list()).toEqual([]);
  });

  it('rejects a short passphrase without storing anything', async () => {
    const storage = memoryStorage();
    await expect(open(storage).create('short')).rejects.toThrow(/at least 8/);
    expect(storage.value).toBeNull();
  });

  it('refuses to replace an existing vault', async () => {
    const storage = memoryStorage();
    await open(storage).create(PASS);
    await expect(open(storage).create(PASS)).rejects.toThrow(/already/i);
  });

  it('saves both kinds of signature, and a later session unlocks them', async () => {
    const storage = memoryStorage();
    const first = open(storage);
    await first.create(PASS);
    const a = await first.add({ kind: 'ink', ink });
    const b = await first.add({ kind: 'image', png, width: 40, height: 20 });
    expect(a.id).not.toBe(b.id);

    const later = open(storage);
    expect(await later.state()).toBe('locked');
    const saved = await later.unlock(PASS);
    expect(saved).toEqual([a, b]);
    expect(saved[1].kind === 'image' && saved[1].png).toEqual(png);
    expect(await later.state()).toBe('unlocked');
  });

  it('never stores the signature in readable form', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    await vault.add({ kind: 'ink', ink: { ...ink, paths: ['M1.23456 7.89Z'] } });
    const stored = new TextDecoder('latin1').decode(storage.value!.ciphertext);
    expect(stored).not.toContain('1.23456');
    expect(JSON.stringify(storage.value)).not.toContain('1.23456');
  });

  it('fails cleanly on a wrong passphrase and stays locked', async () => {
    const storage = memoryStorage();
    await open(storage).create(PASS);
    const later = open(storage);
    await expect(later.unlock('the wrong passphrase')).rejects.toThrow(/wrong passphrase/i);
    expect(await later.state()).toBe('locked');
    expect(later.list()).toEqual([]);
  });

  it('forgets everything on lock, but the data stays stored', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    await vault.add({ kind: 'ink', ink });
    vault.lock();
    expect(await vault.state()).toBe('locked');
    expect(vault.list()).toEqual([]);
    await expect(vault.add({ kind: 'ink', ink })).rejects.toThrow(/locked/i);
    expect(await vault.unlock(PASS)).toHaveLength(1);
  });

  it('removes one signature', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    const a = await vault.add({ kind: 'ink', ink });
    const b = await vault.add({ kind: 'ink', ink });
    await vault.remove(a.id);
    expect(vault.list().map((s) => s.id)).toEqual([b.id]);
    expect((await open(storage).unlock(PASS)).map((s) => s.id)).toEqual([b.id]);
  });

  it('keeps what another tab saved', async () => {
    const storage = memoryStorage();
    const tabA = open(storage);
    await tabA.create(PASS);
    const tabB = open(storage);
    await tabB.unlock(PASS);
    await tabA.add({ kind: 'ink', ink });
    await tabB.add({ kind: 'image', png, width: 4, height: 2 });
    expect(await open(storage).unlock(PASS)).toHaveLength(2);
  });

  it('changes the passphrase: the old one stops working and the signatures stay', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    await vault.add({ kind: 'ink', ink });
    await vault.changePassphrase('a different passphrase');
    await expect(open(storage).unlock(PASS)).rejects.toThrow(/wrong passphrase/i);
    expect(await open(storage).unlock('a different passphrase')).toHaveLength(1);
  });

  it('after a passphrase change, a stolen older copy can’t open newer signatures', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    const stolen = structuredClone(storage.value!);
    await vault.changePassphrase('a different passphrase');
    await vault.add({ kind: 'ink', ink });
    // An attacker with the old passphrase and old copy tries it against today's contents.
    storage.value = { ...storage.value!, wraps: stolen.wraps };
    await expect(open(storage).unlock(PASS)).rejects.toThrow();
  });

  it('deletes the vault entirely', async () => {
    const storage = memoryStorage();
    const vault = open(storage);
    await vault.create(PASS);
    await vault.add({ kind: 'ink', ink });
    await vault.destroy();
    expect(storage.value).toBeNull();
    expect(await vault.state()).toBe('none');
    expect(vault.list()).toEqual([]);
  });
});
