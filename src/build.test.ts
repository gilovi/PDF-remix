import { describe, expect, it } from 'vitest';
import { CSP, HEADERS } from '../vite.config';

describe('Content-Security-Policy', () => {
  it('forbids network access to any other origin', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("form-action 'none'");
    expect(CSP).not.toMatch(/https?:/);
    expect(CSP).not.toContain('*');
  });
});

describe('Cloudflare headers', () => {
  it('sends the same policy as a header, and adds what a meta tag can’t express', () => {
    expect(HEADERS).toContain(CSP);
    expect(HEADERS).toContain("frame-ancestors 'none'");
    expect(HEADERS).toContain('X-Content-Type-Options: nosniff');
    expect(HEADERS).toContain('Referrer-Policy: no-referrer');
  });

  it('lets only this page use passkeys', () => {
    expect(HEADERS).toContain('publickey-credentials-get=(self)');
    expect(HEADERS).toContain('publickey-credentials-create=(self)');
  });

  it('applies to every path', () => {
    expect(HEADERS.startsWith('/*\n')).toBe(true);
  });
});
