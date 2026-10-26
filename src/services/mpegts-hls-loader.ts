import { createLogger } from '../utils/logger';
import { TsTimeline } from './ts-timeline';

const log = createLogger('MpegtsHls');

// Segments behind the live edge to start from, as hls.js and Shaka do.
const LIVE_START_SEGMENTS = 3;
const MAX_RETRIES = 3;
// Buffered media beyond the starting live delay before the loader waits, so a
// paused 4K stream cannot fill the SourceBuffer.
const AHEAD_SLACK_SECONDS = 10;
const AHEAD_POLL_MS = 1000;

export interface HlsLiveState {
  // Seconds of media between the start segment and the live edge, once known.
  liveDelay: number;
  bufferedAhead(): number;
}

export interface HlsSegment {
  sequence: number;
  duration: number;
  uri: string;
  discontinuity: boolean;
}

export interface HlsMediaPlaylist {
  targetDuration: number;
  segments: HlsSegment[];
  ended: boolean;
  encrypted: boolean;
}

export function parseHlsVariants(text: string, baseUrl: string): Array<{ url: string; bandwidth: number }> {
  const lines = text.split(/\r?\n/);
  const variants: Array<{ url: string; bandwidth: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    let uri = '';
    while (++i < lines.length) {
      uri = lines[i].trim();
      if (uri && !uri.startsWith('#')) break;
    }
    if (uri) variants.push({ url: new URL(uri, baseUrl).toString(), bandwidth });
  }
  return variants;
}

export function parseHlsMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  let sequence = 0;
  let targetDuration = 6;
  let ended = false;
  let encrypted = false;
  let discontinuity = false;
  let duration = 0;
  const segments: HlsSegment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22)) || targetDuration;
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(line)) {
      encrypted = true;
    } else if (!line.startsWith('#')) {
      segments.push({ sequence: sequence++, duration, uri: new URL(line, baseUrl).toString(), discontinuity });
      duration = 0;
      discontinuity = false;
    }
  }
  return { targetDuration, segments, ended, encrypted };
}

interface LoaderErrors {
  EXCEPTION: string;
  HTTP_STATUS_CODE_INVALID: string;
}

interface MpegtsLoaderApi {
  BaseLoader: new (type: string) => object;
  LoaderStatus: { kIdle: number; kConnecting: number; kBuffering: number; kError: number; kComplete: number };
  LoaderErrors: LoaderErrors;
}

interface LoaderInternals {
  _status: number;
  _needStash: boolean;
  _onDataArrival: ((chunk: ArrayBuffer, byteStart: number, received: number) => void) | null;
  _onError: ((type: string, info: { code: number; msg: string }) => void) | null;
  _onComplete: ((from: number, to: number) => void) | null;
}

class AbortedError extends Error {}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Feeds mpegts.js the segments of a live HLS playlist as one continuous
// MPEG-TS stream, so it plays the complete HLS feed instead of a provider's
// separate TS output. Segment bodies stream straight through without copies.
export function createHlsTsLoaderClass(
  mpegts: MpegtsLoaderApi,
  live: HlsLiveState,
): new (seekHandler: unknown, config: unknown) => object {
  const Base = mpegts.BaseLoader;
  const Status = mpegts.LoaderStatus;
  const Errors = mpegts.LoaderErrors;

  return class HlsTsLoader extends Base {
    private aborted = false;
    private controller: AbortController | null = null;
    private received = 0;
    private timeline = new TsTimeline();

    static isSupported(): boolean {
      return typeof fetch === 'function' && typeof ReadableStream === 'function';
    }

    constructor(_seekHandler: unknown, _config: unknown) {
      super('hls-ts-loader');
      (this as unknown as LoaderInternals)._needStash = true;
      this.timeline.onEvent = event => {
        if (event.kind === 'jump') {
          log.info('Closed a timestamp gap in the HLS stream', 'event=playback.mpegts.hls.gap',
            `ms=${Math.round(event.ticks / 90)}`, `pid=${event.pid}`);
        } else {
          log.warn('Restored a one-sided timestamp gap', 'event=playback.mpegts.hls.gap.undone',
            `ms=${Math.round(event.ticks / 90)}`, `pid=${event.pid}`);
        }
      };
    }

    private get self(): LoaderInternals {
      return this as unknown as LoaderInternals;
    }

    destroy(): void {
      this.abort();
      (Base.prototype as { destroy?: () => void }).destroy?.call(this);
    }

    abort(): void {
      this.aborted = true;
      this.controller?.abort();
    }

    open(dataSource: { url: string }): void {
      this.self._status = Status.kConnecting;
      void this.run(dataSource.url).catch(error => {
        if (this.aborted) return;
        this.self._status = Status.kError;
        const status = error instanceof HttpError ? error.status : -1;
        log.warn('HLS loader failed', 'event=playback.mpegts.hls.failed', `status=${status}`,
          error instanceof Error ? error.message : String(error));
        this.self._onError?.(status > 0 ? Errors.HTTP_STATUS_CODE_INVALID : Errors.EXCEPTION,
          { code: status, msg: error instanceof Error ? error.message : String(error) });
      });
    }

    // Waits, then stops the run if the loader was aborted meanwhile.
    private async pause(ms: number): Promise<void> {
      await wait(ms);
      if (this.aborted) throw new AbortedError('aborted');
    }

    private async fetchText(url: string): Promise<{ text: string; url: string }> {
      if (this.aborted) throw new AbortedError('aborted');
      this.controller = new AbortController();
      const response = await fetch(url, { signal: this.controller.signal });
      if (!response.ok) throw new HttpError(response.status);
      return { text: await response.text(), url: response.url || url };
    }

    private async loadPlaylist(url: string): Promise<{ playlist: HlsMediaPlaylist; url: string }> {
      let attempt = 0;
      for (;;) {
        try {
          const { text, url: finalUrl } = await this.fetchText(url);
          return { playlist: parseHlsMediaPlaylist(text, finalUrl), url: finalUrl };
        } catch (error) {
          if (this.aborted || ++attempt > MAX_RETRIES) throw error;
          await this.pause(1000 * attempt);
        }
      }
    }

    private async run(url: string): Promise<void> {
      const first = await this.fetchText(url);
      let mediaUrl = first.url;
      if (first.text.indexOf('#EXT-X-STREAM-INF') !== -1) {
        const variants = parseHlsVariants(first.text, first.url);
        if (!variants.length) throw new Error('HLS master playlist has no variants');
        mediaUrl = variants.reduce((best, v) => (v.bandwidth > best.bandwidth ? v : best)).url;
      }
      let { playlist, url: playlistUrl } = first.text.indexOf('#EXT-X-STREAM-INF') !== -1
        ? await this.loadPlaylist(mediaUrl)
        : { playlist: parseHlsMediaPlaylist(first.text, first.url), url: first.url };
      if (playlist.encrypted) throw new Error('Encrypted HLS is not supported');

      // Null until the playlist lists a segment to start from.
      let next: number | null = null;
      for (;;) {
        if (this.aborted) return;
        const segments = playlist.segments;
        const oldest = segments[0]?.sequence;
        const newest = segments[segments.length - 1]?.sequence;
        if (oldest !== undefined && newest !== undefined) {
          const liveStart = Math.max(oldest, newest - LIVE_START_SEGMENTS + 1);
          if (next === null) {
            next = liveStart;
            live.liveDelay = segments.filter(s => s.sequence >= next!).reduce((sum, s) => sum + s.duration, 0);
            const durations = segments.map(s => s.duration);
            log.info('HLS loader started', 'event=playback.mpegts.hls.started',
              `segments=${segments.length}`, `target=${playlist.targetDuration}`, `startSeq=${next}`,
              `minDuration=${Math.min(...durations).toFixed(2)}`, `maxDuration=${Math.max(...durations).toFixed(2)}`,
              `liveDelay=${live.liveDelay.toFixed(1)}`);
          } else if (newest < next - 1) {
            log.warn('HLS media sequence restarted', 'event=playback.mpegts.hls.reset',
              `expected=${next}`, `newest=${newest}`);
            next = liveStart;
          } else if (next < oldest) {
            log.warn('HLS loader fell behind the live window', 'event=playback.mpegts.hls.behind',
              `skipped=${oldest - next}`);
            next = liveStart;
          }
        }
        const pending = next === null ? [] : segments.filter(s => s.sequence >= next!);
        let throttled = false;
        for (const segment of pending) {
          if (this.aborted) return;
          // Reload the playlist after waiting, in case the window moved on meanwhile.
          if (live.bufferedAhead() > live.liveDelay + AHEAD_SLACK_SECONDS) {
            throttled = true;
            break;
          }
          if (segment.discontinuity) {
            log.info('HLS discontinuity', 'event=playback.mpegts.hls.discontinuity', `seq=${segment.sequence}`);
          }
          await this.streamSegment(segment);
          next = segment.sequence + 1;
        }
        if (playlist.ended) {
          this.self._status = Status.kComplete;
          this.self._onComplete?.(0, this.received - 1);
          return;
        }
        if (throttled) await this.pause(AHEAD_POLL_MS);
        else if (!pending.length) await this.pause(Math.max(500, playlist.targetDuration * 500));
        ({ playlist, url: playlistUrl } = await this.loadPlaylist(playlistUrl));
      }
    }

    private async streamSegment(segment: HlsSegment): Promise<void> {
      let attempt = 0;
      for (;;) {
        const startedAt = this.received;
        this.timeline.startSegment();
        try {
          if (this.aborted) throw new AbortedError('aborted');
          this.controller = new AbortController();
          const response = await fetch(segment.uri, { signal: this.controller.signal });
          if (!response.ok || !response.body) throw new HttpError(response.status);
          const reader = response.body.getReader();
          this.self._status = Status.kBuffering;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (this.aborted) {
              void reader.cancel().catch(() => {});
              return;
            }
            if (!value?.byteLength) continue;
            const packets = this.timeline.push(value);
            if (!packets.byteLength) continue;
            const chunk = packets.byteOffset === 0 && packets.byteLength === packets.buffer.byteLength
              ? packets.buffer as ArrayBuffer
              : packets.buffer.slice(packets.byteOffset, packets.byteOffset + packets.byteLength) as ArrayBuffer;
            const byteStart = this.received;
            this.received += packets.byteLength;
            this.self._onDataArrival?.(chunk, byteStart, this.received);
          }
        } catch (error) {
          // Data already handed over cannot be taken back; only a clean miss retries.
          if (this.aborted || this.received !== startedAt || ++attempt > MAX_RETRIES) throw error;
          log.warn('HLS segment retry', 'event=playback.mpegts.hls.retry', `seq=${segment.sequence}`,
            `attempt=${attempt}`);
          await this.pause(500 * attempt);
        }
      }
    }
  };
}
