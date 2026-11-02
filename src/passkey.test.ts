import { describe, expect, it } from 'vitest';
import { passkeyName, passkeyProblem, usablePrf } from './passkey';

describe('passkeyName', () => {
  it('needs no number when there is only one', () => {
    expect(passkeyName(0, 1)).toBe('Passkey');
  });

  it('numbers them when there are several', () => {
    expect(passkeyName(0, 2)).toBe('Passkey 1');
    expect(passkeyName(1, 2)).toBe('Passkey 2');
  });
});

describe('usablePrf', () => {
  it('accepts 32 non-zero bytes', () => {
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
