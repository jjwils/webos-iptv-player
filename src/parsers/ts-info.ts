import { hdrFromTransfer } from '../utils/stream-info';

// Stream facts read from one MPEG-TS media segment, for the OSD readout when
// an HLS playlist carries no CODECS/VIDEO-RANGE/FRAME-RATE/CHANNELS and Shaka
// has only guessed them.
export interface TsInfo {
  videoCodec: string;
  videoRange: string;
  frameRate: number;
  audioCodec: string;
  // "<main>.<lfe>", e.g. "5.1"; '' when unknown.
  audioLayout: string;
}

const PACKET = 188;
const PTS_HZ = 90000;
const MAX_VIDEO_PES = 120;
const HEADER_PES = 3;

const VIDEO_TYPES: Record<number, string> = { 0x1b: 'avc1', 0x24: 'hvc1' };
const AUDIO_TYPES: Record<number, string> = { 0x0f: 'mp4a.40.2', 0x11: 'mp4a.40.2', 0x81: 'ac-3', 0x87: 'ec-3' };
// DVB descriptors that type a private-data (0x06) stream.
const AUDIO_DESCRIPTORS: Record<number, string> = { 0x6a: 'ac-3', 0x7a: 'ec-3', 0x7c: 'mp4a.40.2' };

// AC-3 / E-AC-3 acmod → full-range channel count (acmod 0 is dual mono).
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.bit >> 3];
      if (byte === undefined) throw new RangeError('bitstream exhausted');
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }

  skip(n: number): void {
    this.u(n);
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new RangeError('invalid Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -value / 2;
  }
}

function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let length = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const byte = nal[i];
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

function nalUnits(data: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, index) => {
    let end = index + 1 < starts.length ? starts[index + 1] - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    return data.subarray(start, end);
  });
}

function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.skip(96);
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u(1) === 1);
    levelPresent.push(r.u(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) r.skip(2 * (8 - maxSubLayersMinus1));
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
}

function skipScalingListData(r: BitReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (r.u(1) === 0) {
        r.ue();
        continue;
      }
      const coefficients = Math.min(64, 1 << (4 + (sizeId << 1)));
      if (sizeId > 1) r.se();
      for (let i = 0; i < coefficients; i++) r.se();
    }
  }
}

function skipShortTermRefPicSets(r: BitReader, count: number): void {
  const deltaPocs: number[] = [];
  for (let idx = 0; idx < count; idx++) {
    if (idx !== 0 && r.u(1) === 1) {
      r.u(1);
      r.ue();
      const reference = deltaPocs[idx - 1];
      let used = 0;
      for (let j = 0; j <= reference; j++) {
        const usedByCurrent = r.u(1) === 1;
        if (usedByCurrent || r.u(1) === 1) used++;
      }
      deltaPocs.push(used);
      continue;
    }
    const negative = r.ue();
    const positive = r.ue();
    for (let i = 0; i < negative + positive; i++) {
      r.ue();
      r.u(1);
    }
    deltaPocs.push(negative + positive);
  }
}

// H.265 7.3.2.2: walks the SPS to the VUI colour description. Returns the
// transfer characteristics code, or -1 when the SPS carries none.
export function hevcSpsTransfer(rbsp: Uint8Array): number {
  const r = new BitReader(rbsp);
  r.skip(16); // NAL unit header
  r.skip(4);
  const maxSubLayersMinus1 = r.u(3);
  r.skip(1);
  skipProfileTierLevel(r, maxSubLayersMinus1);
  r.ue();
  if (r.ue() === 3) r.skip(1);
  r.ue();
  r.ue();
  if (r.u(1) === 1) for (let i = 0; i < 4; i++) r.ue();
  r.ue();
  r.ue();
  const pocLsbBits = r.ue() + 4;
  const orderingInfo = r.u(1) === 1;
  for (let i = orderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue();
    r.ue();
    r.ue();
  }
  for (let i = 0; i < 6; i++) r.ue();
  if (r.u(1) === 1 && r.u(1) === 1) skipScalingListData(r);
  r.skip(2);
  if (r.u(1) === 1) {
    r.skip(8);
    r.ue();
    r.ue();
    r.skip(1);
  }
  skipShortTermRefPicSets(r, r.ue());
  if (r.u(1) === 1) {
    const longTerm = r.ue();
    for (let i = 0; i < longTerm; i++) r.skip(pocLsbBits + 1);
  }
  r.skip(2);
  if (r.u(1) === 0) return -1;
  if (r.u(1) === 1 && r.u(8) === 255) r.skip(32);
  if (r.u(1) === 1) r.skip(1);
  if (r.u(1) === 0) return -1;
  r.skip(4);
  if (r.u(1) === 0) return -1;
  r.skip(8);
  return r.u(8);
}

interface HevcFacts {
  transfer: number;
  dolbyVision: boolean;
  preferredTransfer: number;
}

function readSeiPayloads(rbsp: Uint8Array, facts: HevcFacts): void {
  let i = 2;
  while (i < rbsp.length - 1) {
    let type = 0;
    while (rbsp[i] === 0xff) { type += 255; i++; }
    type += rbsp[i++];
    let size = 0;
    while (rbsp[i] === 0xff) { size += 255; i++; }
    size += rbsp[i++];
    if (type === 147 && i < rbsp.length) facts.preferredTransfer = rbsp[i];
    i += size;
  }
}

function hevcFacts(payloads: Uint8Array[]): HevcFacts {
  const facts: HevcFacts = { transfer: -1, dolbyVision: false, preferredTransfer: -1 };
  for (const payload of payloads) {
    for (const nal of nalUnits(payload)) {
      if (nal.length < 2) continue;
      const type = (nal[0] >> 1) & 0x3f;
      if (type === 62 || type === 63) facts.dolbyVision = true;
      try {
        if (type === 33 && facts.transfer < 0) facts.transfer = hevcSpsTransfer(unescapeRbsp(nal));
        else if (type === 39) readSeiPayloads(unescapeRbsp(nal), facts);
      } catch {
        // A truncated or unexpected parameter set leaves the range unknown.
      }
    }
  }
  return facts;
}

// The most common gap between display-ordered timestamps; B-frames make
// decode order useless for this.
export function frameRateFromPts(pts: number[]): number {
  const sorted = Array.from(new Set(pts)).sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  counts.forEach((count, gap) => {
    if (count > bestCount) { best = gap; bestCount = count; }
  });
  if (bestCount < 2 || best <= 0) return 0;
  const fps = PTS_HZ / best;
  return fps >= 10 && fps <= 121 ? Math.round(fps * 1000) / 1000 : 0;
}

export function audioLayout(codec: string, frame: Uint8Array): string {
  for (let i = 0; i + 7 < frame.length && i < 64; i++) {
    if (codec === 'mp4a.40.2') {
      if (frame[i] !== 0xff || (frame[i + 1] & 0xf0) !== 0xf0) continue;
      const config = ((frame[i + 2] & 1) << 2) | (frame[i + 3] >> 6);
      if (config === 0) return '';
      return config === 7 ? '7.1' : config >= 6 ? '5.1' : `${config}.0`;
    }
    if (frame[i] !== 0x0b || frame[i + 1] !== 0x77) continue;
    const bsid = frame[i + 5] >> 3;
    if (bsid > 10) {
      const acmod = (frame[i + 4] >> 1) & 7;
      return `${ACMOD_CHANNELS[acmod]}.${frame[i + 4] & 1}`;
    }
    const r = new BitReader(frame.subarray(i + 6));
    const acmod = r.u(3);
    if ((acmod & 1) && acmod !== 1) r.skip(2);
    if (acmod & 4) r.skip(2);
    if (acmod === 2) r.skip(2);
    return `${ACMOD_CHANNELS[acmod]}.${r.u(1)}`;
  }
  return '';
}

interface PesState {
  pts: number[];
  payloads: Uint8Array[];
  chunks: Uint8Array[] | null;
}

function pesPts(pes: Uint8Array): number | null {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7] & 0x80)) return null;
  return (pes[9] & 0x0e) * 536870912 + pes[10] * 4194304 + (pes[11] >> 1) * 32768
    + pes[12] * 128 + (pes[13] >> 1);
}

function pesPayload(pes: Uint8Array): Uint8Array {
  return pes.length > 9 ? pes.subarray(9 + pes[8]) : new Uint8Array(0);
}

function finishPes(state: PesState): void {
  if (!state.chunks) return;
  const length = state.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of state.chunks) {
    pes.set(chunk, offset);
    offset += chunk.length;
  }
  state.chunks = null;
  state.payloads.push(pesPayload(pes));
}

function sectionStart(bytes: Uint8Array, offset: number, pusi: boolean): number {
  return pusi ? offset + 1 + bytes[offset] : offset;
}

export function parseTsInfo(bytes: Uint8Array): TsInfo | null {
  if (bytes.length < PACKET || bytes[0] !== 0x47) return null;
  let pmtPid = -1;
  let videoPid = -1;
  let audioPid = -1;
  let videoCodec = '';
  let audioCodec = '';
  const video: PesState = { pts: [], payloads: [], chunks: null };
  const audio: PesState = { pts: [], payloads: [], chunks: null };

  for (let p = 0; p + PACKET <= bytes.length; p += PACKET) {
    if (bytes[p] !== 0x47) return null;
    const pusi = (bytes[p + 1] & 0x40) !== 0;
    const pid = ((bytes[p + 1] & 0x1f) << 8) | bytes[p + 2];
    const control = (bytes[p + 3] >> 4) & 3;
    if (!(control & 1)) continue;
    let offset = p + 4;
    if (control & 2) offset += 1 + bytes[offset];
    if (offset >= p + PACKET) continue;
    const payload = bytes.subarray(offset, p + PACKET);

    if (pid === 0 && pmtPid < 0) {
      const s = sectionStart(bytes, offset, pusi);
      const end = Math.min(s + 3 + (((bytes[s + 1] & 0x0f) << 8) | bytes[s + 2]) - 4, p + PACKET);
      for (let i = s + 8; i + 4 <= end; i += 4) {
        if (((bytes[i] << 8) | bytes[i + 1]) !== 0) {
          pmtPid = ((bytes[i + 2] & 0x1f) << 8) | bytes[i + 3];
          break;
        }
      }
    } else if (pid === pmtPid && videoPid < 0 && audioPid < 0) {
      const s = sectionStart(bytes, offset, pusi);
      const end = Math.min(s + 3 + (((bytes[s + 1] & 0x0f) << 8) | bytes[s + 2]) - 4, p + PACKET);
      let i = s + 12 + (((bytes[s + 10] & 0x0f) << 8) | bytes[s + 11]);
      while (i + 5 <= end) {
        const type = bytes[i];
        const esPid = ((bytes[i + 1] & 0x1f) << 8) | bytes[i + 2];
        const infoLength = ((bytes[i + 3] & 0x0f) << 8) | bytes[i + 4];
        let codec = '';
        if (type === 0x06) {
          for (let d = i + 5; d + 2 <= i + 5 + infoLength; d += 2 + bytes[d + 1]) {
            codec = AUDIO_DESCRIPTORS[bytes[d]] ?? codec;
          }
        }
        if (videoPid < 0 && VIDEO_TYPES[type]) {
          videoPid = esPid;
          videoCodec = VIDEO_TYPES[type];
        } else if (audioPid < 0 && (AUDIO_TYPES[type] || codec)) {
          audioPid = esPid;
          audioCodec = AUDIO_TYPES[type] || codec;
        }
        i += 5 + infoLength;
      }
    } else if (pid === videoPid || pid === audioPid) {
      const state = pid === videoPid ? video : audio;
      if (pusi) {
        finishPes(state);
        // Only the first few frames' bytes are kept; the rest give timestamps.
        const pts = pesPts(payload);
        if (pts !== null) state.pts.push(pts);
        if (video.pts.length >= MAX_VIDEO_PES && (audioPid < 0 || audio.payloads.length)) break;
        state.chunks = state.payloads.length < (pid === videoPid ? HEADER_PES : 1) ? [] : null;
      }
      if (state.chunks) state.chunks.push(payload);
    }
  }
  finishPes(video);
  finishPes(audio);
  if (!videoCodec && !audioCodec) return null;

  let videoRange = '';
  if (videoCodec === 'hvc1') {
    const facts = hevcFacts(video.payloads);
    if (facts.dolbyVision) videoCodec = 'dvh1';
    videoRange = hdrFromTransfer(facts.preferredTransfer === 18 ? 18 : facts.transfer);
  }
  return {
    videoCodec,
    videoRange,
    frameRate: frameRateFromPts(video.pts),
    audioCodec,
    audioLayout: audio.payloads.length ? audioLayout(audioCodec, audio.payloads[0]) : '',
  };
}
