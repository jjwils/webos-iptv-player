// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { afterEach, describe, expect, it } from 'vitest';
import { patchMpegts } from './mpegts-patch.mjs';

const vendorBundle = () => readFileSync('node_modules/mpegts.js/dist/mpegts.js', 'utf8');

function loadMpegts(code) {
  const module = { exports: {} };
  new Function('module', 'exports', 'define', code)(module, module.exports, undefined);
  module.exports.LoggingControl.enableAll = false;
  return module.exports;
}

function packets(pid, data) {
  const out = [];
  for (let offset = 0, first = true; offset < data.length; first = false) {
    const chunk = data.slice(offset, offset + 184);
    offset += chunk.length;
    const header = [0x47, (first ? 0x40 : 0) | (pid >> 8), pid & 0xff];
    if (chunk.length === 184) {
      out.push(...header, 0x10, ...chunk);
    } else {
      const stuffing = 183 - chunk.length;
      out.push(...header, 0x30, stuffing, ...(stuffing ? [0x00, ...Array(stuffing - 1).fill(0xff)] : []), ...chunk);
    }
  }
  return out;
}

function section(tableId, body) {
  const length = body.length + 4;
  return [0, tableId, 0xb0 | (length >> 8), length & 0xff, ...body, 0, 0, 0, 0];
}

function pes(pts, payload) {
  const length = payload.length + 8;
  return [0, 0, 1, 0xbd, length >> 8, length & 0xff, 0x80, 0x80, 5,
    0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1), Math.floor(pts / 2 ** 22) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1, Math.floor(pts / 2 ** 7) & 0xff,
    ((pts & 0x7f) << 1) | 1, ...payload];
}

// 48 kHz, six blocks, 3/2 + LFE, bsid 16.
function eac3Frame(bytes, dependent) {
  const words = bytes / 2 - 1;
  const frame = new Array(bytes).fill(0);
  frame.splice(0, 6, 0x0b, 0x77, (dependent ? 0x40 : 0) | (words >> 8), words & 0xff, 0x3f, 0x80);
  return frame;
}

function dvbEac3Pes(payloads) {
  const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]);
  const pmt = section(0x02, [0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, 0,
    0x06, 0xe1, 0x01, 0xf0, 3, 0x7a, 1, 0x00]);
  const out = [...packets(0, pat), ...packets(0x1000, pmt)];
  payloads.forEach((payload, i) => out.push(...packets(0x101, pes(90000 + i * 2880 * 2, payload))));
  return new Uint8Array([...out, ...packets(0, pat)]);
}

function mediaSamples(appended) {
  let count = 0;
  let bytes = 0;
  for (const segment of appended) {
    const trun = box(segment, 'trun');
    if (!trun) continue;
    count += (trun[4] << 24) | (trun[5] << 16) | (trun[6] << 8) | trun[7];
    bytes += box(segment, 'mdat').length;
  }
  return { count, bytes };
}

function dvbEac3Stream(frames) {
  const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]);
  const pmt = section(0x02, [0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, 0,
    0x06, 0xe1, 0x01, 0xf0, 3, 0x7a, 1, 0x00]);
  const audio = [];
  for (let i = 0; i < frames; i++) audio.push(...eac3Frame(512, false), ...eac3Frame(256, true));
  return new Uint8Array([...packets(0, pat), ...packets(0x1000, pmt), ...packets(0x101, pes(90000, audio)),
    ...packets(0, pat)]);
}

function box(bytes, type) {
  const name = [...type].map(c => c.charCodeAt(0));
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (name.every((c, j) => bytes[i + j] === c)) return bytes.subarray(i + 4);
  }
  return null;
}

class FakeSourceBuffer extends EventTarget {
  constructor(mime) {
    super();
    this.mime = mime;
    this.appended = [];
    this.updating = false;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.timestampOffset = 0;
  }

  appendBuffer(data) {
    this.appended.push(new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
    this.updating = true;
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    });
  }

  abort() {}
  remove() {}
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported() { return true; }

  constructor() {
    super();
    this.readyState = 'closed';
    this.duration = NaN;
    this.sourceBuffers = [];
    FakeMediaSource.last = this;
  }

  addSourceBuffer(mime) {
    const sb = new FakeSourceBuffer(mime);
    this.sourceBuffers.push(sb);
    return sb;
  }

  removeSourceBuffer() {}
  endOfStream() {}
}

async function transmux(mpegts, bytes) {
  window.MediaSource = FakeMediaSource;
  URL.createObjectURL = () => {
    setTimeout(() => {
      FakeMediaSource.last.readyState = 'open';
      FakeMediaSource.last.dispatchEvent(new Event('sourceopen'));
    });
    return 'blob:test';
  };
  class Loader extends mpegts.BaseLoader {
    static isSupported() { return true; }
    constructor() { super('test-loader'); }
    open() {
      this._status = mpegts.LoaderStatus.kBuffering;
      setTimeout(() => {
        this._onDataArrival(bytes.buffer, 0, bytes.length);
        this._status = mpegts.LoaderStatus.kComplete;
        this._onComplete?.(0, bytes.length - 1);
      });
    }
    abort() { this._status = mpegts.LoaderStatus.kIdle; }
  }
  const video = document.createElement('video');
  video.load = () => {};
  video.play = () => Promise.resolve();
  const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: 'http://host/a.ts' },
    { customLoader: Loader, enableStashBuffer: false });
  player.attachMediaElement(video);
  player.load();
  await new Promise(resolve => setTimeout(resolve, 200));
  const buffers = FakeMediaSource.last.sourceBuffers;
  player.destroy();
  return buffers;
}

afterEach(() => {
  delete window.MediaSource;
});

describe('patchMpegts', () => {
  it('produces an ES5 bundle', () => {
    expect(() => parse(patchMpegts(vendorBundle()), { ecmaVersion: 5, sourceType: 'script' }))
      .not.toThrow();
  });

  it('fails when a patch no longer matches the bundle', () => {
    expect(() => patchMpegts(vendorBundle().replace('i=1536/s.sampling_frequency*1e3;var _={codec:"ec-3"', 'i=1536/s.rate*1e3;var _={codec:"ec-3"')))
      .toThrow(/E-AC-3 sample duration/);
  });

  it('plays DVB E-AC-3 audio with a valid dec3 box and one sample per frame', async () => {
    const buffers = await transmux(loadMpegts(patchMpegts(vendorBundle())), dvbEac3Stream(4));

    expect(buffers.map(sb => sb.mime)).toEqual(['audio/mp4;codecs=ec-3']);
    const [init, ...segments] = buffers[0].appended;
    // 768-byte access units every 32 ms: 192 kbit/s, fscod 0, bsid 16, acmod 7, LFE on.
    expect([...box(init, 'dec3').subarray(0, 5)]).toEqual([0x06, 0x00, 0x20, 0x0f, 0x00]);
    expect(segments.length).toBeGreaterThan(0);
    const trun = box(segments[0], 'trun');
    const sampleCount = (trun[4] << 24) | (trun[5] << 16) | (trun[6] << 8) | trun[7];
    const mdat = box(segments[0], 'mdat');
    expect(mdat.length).toBe(sampleCount * 768);
  });

  it('skips a dependent substream that a PES boundary cut off from its frame', async () => {
    const independent = () => eac3Frame(512, false);
    const dependent = () => eac3Frame(256, true);
    const stream = dvbEac3Pes([
      [...independent(), ...dependent(), ...independent()],
      [...dependent(), ...independent(), ...dependent()],
    ]);
    const buffers = await transmux(loadMpegts(patchMpegts(vendorBundle())), stream);

    expect(mediaSamples(buffers[0].appended.slice(1))).toEqual({ count: 3, bytes: 768 + 512 + 768 });
  });

  it('drops DVB E-AC-3 audio without the patches', async () => {
    const buffers = await transmux(loadMpegts(vendorBundle()), dvbEac3Stream(4));
    expect(buffers).toEqual([]);
  });
});
