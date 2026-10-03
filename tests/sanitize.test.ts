import { describe, it, expect } from 'vitest';
import { redactText } from '../src/security/sanitize';

describe('secret redaction', () => {
  it('redacts OpenAI-style API keys', () => {
    const { text, redactions } = redactText('use key sk-abcdefghij1234567890XYZ in the header');
    expect(redactions).toBe(1);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('sk-abcdefghij1234567890XYZ');
  });

  it('redacts JWTs and bearer tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    expect(redactText(`token: ${jwt}`).redactions).toBeGreaterThan(0);
    expect(redactText('Authorization: Bearer abcdef1234567890abcdef').redactions).toBe(1);
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    expect(redactText(pem).redactions).toBe(1);
  });

  it('leaves ordinary text untouched', () => {
    const { text, redactions } = redactText('We decided to use PostgreSQL for the main database.');
    expect(redactions).toBe(0);
    expect(text).toContain('PostgreSQL');
  });
});
