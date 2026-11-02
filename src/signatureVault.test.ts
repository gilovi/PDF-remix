import { describe, expect, it } from 'vitest';
import { SignatureVault, canUseVault, type VaultStorage } from './signatureVault';
import type { Vault } from './vault';

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
    await expect(open(storage).create('short')).rejects.toThrow(/at least 10/);
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
