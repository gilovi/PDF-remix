import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  addPasskeyWrap,
  changePassphrase,
  createVault,
  readContents,
  readJson,
  removePasskeyWrap,
  unlockWithPassphrase,
  unlockWithPrf,
  writeContents,
  writeJson,
  type Vault,
} from './vault';

const FAST = { iterations: 1000 };
const PASS = 'correct horse battery';
const enc = new TextEncoder();
const bytes = (...n: number[]) => new Uint8Array(n);
const prf = (seed: number) => new Uint8Array(32).fill(seed);
const credA = bytes(1, 2, 3, 4);
const credB = bytes(9, 8, 7);
const SECRET = enc.encode('SIGNATURE-PLAINTEXT-MARKER-0123456789');

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

async function expectVaultError(p: Promise<unknown>, code?: string): Promise<VaultError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(VaultError);
    expect((e as VaultError).message.length).toBeGreaterThan(5);
    if (code) expect((e as VaultError).code).toBe(code);
    return e as VaultError;
  }
  throw new Error('expected a VaultError, but the call succeeded');
}

async function withPasskeys(): Promise<Vault> {
  const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
  let v = await addPasskeyWrap(vault, unlocked, { credentialId: credA, prfSalt: bytes(5, 5), label: 'Hello' }, prf(1));
  v = await addPasskeyWrap(v, unlocked, { credentialId: credB, prfSalt: bytes(6, 6), label: 'Google' }, prf(2));
  return v;
}

describe('constants', () => {
  it('defaults to 600,000 PBKDF2 iterations and a 10 character minimum', async () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(600_000);
    expect(MIN_PASSPHRASE_LENGTH).toBe(10);
  });
});

describe('createVault', () => {
  it('rejects a short passphrase with a readable error', async () => {
    const e = await expectVaultError(createVault('123456789', SECRET, FAST), 'weak-passphrase');
    expect(e.message).toMatch(/10/);
  });

  it('accepts exactly 10 characters', async () => {
    await expect(createVault('1234567890', SECRET, FAST)).resolves.toBeDefined();
  });

  it('stores a passphrase wrap with the default iteration count when none is given', async () => {
    const { vault } = await createVault(PASS, SECRET);
    const w = vault.wraps[0];
    expect(w.kind).toBe('passphrase');
    if (w.kind === 'passphrase') {
      expect(w.iterations).toBe(600_000);
      expect(w.salt.length).toBeGreaterThanOrEqual(16);
    }
  });

  it('derives the wrapping key with PBKDF2-SHA-256 using the stored salt and iterations', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, { iterations: 1234 });
    const w = vault.wraps[0];
    if (w.kind !== 'passphrase') throw new Error('expected passphrase wrap');
    expect(w.iterations).toBe(1234);
    const base = await crypto.subtle.importKey('raw', enc.encode(PASS), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: w.salt as BufferSource, iterations: 1234 },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    // Independent derivation must open the wrap. The additional data is part of the format.
    const aad = enc.encode('pdf-remix-vault/v1/wrap/passphrase/1234');
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: w.iv as BufferSource, additionalData: aad },
      key,
      w.wrapped as BufferSource,
    );
    expect(raw.byteLength).toBe(32);
    const exported = await crypto.subtle.exportKey('raw', unlocked.dataKey);
    expect(new Uint8Array(raw)).toEqual(new Uint8Array(exported));
  });

  it('uses a random salt per vault', async () => {
    const a = (await createVault(PASS, SECRET, FAST)).vault.wraps[0];
    const b = (await createVault(PASS, SECRET, FAST)).vault.wraps[0];
    if (a.kind !== 'passphrase' || b.kind !== 'passphrase') throw new Error();
    expect(a.salt).not.toEqual(b.salt);
  });

  it('produces a structured-cloneable plain object', async () => {
    const v = await withPasskeys();
    const clone = structuredClone(v);
    expect(clone).toEqual(v);
    const u = await unlockWithPassphrase(clone, PASS);
    expect(await readContents(clone, u)).toEqual(SECRET);
  });
});

describe('encryption', () => {
  it('never contains the plaintext anywhere in the stored vault', async () => {
    const v = await withPasskeys();
    const all = [v.ciphertext, v.iv, ...v.wraps.flatMap((w) => [w.iv, w.wrapped])];
    for (const part of all) expect(contains(part, SECRET)).toBe(false);
    expect(JSON.stringify(v, (_k, val) => (val instanceof Uint8Array ? Array.from(val) : val))).not.toContain('MARKER');
  });

  it('round-trips bytes and JSON', async () => {
    const { vault, unlocked } = await createVault(PASS, bytes(0, 255, 7), FAST);
    expect(await readContents(vault, unlocked)).toEqual(bytes(0, 255, 7));
    const data = { sigs: [{ d: 'M0 0L1 1', color: '#000' }], n: 2 };
    const v2 = await writeJson(vault, unlocked, data);
    expect(await readJson(v2, unlocked)).toEqual(data);
  });

  it('uses a fresh IV on every write', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const ivs = new Set<string>([vault.iv.join(',')]);
    let v = vault;
    for (let i = 0; i < 20; i++) {
      v = await writeContents(v, unlocked, SECRET);
      ivs.add(v.iv.join(','));
    }
    expect(ivs.size).toBe(21);
    expect(v.iv.length).toBe(12);
  });

  it('writing the same contents twice gives different ciphertext', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const v2 = await writeContents(vault, unlocked, SECRET);
    expect(v2.ciphertext).not.toEqual(vault.ciphertext);
  });

  it('does not mutate the vault passed to writeContents', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const before = structuredClone(vault);
    await writeContents(vault, unlocked, bytes(1));
    expect(vault).toEqual(before);
  });

  it('keeps the wraps working after a write', async () => {
    const v = await withPasskeys();
    const u = await unlockWithPassphrase(v, PASS);
    const v2 = await writeContents(v, u, bytes(4, 5, 6));
    const u2 = await unlockWithPrf(v2, credB, prf(2));
    expect(await readContents(v2, u2)).toEqual(bytes(4, 5, 6));
  });
});

describe('unlocking', () => {
  it('rejects a wrong passphrase cleanly and returns no data', async () => {
    const { vault } = await createVault(PASS, SECRET, FAST);
    const e = await expectVaultError(unlockWithPassphrase(vault, 'not the passphrase'), 'wrong-credentials');
    expect(e.message).toMatch(/passphrase/i);
  });

  it('rejects wrong PRF bytes cleanly and returns no data', async () => {
    const v = await withPasskeys();
    await expectVaultError(unlockWithPrf(v, credA, prf(99)), 'wrong-credentials');
  });

  it('rejects an unknown credential id', async () => {
    const v = await withPasskeys();
    await expectVaultError(unlockWithPrf(v, bytes(0, 0), prf(1)), 'no-such-wrap');
  });

  it('every wrap unlocks the same data', async () => {
    const v = await withPasskeys();
    const viaPass = await readContents(v, await unlockWithPassphrase(v, PASS));
    const viaA = await readContents(v, await unlockWithPrf(v, credA, prf(1)));
    const viaB = await readContents(v, await unlockWithPrf(v, credB, prf(2)));
    expect(viaPass).toEqual(SECRET);
    expect(viaA).toEqual(SECRET);
    expect(viaB).toEqual(SECRET);
  });

  it('does not accept one passkey PRF for another passkey', async () => {
    const v = await withPasskeys();
    await expectVaultError(unlockWithPrf(v, credA, prf(2)), 'wrong-credentials');
  });

  it('leaves the vault unchanged after a failed unlock', async () => {
    const v = await withPasskeys();
    const before = structuredClone(v);
    await expectVaultError(unlockWithPassphrase(v, 'wrong wrong wrong'));
    await expectVaultError(unlockWithPrf(v, credA, prf(77)));
    await expectVaultError(unlockWithPrf(v, bytes(0), prf(1)));
    expect(v).toEqual(before);
  });

  it('leaves the vault unchanged after a successful unlock', async () => {
    const v = await withPasskeys();
    const before = structuredClone(v);
    await unlockWithPassphrase(v, PASS);
    await unlockWithPrf(v, credA, prf(1));
    expect(v).toEqual(before);
  });
});

describe('passkey wraps', () => {
  it('stores credential id, salt, label, iv and wrapped key', async () => {
    const v = await withPasskeys();
    const w = v.wraps.find((x) => x.kind === 'passkey');
    if (!w || w.kind !== 'passkey') throw new Error('missing');
    expect(w.credentialId).toEqual(credA);
    expect(w.prfSalt).toEqual(bytes(5, 5));
    expect(w.label).toBe('Hello');
    expect(w.iv.length).toBe(12);
    expect(w.wrapped.length).toBe(32 + 16);
  });

  it('removing a passkey leaves the passphrase and other passkeys working', async () => {
    const v = await withPasskeys();
    const v2 = removePasskeyWrap(v, credA);
    expect(v2.wraps.filter((w) => w.kind === 'passkey')).toHaveLength(1);
    await expectVaultError(unlockWithPrf(v2, credA, prf(1)), 'no-such-wrap');
    expect(await readContents(v2, await unlockWithPassphrase(v2, PASS))).toEqual(SECRET);
    expect(await readContents(v2, await unlockWithPrf(v2, credB, prf(2)))).toEqual(SECRET);
    // original untouched
    expect(v.wraps).toHaveLength(3);
  });

  it('refuses to remove a wrap that does not exist', async () => {
    const v = await withPasskeys();
    expect(() => removePasskeyWrap(v, bytes(42))).toThrow(VaultError);
  });

  it('the passphrase wrap can never be removed', async () => {
    const v = await withPasskeys();
    const every = v.wraps.filter((w) => w.kind === 'passkey').map((w) => (w as { credentialId: Uint8Array }).credentialId);
    let cur = v;
    for (const id of every) cur = removePasskeyWrap(cur, id);
    expect(cur.wraps).toHaveLength(1);
    expect(cur.wraps[0].kind).toBe('passphrase');
    // there is no way to name the passphrase wrap
    expect(() => removePasskeyWrap(cur, new Uint8Array(0))).toThrow(VaultError);
    expect(await readContents(cur, await unlockWithPassphrase(cur, PASS))).toEqual(SECRET);
  });

  it('rejects adding the same credential twice', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const v = await addPasskeyWrap(vault, unlocked, { credentialId: credA, prfSalt: bytes(1), label: 'x' }, prf(1));
    await expectVaultError(
      addPasskeyWrap(v, unlocked, { credentialId: credA, prfSalt: bytes(1), label: 'y' }, prf(1)),
      'duplicate-wrap',
    );
  });

  it('rejects empty PRF output', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    await expectVaultError(
      addPasskeyWrap(vault, unlocked, { credentialId: credA, prfSalt: bytes(1), label: 'x' }, new Uint8Array(0)),
    );
  });

  it('renaming does not break the wrap (label is not bound)', async () => {
    const v = await withPasskeys();
    const renamed: Vault = {
      ...v,
      wraps: v.wraps.map((w) => (w.kind === 'passkey' ? { ...w, label: 'Renamed' } : w)),
    };
    expect(await readContents(renamed, await unlockWithPrf(renamed, credA, prf(1)))).toEqual(SECRET);
  });
});

describe('changePassphrase', () => {
  it('replaces the passphrase, keeps contents and passkeys, uses a new salt', async () => {
    const v = await withPasskeys();
    const u = await unlockWithPassphrase(v, PASS);
    const v2 = await changePassphrase(v, u, 'a brand new passphrase', FAST);
    await expectVaultError(unlockWithPassphrase(v2, PASS), 'wrong-credentials');
    expect(await readContents(v2, await unlockWithPassphrase(v2, 'a brand new passphrase'))).toEqual(SECRET);
    expect(await readContents(v2, await unlockWithPrf(v2, credA, prf(1)))).toEqual(SECRET);
    const o = v.wraps[0];
    const n = v2.wraps[0];
    if (o.kind !== 'passphrase' || n.kind !== 'passphrase') throw new Error();
    expect(n.salt).not.toEqual(o.salt);
    expect(v2.wraps.filter((w) => w.kind === 'passphrase')).toHaveLength(1);
  });

  it('can raise the iteration count', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const v2 = await changePassphrase(vault, unlocked, PASS, { iterations: 2000 });
    const w = v2.wraps[0];
    if (w.kind !== 'passphrase') throw new Error();
    expect(w.iterations).toBe(2000);
    expect(await readContents(v2, await unlockWithPassphrase(v2, PASS))).toEqual(SECRET);
  });

  it('rejects a short new passphrase and leaves the vault unchanged', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const before = structuredClone(vault);
    await expectVaultError(changePassphrase(vault, unlocked, 'short', FAST), 'weak-passphrase');
    expect(vault).toEqual(before);
  });
});

describe('tampering', () => {
  it('fails when the ciphertext is modified', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const ct = vault.ciphertext.slice();
    ct[0] ^= 1;
    await expectVaultError(readContents({ ...vault, ciphertext: ct }, unlocked), 'corrupt');
  });

  it('fails when the contents iv is modified', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const iv = vault.iv.slice();
    iv[0] ^= 1;
    await expectVaultError(readContents({ ...vault, iv }, unlocked), 'corrupt');
  });

  it('fails when a passphrase wrap is modified', async () => {
    const { vault } = await createVault(PASS, SECRET, FAST);
    const w = vault.wraps[0];
    if (w.kind !== 'passphrase') throw new Error();
    const wrapped = w.wrapped.slice();
    wrapped[3] ^= 1;
    await expectVaultError(unlockWithPassphrase({ ...vault, wraps: [{ ...w, wrapped }] }, PASS), 'wrong-credentials');
  });

  it('fails when the stored iteration count is altered', async () => {
    const { vault } = await createVault(PASS, SECRET, FAST);
    const w = vault.wraps[0];
    if (w.kind !== 'passphrase') throw new Error();
    await expectVaultError(
      unlockWithPassphrase({ ...vault, wraps: [{ ...w, iterations: w.iterations + 1 }] }, PASS),
      'wrong-credentials',
    );
  });

  it('fails when a passkey wrap is modified', async () => {
    const v = await withPasskeys();
    const bad: Vault = {
      ...v,
      wraps: v.wraps.map((w) => {
        if (w.kind !== 'passkey' || w.label !== 'Hello') return w;
        const wrapped = w.wrapped.slice();
        wrapped[0] ^= 1;
        return { ...w, wrapped };
      }),
    };
    await expectVaultError(unlockWithPrf(bad, credA, prf(1)), 'wrong-credentials');
  });

  it('a wrap cannot be swapped to another credential id', async () => {
    const v = await withPasskeys();
    const swapped: Vault = {
      ...v,
      wraps: v.wraps.map((w) => (w.kind === 'passkey' && w.label === 'Hello' ? { ...w, credentialId: bytes(7, 7) } : w)),
    };
    // Same PRF bytes that legitimately open credential A must not open the relabelled wrap.
    await expectVaultError(unlockWithPrf(swapped, bytes(7, 7), prf(1)), 'wrong-credentials');
  });

  it('a wrap cannot be moved between methods (passkey wrap presented as passphrase)', async () => {
    const { vault, unlocked } = await createVault(PASS, SECRET, FAST);
    const v = await addPasskeyWrap(vault, unlocked, { credentialId: credA, prfSalt: bytes(1), label: 'x' }, prf(1));
    const pk = v.wraps[1];
    const pw = v.wraps[0];
    if (pk.kind !== 'passkey' || pw.kind !== 'passphrase') throw new Error();
    const forged: Vault = {
      ...v,
      wraps: [{ kind: 'passphrase', salt: pw.salt, iterations: pw.iterations, iv: pk.iv, wrapped: pk.wrapped }],
    };
    await expectVaultError(unlockWithPassphrase(forged, PASS), 'wrong-credentials');
  });

  it('rejects a vault with no passphrase wrap', async () => {
    const v = await withPasskeys();
    const noPass: Vault = { ...v, wraps: v.wraps.filter((w) => w.kind !== 'passphrase') };
    await expectVaultError(unlockWithPassphrase(noPass, PASS), 'corrupt');
  });

  it('rejects an unsupported version', async () => {
    const { vault } = await createVault(PASS, SECRET, FAST);
    await expectVaultError(unlockWithPassphrase({ ...vault, version: 2 as 1 }, PASS), 'corrupt');
  });
});
