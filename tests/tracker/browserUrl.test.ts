import { describe, it, expect, vi } from 'vitest';
import {
  getActiveBrowserDomain,
  getDomain,
  isInternalPage,
  isSupportedBrowser,
  normalizeBrowserName,
} from '../../src/tracker/browserUrl.js';

describe('normalizeBrowserName', () => {
  it('maps active-win owner names to canonical browser names', () => {
    expect(normalizeBrowserName('Google Chrome')).toBe('Chrome');
    expect(normalizeBrowserName('Chrome')).toBe('Chrome');
    expect(normalizeBrowserName('Brave')).toBe('Brave');
    expect(normalizeBrowserName('Microsoft Edge')).toBe('Edge');
    expect(normalizeBrowserName('Firefox')).toBe('Firefox');
  });

  it('returns undefined for non-browser apps', () => {
    expect(normalizeBrowserName('Visual Studio Code')).toBeUndefined();
    expect(normalizeBrowserName('Spotify')).toBeUndefined();
  });
});

describe('isSupportedBrowser', () => {
  it('accepts known browsers', () => {
    expect(isSupportedBrowser('Google Chrome')).toBe(true);
    expect(isSupportedBrowser('Brave')).toBe(true);
  });

  it('rejects other apps', () => {
    expect(isSupportedBrowser('Code.exe')).toBe(false);
  });
});

describe('getDomain', () => {
  it('extracts hostname from a full URL', () => {
    expect(getDomain('https://www.example.com/path?q=1')).toBe('example.com');
  });

  it('strips www', () => {
    expect(getDomain('https://www.github.com')).toBe('github.com');
  });

  it('adds a scheme for bare hosts', () => {
    expect(getDomain('example.com')).toBe('example.com');
  });

  it('falls back to a regex on malformed input', () => {
    expect(getDomain('not a url')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(getDomain('')).toBeNull();
  });
});

describe('isInternalPage', () => {
  it('detects browser-internal schemes', () => {
    expect(isInternalPage('chrome://newtab/')).toBe(true);
    expect(isInternalPage('brave://settings/')).toBe(true);
    expect(isInternalPage('edge://flags/')).toBe(true);
    expect(isInternalPage('about:blank')).toBe(true);
  });

  it('allows normal web pages', () => {
    expect(isInternalPage('https://example.com')).toBe(false);
  });
});

describe('getActiveBrowserDomain', () => {
  it('returns null for unsupported apps', () => {
    const getUrl = vi.fn().mockReturnValue('https://example.com');
    expect(getActiveBrowserDomain(12345, 'Visual Studio Code', getUrl)).toBeNull();
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('returns null when the native helper returns null', () => {
    const getUrl = vi.fn().mockReturnValue(null);
    expect(getActiveBrowserDomain(12345, 'Google Chrome', getUrl)).toBeNull();
  });

  it('returns the domain when the native helper returns a URL', () => {
    const getUrl = vi.fn().mockReturnValue('https://www.example.com/path');
    expect(getActiveBrowserDomain(12345, 'Google Chrome', getUrl)).toBe('example.com');
  });

  it('returns null for internal browser pages', () => {
    const getUrl = vi.fn().mockReturnValue('chrome://newtab/');
    expect(getActiveBrowserDomain(12345, 'Google Chrome', getUrl)).toBeNull();
  });

  it('survives native helper exceptions', () => {
    const getUrl = vi.fn().mockImplementation(() => {
      throw new Error('UIA not available');
    });
    expect(getActiveBrowserDomain(12345, 'Google Chrome', getUrl)).toBeNull();
  });
});
