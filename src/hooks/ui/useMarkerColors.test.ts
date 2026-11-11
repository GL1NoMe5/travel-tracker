import { describe, expect, it } from 'vitest';
import { parseMarkerColors } from './useMarkerColors';

describe('marker color preferences', () => {
  it('accepts six-digit colors and canonicalizes only the expected fields', () => {
    expect(parseMarkerColors('{"visited":"#aBc123","wishlist":"#8655bf","extra":"ignored"}')).toEqual({
      visited: '#ABC123', wishlist: '#8655BF',
    });
  });

  it.each([
    null, '{broken', 'null', '[]', '"#ffffff"', '{}',
    '{"visited":"#abcdef"}',
    '{"visited":"#abc","wishlist":"#123456"}',
    '{"visited":"#abcdef","wishlist":"#12345678"}',
    '{"visited":"red","wishlist":"#123456"}',
    '{"visited":"#abcdef","wishlist":"url(https://example.com)"}',
    '{"visited":123456,"wishlist":"#123456"}',
    '{"visited":"#abcdef","wishlist":null}',
  ])('rejects malformed or incomplete preferences without inventing a partial value: %s', raw => {
    expect(parseMarkerColors(raw)).toBeNull();
  });
});
