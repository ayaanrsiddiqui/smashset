import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from './crypto.js';

describe('encrypt/decrypt', () => {
  it('round-trips a plaintext string', () => {
    const plaintext = 'a-real-looking-oauth-access-token-abc123';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('round-trips unicode content', () => {
    const plaintext = 'FireSlam23 🔥 Pyra/Mythra Ω';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV), even for the same plaintext', () => {
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    // ...but both still decrypt back to the same thing.
    expect(decrypt(a)).toBe('same-input');
    expect(decrypt(b)).toBe('same-input');
  });

  it('stores the payload as <iv>.<authTag>.<ciphertext>, each hex', () => {
    const payload = encrypt('token');
    const parts = payload.split('.');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
    expect(parts[0]).toHaveLength(24); // 12-byte IV -> 24 hex chars
    expect(parts[1]).toHaveLength(32); // 16-byte GCM auth tag -> 32 hex chars
  });

  it('rejects a payload whose ciphertext was tampered with', () => {
    const payload = encrypt('sensitive-token');
    const [iv, authTag, ciphertext] = payload.split('.');
    // Flip one hex character in the ciphertext — GCM's auth tag must fail to verify.
    const flipped = ciphertext[0] === '0' ? '1' : '0';
    const tampered = `${iv}.${authTag}.${flipped}${ciphertext.slice(1)}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a payload whose auth tag was tampered with', () => {
    const payload = encrypt('sensitive-token');
    const [iv, authTag, ciphertext] = payload.split('.');
    const flipped = authTag[0] === '0' ? '1' : '0';
    const tampered = `${iv}.${flipped}${authTag.slice(1)}.${ciphertext}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a malformed payload missing a segment', () => {
    expect(() => decrypt('only-one-segment')).toThrow('Malformed encrypted payload');
    expect(() => decrypt('two.segments')).toThrow('Malformed encrypted payload');
  });
});
