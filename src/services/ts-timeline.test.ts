import { describe, expect, it, vi } from 'vitest';
import { TsTimeline, type TimelineEvent } from './ts-timeline';

const VIDEO = 0x100;
const AUDIO = 0x101;
const SUBTITLE = 0x102;
const FRAME = 1800;
const AUDIO_PES = 4 * FRAME;
const JUMP = 345600;

function stamp(prefix: number, value: number): number[] {
  return [
    (prefix << 4) | ((Math.floor(value / 2 ** 30) & 7) << 1) | 1,
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ];
}

function packet(pid: number, payload: number[], adaptation: number[] = []): number[] {
  const body = adaptation.length ? [adaptation.length, ...adaptation, ...payload] : payload;
  return [0x47, 0x40 | (pid >> 8), pid & 0xff, adaptation.length ? 0x30 : 0x10,
    ...body, ...Array(184 - body.length).fill(0xff)];
}

function pesPacket(pid: number, streamId: number, pts: number, dts?: number, pcr?: number): number[] {
  const header = dts === undefined
    ? [0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5, ...stamp(2, pts)]
    : [0, 0, 1, streamId, 0, 0, 0x80, 0xc0, 10, ...stamp(3, pts), ...stamp(1, dts)];
  const adaptation = pcr === undefined ? [] : [0x10,
    Math.floor(pcr / 2 ** 25) & 0xff, Math.floor(pcr / 2 ** 17) & 0xff, Math.floor(pcr / 2 ** 9) & 0xff,
    Math.floor(pcr / 2) & 0xff, ((pcr & 1) << 7) | 0x7e, 0];
  return packet(pid, header, adaptation);
}

function section(tableId: number, body: number[]): number[] {
  const length = body.length + 4;
  return [0, tableId, 0xb0 | (length >> 8), length & 0xff, ...body, 0, 0, 0, 0];
}

// PAT and a PMT listing HEVC video, DVB E-AC-3 audio, and DVB subtitles.
const PROGRAM = [
  ...packet(0, section(0x00, [0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00])),
  ...packet(0x1000, section(0x02, [0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0,
    0x24, 0xe1, 0x00, 0xf0, 0,
    0x06, 0xe1, 0x01, 0xf0, 3, 0x7a, 1, 0x00,
    0x06, 0xe1, 0x02, 0xf0, 3, 0x59, 1, 0x00])),
];

interface Segment { start: number; frames: number; pcr?: boolean; audioSkew?: number; audio?: boolean; video?: boolean }

function segment({ start, frames, pcr = false, audioSkew = 0, audio = true, video = true }: Segment): Uint8Array {
  const out: number[] = [...PROGRAM];
  for (let f = 0; f < frames; f++) {
    const dts = start + f * FRAME;
    if (video) out.push(...pesPacket(VIDEO, 0xe0, dts + 2 * FRAME, dts, pcr && f === 0 ? dts : undefined));
    if (audio && f % 4 === 0) out.push(...pesPacket(AUDIO, 0xbd, start + audioSkew + (f / 4) * AUDIO_PES));
  }
  return new Uint8Array(out);
}

function readStamp(b: Uint8Array, i: number): number {
  return ((b[i] >> 1) & 7) * 2 ** 30 + (b[i + 1] << 22) + ((b[i + 2] >> 1) << 15) + (b[i + 3] << 7) + (b[i + 4] >> 1);
}

function times(data: Uint8Array): { video: number[]; audio: number[]; subtitle: number[]; pcr: number[] } {
  const result = { video: [] as number[], audio: [] as number[], subtitle: [] as number[], pcr: [] as number[] };
  for (let p = 0; p < data.length; p += 188) {
    const pid = ((data[p + 1] & 0x1f) << 8) | data[p + 2];
    let i = p + 4;
    if (data[p + 3] & 0x20) {
      if (data[p + 5] & 0x10) {
        result.pcr.push(data[p + 6] * 2 ** 25 + (data[p + 7] << 17) + (data[p + 8] << 9)
          + (data[p + 9] << 1) + (data[p + 10] >> 7));
      }
      i += 1 + data[p + 4];
    }
    if (pid === VIDEO) result.video.push(readStamp(data, i + 14));
    else if (pid === AUDIO) result.audio.push(readStamp(data, i + 9));
    else if (pid === SUBTITLE) result.subtitle.push(readStamp(data, i + 9));
  }
  return result;
}

function events(timeline: TsTimeline): TimelineEvent[] {
  const seen: TimelineEvent[] = [];
  timeline.onEvent = event => seen.push(event);
  return seen;
}

describe('TsTimeline', () => {
  it('closes a forward jump by shifting audio, video, and PCR together', () => {
    const timeline = new TsTimeline();
    const seen = events(timeline);
    const first = times(timeline.push(segment({ start: 900000, frames: 8, pcr: true })));
    const second = times(timeline.push(segment({ start: 900000 + 8 * FRAME + JUMP, frames: 8, pcr: true })));

    expect(seen).toEqual([
      { kind: 'jump', ticks: JUMP, pid: VIDEO },
      { kind: 'jump', ticks: JUMP, pid: AUDIO },
    ]);
    expect(second.video[0]).toBe(first.video[7] + FRAME);
    expect(second.audio[0]).toBe(900000 + 8 * FRAME);
    expect(second.pcr[0]).toBe(second.video[0]);
  });

  it('closes a jump in the middle of a chunk', () => {
    const timeline = new TsTimeline();
    const data = new Uint8Array([
      ...segment({ start: 900000, frames: 8 }),
      ...segment({ start: 900000 + 8 * FRAME + JUMP, frames: 8 }),
    ]);
    const { video, audio } = times(timeline.push(data));

    expect(video.every((t, i) => i === 0 || t - video[i - 1] === FRAME)).toBe(true);
    expect(audio.every((t, i) => i === 0 || t - audio[i - 1] === AUDIO_PES)).toBe(true);
  });

  it('reuses the jump the other stream measured so audio stays on video', () => {
    const timeline = new TsTimeline();
    timeline.push(segment({ start: 900000, frames: 8 }));
    const second = times(timeline.push(segment({ start: 900000 + 8 * FRAME + JUMP, frames: 8, audioSkew: 900 })));

    expect(second.video[0]).toBe(900000 + 8 * FRAME);
    expect(second.audio[0]).toBe(900000 + 8 * FRAME + 900);
  });

  it('undoes a jump only the audio made, so it stays on the video', () => {
    const timeline = new TsTimeline();
    const seen = events(timeline);
    timeline.push(segment({ start: 900000, frames: 8 }));
    // Audio loses JUMP ticks of frames; video carries on without a gap.
    const after = times(timeline.push(segment({ start: 900000 + 8 * FRAME, frames: 164, audioSkew: JUMP })));

    expect(seen).toEqual([
      { kind: 'jump', ticks: JUMP, pid: AUDIO },
      { kind: 'undone', ticks: JUMP, pid: AUDIO },
    ]);
    expect(after.video[0]).toBe(900000 + 8 * FRAME);
    expect(after.audio[after.audio.length - 1]).toBe(900000 + 8 * FRAME + JUMP + 40 * AUDIO_PES);
  });

  it('ignores gaps on subtitle streams and moves them with the video', () => {
    const timeline = new TsTimeline();
    const seen = events(timeline);
    timeline.push(new Uint8Array([...segment({ start: 900000, frames: 8 }),
      ...pesPacket(SUBTITLE, 0xbd, 900000)]));
    const second = times(timeline.push(new Uint8Array([
      ...segment({ start: 900000 + 8 * FRAME + JUMP, frames: 8 }),
      ...pesPacket(SUBTITLE, 0xbd, 900000 + 8 * FRAME + JUMP + 450000),
    ])));

    expect(seen.map(e => e.pid)).toEqual([VIDEO, AUDIO]);
    expect(second.subtitle).toEqual([900000 + 8 * FRAME + 450000]);
  });

  it('leaves a continuous stream untouched', () => {
    const timeline = new TsTimeline();
    timeline.push(segment({ start: 900000, frames: 8 }));
    const next = segment({ start: 900000 + 8 * FRAME, frames: 8 });
    expect(timeline.push(next)).toEqual(next);
  });

  it('holds a partial packet until the next chunk completes it', () => {
    const timeline = new TsTimeline();
    const data = segment({ start: 900000, frames: 4 });
    const a = timeline.push(data.subarray(0, 300));
    const b = timeline.push(data.subarray(300));
    expect(a.length).toBe(188);
    expect([...a, ...b]).toEqual([...data]);
  });

  it('drops a truncated segment tail so the next segment stays aligned', () => {
    const timeline = new TsTimeline();
    const first = segment({ start: 900000, frames: 4 });
    timeline.push(first.subarray(0, first.length - 100));
    timeline.startSegment();
    const next = segment({ start: 900000 + 4 * FRAME, frames: 4 });

    expect(timeline.push(next)).toEqual(next);
  });

  it('finds the packet boundary when a chunk starts mid-packet', () => {
    const timeline = new TsTimeline();
    const data = segment({ start: 900000, frames: 4 });
    expect([...timeline.push(data.subarray(50))]).toEqual([...data.subarray(188)]);
  });

  it('leaves a DTS that would run past the packet alone', () => {
    const timeline = new TsTimeline();
    timeline.push(segment({ start: 900000, frames: 8 }));
    timeline.push(segment({ start: 900000 + 8 * FRAME + JUMP, frames: 8 }));
    // A long adaptation field leaves room for the PTS but not the DTS.
    const header = [0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, ...stamp(3, 900000 + 16 * FRAME + JUMP), ...stamp(1, 900000 + 16 * FRAME + JUMP)];
    const tight = packet(VIDEO, header.slice(0, 16), [0x00, ...Array(183 - 16 - 2).fill(0xff)]);
    expect(tight).toHaveLength(188);

    expect([...timeline.push(new Uint8Array(tight))]).toEqual(tight);
  });
});
