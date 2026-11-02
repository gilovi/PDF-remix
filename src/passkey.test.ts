import { describe, expect, it } from 'vitest';
import { passkeyLabel, passkeyProblem, providerFrom, usablePrf } from './passkey';

/** Authenticator data with the given AAGUID, laid out as WebAuthn defines it. */
function authData(aaguid: string): ArrayBuffer {
  const bytes = new Uint8Array(55);
  aaguid
    .replace(/-/g, '')
    .match(/../g)!
    .forEach((h, i) => (bytes[37 + i] = parseInt(h, 16)));
  return bytes.buffer;
}

describe('providerFrom', () => {
  it('recognises the providers the spike saw', () => {
    expect(providerFrom(authData('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4'))).toBe('Google Password Manager');
    expect(providerFrom(authData('9ddd1817-af5a-4672-a2b9-3e3dd95000a9'))).toBe('Windows Hello');
  });

  it('returns null for an unknown or hidden provider', () => {
    expect(providerFrom(authData('11111111-2222-3333-4444-555555555555'))).toBeNull();
    expect(providerFrom(authData('00000000-0000-0000-0000-000000000000'))).toBeNull();
  });

  it('returns null when the data is too short to hold one', () => {
    expect(providerFrom(new ArrayBuffer(10))).toBeNull();
  });
});

describe('passkeyLabel', () => {
  it('names a passkey after its provider, or generically', () => {
    expect(passkeyLabel('Windows Hello', [])).toBe('Windows Hello');
    expect(passkeyLabel(null, [])).toBe('Passkey');
  });

  it('keeps names distinct', () => {
    expect(passkeyLabel('Windows Hello', ['Windows Hello'])).toBe('Windows Hello 2');
    expect(passkeyLabel('Windows Hello', ['Windows Hello', 'Windows Hello 2'])).toBe('Windows Hello 3');
    expect(passkeyLabel(null, ['Passkey'])).toBe('Passkey 2');
  });
});

describe('usablePrf', () => {
  it('accepts 32 non-zero bytes, whatever the provider said at creation', () => {
    const bytes = new Uint8Array(32).fill(7);
    expect(usablePrf(bytes.buffer)).toEqual(bytes);
  });

  it('rejects missing, short and all-zero output', () => {
    expect(usablePrf(undefined)).toBeNull();
    expect(usablePrf(new ArrayBuffer(0))).toBeNull();
    expect(usablePrf(new Uint8Array(16).fill(7).buffer)).toBeNull();
    expect(usablePrf(new Uint8Array(32).buffer)).toBeNull();
  });
});

describe('passkeyProblem', () => {
  const named = (name: string) => new DOMException('x', name);

  it('tells a cancelled prompt from a passkey already registered', () => {
    expect(passkeyProblem(named('NotAllowedError'))).toBe('cancelled');
    expect(passkeyProblem(named('AbortError'))).toBe('cancelled');
    expect(passkeyProblem(named('InvalidStateError'))).toBe('duplicate');
  });

  it('treats everything else as a failure', () => {
    expect(passkeyProblem(named('SecurityError'))).toBe('failed');
    expect(passkeyProblem(new Error('x'))).toBe('failed');
  });
});
