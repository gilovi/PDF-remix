import { describe, expect, it } from 'vitest';
import { CSP } from '../vite.config';

describe('Content-Security-Policy', () => {
  it('forbids network access to any other origin', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("form-action 'none'");
    expect(CSP).not.toMatch(/https?:/);
    expect(CSP).not.toContain('*');
  });
});
