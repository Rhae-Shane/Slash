import { createUrlSchema, shortCodeParamSchema } from './urls.schema';

describe('createUrlSchema', () => {
  it('accepts a valid http(s) URL', () => {
    const result = createUrlSchema.parse({
      longUrl: 'https://example.com/x',
    });
    expect(result.longUrl).toBe('https://example.com/x');
    expect(result.expiresAt).toBeUndefined();
  });

  it('trims longUrl', () => {
    const result = createUrlSchema.parse({
      longUrl: '  https://example.com  ',
    });
    expect(result.longUrl).toBe('https://example.com');
  });

  it('rejects non-http(s) protocols', () => {
    expect(() =>
      createUrlSchema.parse({ longUrl: 'javascript:alert(1)' }),
    ).toThrow();
  });

  it('rejects oversized longUrl', () => {
    expect(() =>
      createUrlSchema.parse({ longUrl: `https://x.com/${'a'.repeat(2100)}` }),
    ).toThrow(/at most 2048/i);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      createUrlSchema.parse({ longUrl: 'https://example.com', extra: true }),
    ).toThrow();
  });

  it('accepts future expiresAt', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = createUrlSchema.parse({
      longUrl: 'https://example.com',
      expiresAt,
    });
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('rejects past expiresAt', () => {
    expect(() =>
      createUrlSchema.parse({
        longUrl: 'https://example.com',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow(/future/i);
  });
});

describe('shortCodeParamSchema', () => {
  it('accepts Base62 short codes', () => {
    expect(shortCodeParamSchema.parse({ shortCode: 'AbC1230' }).shortCode).toBe(
      'AbC1230',
    );
  });

  it('rejects non-Base62 characters', () => {
    expect(() =>
      shortCodeParamSchema.parse({ shortCode: 'abc_def' }),
    ).toThrow(/Base62/i);
  });

  it('rejects codes longer than 16 chars', () => {
    expect(() =>
      shortCodeParamSchema.parse({ shortCode: 'a'.repeat(17) }),
    ).toThrow(/at most 16/i);
  });
});
