import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scanBundle } from './compat-gate.mjs';
import {
  SHAKA_COMPAT_ALLOWLIST,
  prepareShakaWorker,
  validateShakaBundle,
} from './shaka-compat-gate.mjs';

const vendorBundle = () =>
  readFileSync('node_modules/shaka-player/dist/shaka-player.compiled.js', 'utf8');
const vendorWorker = () =>
  readFileSync('node_modules/shaka-player/dist/shaka-player.transmuxer-worker.js', 'utf8');

describe('Shaka Chromium 53 compatibility gate', () => {
  it('accepts the pinned Shaka bundle and its own guarded polyfills', () => {
    const bundle = vendorBundle();

    expect(() => validateShakaBundle(bundle)).not.toThrow();
    expect(bundle).toContain('Promise.prototype.finally');
    expect(bundle).toContain('String.prototype.trimStart');
    expect(scanBundle(bundle, { allowlist: SHAKA_COMPAT_ALLOWLIST })).toEqual([]);
  }, 15_000);

  it('fails when an unreviewed post-Chromium-53 API is added', () => {
    expect(() => validateShakaBundle(vendorBundle() + '\nPromise.any([]);'))
      .toThrow(/compatibility assumptions changed/);
  });

  it('rejects syntax that Chromium 53 cannot parse', () => {
    expect(() => validateShakaBundle(vendorBundle() + '\nconst modern = () => 1;'))
      .toThrow(/not valid ES5/);
  });

  it('rejects BigInt calls outside their availability guard', () => {
    const unguarded = vendorBundle().replace('"BigInt"in window&&', 'true&&');

    expect(() => validateShakaBundle(unguarded))
      .toThrow(/BigInt call is not controlled/);
  });

  it('gives the transmuxer worker the Map upsert the TV engine lacks', () => {
    const prepared = prepareShakaWorker(vendorWorker());
    const preamble = prepared.slice(0, prepared.indexOf('\n'));

    const result = runInNewContext(`
      delete Map.prototype.getOrInsertComputed;
      ${preamble}
      var map = new Map();
      [map.getOrInsertComputed('k', function () { return 1; }),
        map.getOrInsertComputed('k', function () { return 2; })];
    `);

    expect(Array.from(result)).toEqual([1, 1]);
  });

  it('fails when the transmuxer worker needs an unreviewed API', () => {
    expect(() => prepareShakaWorker(vendorWorker() + '\nnew Map().getOrInsert(1, 2);'))
      .toThrow(/compatibility assumptions changed in transmuxer worker/);
  });
});
