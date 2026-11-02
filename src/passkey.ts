/**
 * Passkeys as a way to unlock the vault, using WebAuthn's PRF extension. There's no
 * server: the challenge means nothing here, and only the PRF output is used.
 *
 * `prf.enabled` isn't checked, because Chrome on Windows reports false for Windows
 * Hello and then returns stable bytes on unlock. What counts is the unlock itself
 * (see docs/plans/passkey-spike.md).
 */

export type PasskeyProblem = 'cancelled' | 'duplicate' | 'failed';

const AAGUID_START = 37;
const AAGUID_LENGTH = 16;
const PRF_BYTES = 32;

/** Only the providers the spike actually saw. Anything else gets a generic name. */
const PROVIDERS: Record<string, string> = {
  ea9b8d664d011d213ce4b6b48cb575d4: 'Google Password Manager',
  '9ddd1817af5a4672a2b93e3dd95000a9': 'Windows Hello',
};

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Which provider made a passkey, from the AAGUID in its authenticator data. */
export function providerFrom(authData: ArrayBuffer): string | null {
  const bytes = new Uint8Array(authData);
  if (bytes.length < AAGUID_START + AAGUID_LENGTH) return null;
  return PROVIDERS[toHex(bytes.subarray(AAGUID_START, AAGUID_START + AAGUID_LENGTH))] ?? null;
}

export function passkeyLabel(provider: string | null, existing: readonly string[]): string {
  const base = provider ?? 'Passkey';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** PRF output worth deriving a key from, or null. */
export function usablePrf(first: BufferSource | undefined): Uint8Array | null {
  if (!first) return null;
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return bytes.length === PRF_BYTES && bytes.some((b) => b !== 0) ? bytes : null;
}

export function passkeyProblem(err: unknown): PasskeyProblem {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  return name === 'InvalidStateError' ? 'duplicate' : 'failed';
}

// ---------- browser only ----------

const asBuffer = (bytes: Uint8Array) => bytes as unknown as BufferSource;

export const passkeysSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window;

/** Asks the browser to make a passkey. `exclude` stops a provider making a second one for this vault. */
export async function createPasskey(exclude: readonly Uint8Array[]): Promise<{ credentialId: Uint8Array; provider: string | null }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'PDF Remix' },
      user: { id: asBuffer(crypto.getRandomValues(new Uint8Array(16))), name: 'PDF Remix signatures', displayName: 'PDF Remix signatures' },
      challenge: asBuffer(crypto.getRandomValues(new Uint8Array(32))),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: exclude.map((id) => ({ type: 'public-key', id: asBuffer(id) })),
      attestation: 'none',
      extensions: { prf: {} },
    },
  })) as PublicKeyCredential;
  const response = credential.response as AuthenticatorAttestationResponse;
  return { credentialId: new Uint8Array(credential.rawId), provider: providerFrom(response.getAuthenticatorData()) };
}

/** Asks the passkey for its PRF output. Null if it gives nothing usable. */
export async function readPrf(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array | null> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: asBuffer(crypto.getRandomValues(new Uint8Array(32))),
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: asBuffer(credentialId) }],
      extensions: { prf: { eval: { first: asBuffer(prfSalt) } } },
    },
  })) as PublicKeyCredential;
  return usablePrf(credential.getClientExtensionResults().prf?.results?.first);
}
