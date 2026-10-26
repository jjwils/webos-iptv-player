import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlsTsLoaderClass, parseHlsMediaPlaylist, parseHlsVariants } from './mpegts-hls-loader';

const Status = { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3, kComplete: 4 };
const Errors = { EXCEPTION: 'Exception', HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid' };

class BaseLoader {
  _status = Status.kIdle;
  _needStash = false;
  _onDataArrival: ((chunk: ArrayBuffer, start: number, received: number) => void) | null = null;
  _onError: ((type: string, info: { code: number; msg: string }) => void) | null = null;
  _onComplete: ((from: number, to: number) => void) | null = null;
  constructor(readonly type: string) {}
  destroy(): void {
    this._onDataArrival = null;
  }
}

interface TestLoader extends BaseLoader {
  open(source: { url: string }): void;
  abort(): void;
}

const live = { liveDelay: 0, ahead: 0, bufferedAhead: () => live.ahead };

const Loader = createHlsTsLoaderClass({ BaseLoader, LoaderStatus: Status, LoaderErrors: Errors }, live) as
  unknown as new (seekHandler: unknown, config: unknown) => TestLoader;

// One null TS packet whose payload is filled with the segment's number.
function segmentBytes(sequence: number): Uint8Array {
  const packet = new Uint8Array(188).fill(sequence);
  packet.set([0x47, 0x1f, 0xff, 0x10]);
  return packet;
}

// A video PES packet carrying `dts`, for segments whose timestamps jump.
function videoPacket(dts: number): Uint8Array {
  const stamp = (prefix: number, v: number) => [(prefix << 4) | ((Math.floor(v / 2 ** 30) & 7) << 1) | 1,
    Math.floor(v / 2 ** 22) & 0xff, ((Math.floor(v / 2 ** 15) & 0x7f) << 1) | 1, Math.floor(v / 2 ** 7) & 0xff,
    ((v & 0x7f) << 1) | 1];
  const header = [0x47, 0x41, 0x00, 0x10, 0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, ...stamp(3, dts), ...stamp(1, dts)];
  return new Uint8Array([...header, ...Array(188 - header.length).fill(0xff)]);
}

function tablePacket(pid: number, table: number[]): number[] {
  const section = [0, ...table, 0, 0, 0, 0];
  section[3] = table.length + 4 - 3 + 1;
  return [0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, ...section, ...Array(184 - section.length).fill(0xff)];
}

// PAT and a PMT whose only stream is HEVC video on PID 0x100.
const PROGRAM = new Uint8Array([
  ...tablePacket(0, [0x00, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]),
  ...tablePacket(0x1000, [0x02, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0, 0x24, 0xe1, 0x00, 0xf0, 0]),
]);

const withProgram = (...packets: Uint8Array[]) =>
  new Uint8Array([...PROGRAM, ...packets.flatMap(packet => [...packet])]);

let segmentBodies = new Map<number, Uint8Array>();

function mediaPlaylist(first: number, count: number, extra = ''): string {
  let text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n${extra}`;
  for (let i = 0; i < count; i++) text += `#EXTINF:2.0,\nseg${first + i}.ts\n`;
  return text;
}

let playlists: string[] = [];
let failures = new Map<string, number>();
const fetchMock = vi.fn((url: string) => {
  const failing = failures.get(url) ?? 0;
  if (failing > 0) {
    failures.set(url, failing - 1);
    return Promise.resolve(new Response('', { status: 503 }));
  }
  if (url.endsWith('.m3u8')) {
    const text = playlists.length > 1 ? playlists.shift()! : playlists[0];
    return Promise.resolve(new Response(text));
  }
  const sequence = Number(/seg(\d+)\.ts$/.exec(url)?.[1]);
  return Promise.resolve(new Response(segmentBodies.get(sequence) ?? segmentBytes(sequence)));
});

function openLoader(url = 'http://host/live/ch1.m3u8') {
  const loader = new Loader(null, null);
  const received: number[] = [];
  loader._onDataArrival = chunk => received.push(new Uint8Array(chunk)[4]);
  loader._onError = vi.fn();
  loader._onComplete = vi.fn();
  loader.open({ url });
  return { loader, received };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  playlists = [];
  failures = new Map();
  segmentBodies = new Map();
  live.liveDelay = 0;
  live.ahead = 0;
  fetchMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseHlsMediaPlaylist', () => {
  it('reads sequences, durations, discontinuities, and resolves segment URLs', () => {
    const playlist = parseHlsMediaPlaylist([
      '#EXTM3U', '#EXT-X-TARGETDURATION:12', '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXTINF:9.60,', 'a.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:11.52,', 'http://cdn/b.ts?t=1',
    ].join('\n'), 'http://host/live/u1/p1/index.m3u8');

    expect(playlist).toEqual({
      targetDuration: 12,
      ended: false,
      encrypted: false,
      segments: [
        { sequence: 7, duration: 9.6, uri: 'http://host/live/u1/p1/a.ts', discontinuity: false },
        { sequence: 8, duration: 11.52, uri: 'http://cdn/b.ts?t=1', discontinuity: true },
      ],
    });
  });

  it('flags encryption and the end of a playlist', () => {
    const playlist = parseHlsMediaPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'http://host/a.m3u8');
    expect([playlist.encrypted, playlist.ended]).toEqual([true, true]);
  });
});

describe('parseHlsVariants', () => {
  it('lists each variant with its bandwidth', () => {
    expect(parseHlsVariants(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000\nhigh.m3u8',
      'http://host/master.m3u8',
    )).toEqual([
      { url: 'http://host/low.m3u8', bandwidth: 900 },
      { url: 'http://host/high.m3u8', bandwidth: 9000 },
    ]);
  });
});

describe('HLS TS loader', () => {
  it('starts three segments behind the live edge and follows new segments in order', async () => {
    playlists = [mediaPlaylist(10, 6), mediaPlaylist(11, 6), mediaPlaylist(12, 6)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([13, 14, 15, 16, 17]);
    expect(loader._status).toBe(Status.kBuffering);
    expect(vi.mocked(console.log).mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.hls.started', 'startSeq=13', 'minDuration=2.00', 'maxDuration=2.00',
        'liveDelay=6.0']));
    expect(live.liveDelay).toBe(6);
    loader.abort();
  });

  it('waits for the playlist to grow before reloading it', async () => {
    playlists = [mediaPlaylist(10, 4), mediaPlaylist(10, 4), mediaPlaylist(10, 5)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([11, 12, 13]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([11, 12, 13, 14]);
    loader.abort();
  });

  it('closes a timestamp jump between segments and logs it', async () => {
    playlists = [mediaPlaylist(10, 2)];
    segmentBodies.set(10, withProgram(videoPacket(900000), videoPacket(901800)));
    segmentBodies.set(11, withProgram(videoPacket(903600 + 345600)));
    const chunks: Uint8Array[] = [];
    const loader = new Loader(null, null);
    loader._onDataArrival = chunk => chunks.push(new Uint8Array(chunk));
    loader.open({ url: 'http://host/live/ch1.m3u8' });

    await vi.advanceTimersByTimeAsync(0);
    expect(chunks).toHaveLength(2);
    expect([...chunks[1].subarray(PROGRAM.length)]).toEqual([...videoPacket(903600)]);
    expect(vi.mocked(console.log).mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.hls.gap', 'ms=3840', 'pid=256']));
    loader.abort();
  });

  it('logs a playlist discontinuity', async () => {
    playlists = [mediaPlaylist(10, 3).replace('#EXTINF:2.0,\nseg12.ts', '#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nseg12.ts')];
    const { loader } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(console.log).mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.hls.discontinuity', 'seq=12']));
    loader.abort();
  });

  it('plays the highest-bandwidth variant of a master playlist', async () => {
    playlists = [
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9000\nhigh.m3u8',
      mediaPlaylist(1, 3),
    ];
    const { loader } = openLoader('http://host/master.m3u8');

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls[1][0]).toBe('http://host/high.m3u8');
    loader.abort();
  });

  it('jumps back near the live edge when it falls out of the window', async () => {
    playlists = [mediaPlaylist(10, 4), mediaPlaylist(30, 6)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([11, 12, 13, 33, 34, 35]);
    expect(vi.mocked(console.warn).mock.calls.flat()).toContain('event=playback.mpegts.hls.behind');
    loader.abort();
  });

  it('retries a segment that fails before sending any data', async () => {
    playlists = [mediaPlaylist(10, 3)];
    failures.set('http://host/live/seg10.ts', 1);
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(600);
    expect(received.slice(0, 3)).toEqual([10, 11, 12]);
    expect(vi.mocked(console.warn).mock.calls.flat()).toContain('event=playback.mpegts.hls.retry');
    loader.abort();
  });

  it('reports a segment that keeps failing', async () => {
    playlists = [mediaPlaylist(10, 3)];
    failures.set('http://host/live/seg10.ts', 10);
    const { loader } = openLoader();

    await vi.advanceTimersByTimeAsync(5000);
    expect(loader._onError).toHaveBeenCalledWith(Errors.HTTP_STATUS_CODE_INVALID, { code: 503, msg: 'HTTP 503' });
    expect(loader._status).toBe(Status.kError);
    expect(vi.mocked(console.warn).mock.calls.flat()).toContain('event=playback.mpegts.hls.failed');
  });

  it('rejects encrypted HLS', async () => {
    playlists = [mediaPlaylist(10, 3, '#EXT-X-KEY:METHOD=AES-128,URI="k"\n')];
    const { loader } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(loader._onError).toHaveBeenCalledWith(Errors.EXCEPTION,
      { code: -1, msg: 'Encrypted HLS is not supported' });
  });

  it('completes a playlist that has ended', async () => {
    playlists = [`${mediaPlaylist(10, 2)}#EXT-X-ENDLIST\n`];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([10, 11]);
    expect(loader._onComplete).toHaveBeenCalledWith(0, 375);
  });

  it('restarts near the live edge when the media sequence resets', async () => {
    playlists = [mediaPlaylist(5000, 3), mediaPlaylist(0, 4)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    expect(received.map(n => n % 256)).toEqual([5000 % 256, 5001 % 256, 5002 % 256, 1, 2, 3]);
    expect(vi.mocked(console.warn).mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.hls.reset', 'expected=5003', 'newest=3']));
    loader.abort();
  });

  it('starts quietly once an empty playlist gains segments', async () => {
    playlists = [mediaPlaylist(10, 0), mediaPlaylist(10, 4)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([11, 12, 13]);
    expect(vi.mocked(console.warn).mock.calls.flat()).not.toContain('event=playback.mpegts.hls.behind');
    loader.abort();
  });

  it('waits while paused media fills the buffer, then catches up with the playlist', async () => {
    live.ahead = 100;
    playlists = [mediaPlaylist(10, 4), mediaPlaylist(11, 4)];
    const { loader, received } = openLoader();

    await vi.advanceTimersByTimeAsync(3000);
    expect(received).toEqual([]);
    live.ahead = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toEqual([11, 12, 13, 14]);
    loader.abort();
  });

  it('keeps a truncated segment from misaligning the next one', async () => {
    playlists = [`${mediaPlaylist(10, 2)}#EXT-X-ENDLIST\n`];
    segmentBodies.set(10, new Uint8Array([...segmentBytes(10), ...segmentBytes(10).subarray(0, 100)]));
    const chunks: Uint8Array[] = [];
    const loader = new Loader(null, null);
    loader._onDataArrival = chunk => chunks.push(new Uint8Array(chunk));
    loader.open({ url: 'http://host/live/ch1.m3u8' });

    await vi.advanceTimersByTimeAsync(0);
    expect(chunks.map(c => [c.length, c[0], c[4]])).toEqual([[188, 0x47, 10], [188, 0x47, 11]]);
  });

  it('sends no request after an abort during a retry wait', async () => {
    playlists = [mediaPlaylist(10, 3)];
    failures.set('http://host/live/seg10.ts', 1);
    const { loader } = openLoader();

    await vi.advanceTimersByTimeAsync(0);
    const calls = fetchMock.mock.calls.length;
    loader.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(loader._onError).not.toHaveBeenCalled();
  });

  it('stops fetching once aborted', async () => {
    playlists = [mediaPlaylist(10, 4)];
    const { loader } = openLoader();
    loader.abort();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loader._onError).not.toHaveBeenCalled();
  });
});
