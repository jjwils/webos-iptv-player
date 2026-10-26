import { describe, expect, it } from 'vitest';
import { frameRateFromPts, hevcSpsTransfer, parseTsInfo } from './ts-info';

class BitWriter {
  private bits: number[] = [];

  u(n: number, value: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  ue(value: number): this {
    const code = value + 1;
    const length = Math.floor(Math.log2(code));
    this.u(length, 0);
    return this.u(length + 1, code);
  }

  bytes(): number[] {
    const bits = [...this.bits, 1];
    while (bits.length % 8) bits.push(0);
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      out.push(bits.slice(i, i + 8).reduce((byte, bit) => byte * 2 + bit, 0));
    }
    return out;
  }
}

function escape(rbsp: number[]): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

function hevcSps(transfer: number): number[] {
  const w = new BitWriter()
    .u(4, 0).u(3, 0).u(1, 1)
    .u(32, 0x01600000).u(32, 0).u(32, 0x00000099) // profile_tier_level, level 153
    .ue(0).ue(1).ue(3840).ue(2160).u(1, 0)
    .ue(2).ue(2).ue(4)
    .u(1, 1).ue(4).ue(0).ue(0)
    .ue(0).ue(3).ue(0).ue(3).ue(0).ue(0)
    .u(1, 0).u(1, 0).u(1, 1).u(1, 0)
    .ue(2)
    .ue(1).ue(0).ue(0).u(1, 1) // set 0: one negative picture
    .u(1, 1).u(1, 0).ue(0).u(1, 1).u(1, 0).u(1, 0) // set 1: predicted from set 0
    .u(1, 0).u(1, 1).u(1, 1)
    .u(1, 1) // vui_parameters_present_flag
    .u(1, 1).u(8, 1)
    .u(1, 0)
    .u(1, 1).u(3, 5).u(1, 0).u(1, 1).u(8, 9).u(8, transfer).u(8, 9);
  return [0x42, 0x01, ...escape(w.bytes())];
}

const startCode = (nal: number[]) => [0, 0, 0, 1, ...nal];
const SEI_PREFERRED_HLG = [0x4e, 0x01, 147, 1, 18, 0x80];
const DOLBY_VISION_RPU = [0x7c, 0x01, 0x08, 0x09];

function ptsBytes(pts: number): number[] {
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1),
    (Math.floor(pts / 2 ** 22)) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
    (Math.floor(pts / 2 ** 7)) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ];
}

function pes(streamId: number, pts: number, payload: number[]): number[] {
  return [0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5, ...ptsBytes(pts), ...payload];
}

function packets(pid: number, data: number[]): number[] {
  const out: number[] = [];
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

function section(tableId: number, body: number[]): number[] {
  const length = body.length + 4;
  return [0, tableId, 0xb0 | (length >> 8), length & 0xff, ...body, 0, 0, 0, 0];
}

interface Stream { type: number; pid: number; descriptor?: number }

function segment(streams: Stream[], videoPes: number[][], audioFrame: number[] | null): Uint8Array {
  const pat = section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | 0x10, 0x00]);
  const es: number[] = [];
  for (const stream of streams) {
    const descriptors = stream.descriptor ? [stream.descriptor, 1, 0] : [];
    es.push(stream.type, 0xe0 | (stream.pid >> 8), stream.pid & 0xff, 0xf0, descriptors.length, ...descriptors);
  }
  const pmt = section(0x02, [0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0, ...es]);
  const out = [...packets(0, pat), ...packets(0x1000, pmt)];
  if (audioFrame) out.push(...packets(0x101, pes(0xc0, 0, audioFrame)));
  for (const frame of videoPes) out.push(...packets(0x100, frame));
  return new Uint8Array(out);
}

// Decode order for an IBBP GOP at 50 fps: display slots 0,3,1,2,6,4,5,…
function videoFrames(firstPayload: number[], count = 12): number[][] {
  const order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11, 15, 13, 14];
  return order.slice(0, count).map((slot, index) =>
    pes(0xe0, 900000 + slot * 1800, index === 0 ? firstPayload : [0, 0, 1, 0x02, 0x01, 0xaa]));
}

const EAC3_5_1 = [0x0b, 0x77, 0x00, 0x00, 0x3f, 0x80, 0x00, 0x00];
const HEVC_EAC3: Stream[] = [{ type: 0x24, pid: 0x100 }, { type: 0x06, pid: 0x101, descriptor: 0x7a }];

describe('parseTsInfo', () => {
  it('reads HEVC HDR10, the display frame rate, and E-AC-3 5.1 from a DVB segment', () => {
    const info = parseTsInfo(segment(HEVC_EAC3, videoFrames(startCode(hevcSps(16))), EAC3_5_1));

    expect(info).toEqual({
      videoCodec: 'hvc1',
      videoRange: 'PQ',
      frameRate: 50,
      audioCodec: 'ec-3',
      audioLayout: '5.1',
    });
  });

  it('reports HLG from the preferred transfer SEI over a BT.2020 VUI', () => {
    const payload = [...startCode(hevcSps(14)), ...startCode(SEI_PREFERRED_HLG)];
    expect(parseTsInfo(segment(HEVC_EAC3, videoFrames(payload), EAC3_5_1))?.videoRange).toBe('HLG');
  });

  it('reports SDR video without a range', () => {
    expect(parseTsInfo(segment(HEVC_EAC3, videoFrames(startCode(hevcSps(1))), EAC3_5_1))?.videoRange)
      .toBe('');
  });

  it('marks Dolby Vision when the stream carries RPU NAL units', () => {
    const payload = [...startCode(hevcSps(16)), ...startCode(DOLBY_VISION_RPU)];
    expect(parseTsInfo(segment(HEVC_EAC3, videoFrames(payload), EAC3_5_1))?.videoCodec).toBe('dvh1');
  });

  it('reads the AC-3 layout past its optional mix levels', () => {
    const ac3 = [0x0b, 0x77, 0, 0, 0x00, 0x40, 0xe1, 0x00];
    const info = parseTsInfo(segment([{ type: 0x24, pid: 0x100 }, { type: 0x81, pid: 0x101 }],
      videoFrames(startCode(hevcSps(1))), ac3));
    expect(info?.audioCodec).toBe('ac-3');
    expect(info?.audioLayout).toBe('5.1');
  });

  it('reads the ADTS channel configuration for AAC', () => {
    const adts = [0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00];
    const info = parseTsInfo(segment([{ type: 0x1b, pid: 0x100 }, { type: 0x0f, pid: 0x101 }],
      videoFrames([0, 0, 1, 0x09, 0xf0]), adts));
    expect(info).toMatchObject({ videoCodec: 'avc1', audioCodec: 'mp4a.40.2', audioLayout: '2.0', frameRate: 50 });
  });

  it('leaves the range unknown when the SPS is truncated', () => {
    const truncated = startCode(hevcSps(16).slice(0, 12));
    expect(parseTsInfo(segment(HEVC_EAC3, videoFrames(truncated), EAC3_5_1))?.videoRange).toBe('');
  });

  it('ignores data that is not MPEG-TS', () => {
    expect(parseTsInfo(new Uint8Array(400))).toBeNull();
  });
});

describe('frameRateFromPts', () => {
  it('uses display order, not decode order, under B-frame reordering', () => {
    const decodeOrder = [0, 8, 1, 2, 3, 4, 5, 6, 7, 16, 9, 10].map(slot => slot * 1800);
    expect(frameRateFromPts(decodeOrder)).toBe(50);
  });

  it('returns 0 without enough frames to agree on a rate', () => {
    expect(frameRateFromPts([0, 1800])).toBe(0);
  });
});

describe('hevcSpsTransfer', () => {
  it('reads the VUI transfer characteristics', () => {
    const sps = hevcSps(18);
    expect(hevcSpsTransfer(new Uint8Array(sps.filter((byte, i) =>
      !(byte === 3 && sps[i - 1] === 0 && sps[i - 2] === 0))))).toBe(18);
  });
});
