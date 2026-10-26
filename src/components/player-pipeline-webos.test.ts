// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerPipelineOptions } from './player-pipeline';

const cacheMocks = vi.hoisted(() => ({
  getCachedStreamMime: vi.fn(),
  setCachedStreamMime: vi.fn(),
}));

vi.mock('../services/idb-cache', () => cacheMocks);

const tsInfoMock = vi.hoisted(() => ({ parseTsInfo: vi.fn() }));

vi.mock('../parsers/ts-info', () => tsInfoMock);

function callbacks(): PlayerPipelineOptions {
  return {
    playbackLabel: token => `load=${String(token)}`,
    mediaState: () => '',
    isCatchup: () => false,
    onError: vi.fn(),
    onAudioTracksUpdated: vi.fn(),
    onSubtitleTracksUpdated: vi.fn(),
    onManifest: vi.fn(),
    onStreamInfoUpdated: vi.fn(),
  };
}

function videoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  vi.spyOn(video, 'play').mockResolvedValue();
  vi.spyOn(video, 'load').mockImplementation(() => {});
  return video;
}

describe('PlayerPipeline webOS stream MIME cache', () => {
  beforeEach(() => {
    vi.resetModules();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
  });

  it.each(['mkv', 'avi', 'mov', 'webm'])(
    'omits the source type for direct .%s playback',
    async extension => {
      const { PlayerPipeline } = await import('./player-pipeline');
      const pipeline = new PlayerPipeline(callbacks());
      const video = videoElement();
      pipeline.setVideoElement(video);

      pipeline.load(`http://host/movie/ch1.${extension}`, null, { direct: true });

      const source = video.querySelector('source');
      expect(source?.src).toBe(`http://host/movie/ch1.${extension}`);
      expect(source?.hasAttribute('type')).toBe(false);
      expect(video.play).toHaveBeenCalledOnce();
    },
  );

  it('plays an ambiguous route from the IndexedDB MIME cache without probing', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('video/mp2t');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.getCachedStreamMime).toHaveBeenCalledWith('http://host/live');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(video.querySelector('source')?.src).toBe('http://host/live/ch1');
  });

  it('stores a successful probe in the IndexedDB MIME cache', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { headers: { 'content-type': 'video/mp2t' } }),
    ));
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'video/mp2t');
  });

  it('ignores a cache result after a newer load supersedes it', async () => {
    let resolveCache: ((mime: string | null) => void) | undefined;
    cacheMocks.getCachedStreamMime.mockReturnValue(
      new Promise(resolve => { resolveCache = resolve; }),
    );
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);
    pipeline.load('http://host/live/ch2.ts', null);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());

    resolveCache?.('application/vnd.apple.mpegurl');
    await Promise.resolve();
    await Promise.resolve();

    expect(video.querySelector('source')?.src).toBe('http://host/live/ch2.ts');
    expect(video.play).toHaveBeenCalledOnce();
  });
});

describe('PlayerPipeline webOS DASH', () => {
  beforeEach(() => {
    vi.resetModules();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
  });

  async function pipelineFor(video: HTMLVideoElement) {
    const { PlayerPipeline } = await import('./player-pipeline');
    const opts = callbacks();
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(video);
    return Object.assign(pipeline, { opts });
  }

  const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <Period>
    <AdaptationSet contentType="audio" lang="l1" label="Track 1">
      <Representation id="a1" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="l2" label="Track 2">
      <Representation id="a2" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1" label="Track 1">
      <Representation id="s1"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  it('parses a fetched MPD into audio and subtitle labels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(MPD)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    const manifest = vi.mocked(pipeline.opts.onManifest).mock.calls[0][0];
    expect(manifest.audio.map(a => a.name)).toEqual(['Track 1', 'Track 2']);
    expect(manifest.subtitles.map(s => s.lang)).toEqual(['l1']);
    expect(manifest.masterUrl).toBe('http://host/a.mpd');
  });

  it.each([
    ['whitespace', ` \n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    ['comment', `<!-- lead -->\n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    ['doctype', `<!DOCTYPE MPD>\n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    [
      'namespace prefix',
      MPD
        .replace('<MPD xmlns=', '<dash:MPD xmlns:dash=')
        .replace('</MPD>', '</dash:MPD>'),
    ],
  ])('accepts an MPD with a legal %s opening', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].audio).toHaveLength(2);
  });

  it('accepts an MPD larger than the HLS manifest byte budget', async () => {
    const padded = MPD + `<!--${'x'.repeat(400 * 1024)}-->`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(padded)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].audio).toHaveLength(2);
  });

  it('takes the error path immediately for a DRM-protected MPD', async () => {
    const drm = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection schemeIdUri="urn:uuid:00000000-0000-0000-0000-000000000000"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(drm)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledOnce());
    expect(pipeline.opts.onManifest).toHaveBeenCalledOnce();
  });

  it('does not reject an MPD with only the generic MP4 protection descriptor', async () => {
    const generic = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(generic)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
  });

  it('ignores a DRM verdict from a superseded load', async () => {
    const drm = MPD.replace('</MPD>',
      '<ContentProtection schemeIdUri="urn:uuid:0"/></MPD>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(drm)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);
    pipeline.load('http://host/b.m3u8', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
  });

  it('prepares PlayReady before attaching the native DASH source', async () => {
    const playReady = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection ' +
      'schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(playReady)));
    const request = vi.fn();
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private method = '';

      call(uri: string): void {
        this.method = uri.slice(uri.lastIndexOf('/') + 1);
        request(uri, { method: this.method });
        if (this.method === 'load') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            clientId: 'client-1',
          }));
        } else if (this.method === 'sendDrmMessage') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            resultCode: 0,
            msgId: 'msg-1',
          }));
        } else if (this.method === 'unload') {
          this.onservicecallback?.('{"returnValue":true}');
        }
      }

      cancel(): void {
        this.onservicecallback = null;
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', {
      configurable: true,
      value: FakePalmServiceBridge,
    });
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/a.mpd', {
      'inputstream.adaptive.license_type': 'com.microsoft.playready',
      'inputstream.adaptive.license_key': 'http://host/license|x-token=v|R{SSM}|',
    });

    expect(pipeline.drmLabel()).toBe('');
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(pipeline.drmLabel()).toBe('PlayReady');
    expect(request.mock.calls.map(call => call[1].method)).toEqual([
      'load',
      'getRightsError',
      'sendDrmMessage',
    ]);
    expect(parseMediaOption(video.querySelector('source')?.type ?? '')).toEqual({
      mediaTransportType: 'MPEG-DASH',
      option: {
        drm: {
          type: 'playready',
          clientId: 'client-1',
        },
      },
    });

    pipeline.destroy();
    expect(pipeline.drmLabel()).toBe('');
  });

  it.each([
    { label: 'Widevine', keySystem: 'com.widevine.alpha', scheme: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' },
    { label: 'ClearKey', keySystem: 'org.w3.clearkey', scheme: 'e2719d58-a985-b3c9-781a-b030af78d30e' },
    { label: 'ClearKey', keySystem: 'org.w3.clearkey', scheme: '9a04f079-9840-4286-ab92-e65be0885f95' },
  ])('routes $label through Shaka when the MPD declares $scheme', async testCase => {
    const widevine = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection ' +
      `schemeIdUri="urn:uuid:${testCase.scheme}"/>` +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(widevine)));
    const requestFilters: Array<
      (type: number, request: { headers: Record<string, string> }) => void
    > = [];
    const configure = vi.fn(() => true);
    const load = vi.fn().mockResolvedValue(undefined);
    class Player {
      static isBrowserSupported(): boolean {
        return true;
      }

      addEventListener(): void {}
      attach(): Promise<void> {
        return Promise.resolve();
      }
      configure = configure;
      destroy(): Promise<void> {
        return Promise.resolve();
      }
      getAudioTracks(): [] {
        return [];
      }
      getNetworkingEngine(): {
        registerRequestFilter: (
          filter: (type: number, request: { headers: Record<string, string> }) => void,
        ) => void;
      } {
        return {
          registerRequestFilter: filter => requestFilters.push(filter),
        };
      }
      getTextTracks(): [] {
        return [];
      }
      getVariantTracks(): [] {
        return [];
      }
      load = load;
      selectAudioTrack(): void {}
      selectTextTrack(): void {}
    }
    vi.stubGlobal('__shaka', {
      Player,
      net: { NetworkingEngine: { RequestType: { LICENSE: 2 } } },
      polyfill: { installAll: vi.fn() },
      util: { Error: { Severity: { CRITICAL: 2 } } },
    });
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', {
      'inputstream.adaptive.license_type': testCase.keySystem,
      'inputstream.adaptive.license_key':
        'http://host/license|authorization=Bearer%20token',
    });

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('http://host/a.mpd'));
    const request = { headers: {} as Record<string, string> };
    requestFilters[0]?.(2, request);
    expect(configure).toHaveBeenCalledWith({
      streaming: { bufferingGoal: 30 },
      mediaSource: { transmuxWorkerUrl: 'js/shaka-player.transmuxer-worker.js' },
      drm: {
        preferredKeySystems: [testCase.keySystem],
        servers: { [testCase.keySystem]: 'http://host/license' },
      },
    });
    expect(request.headers).toEqual({ authorization: 'Bearer token' });
    expect(video.querySelector('source')).toBeNull();
    expect(pipeline.isMseActive()).toBe(true);
    expect(pipeline.drmLabel()).toBe(testCase.label);
  });

  it('plays an .mpd URL natively with the MPEG-DASH media option', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MPD));
    vi.stubGlobal('fetch', fetchMock);
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    const source = video.querySelector('source');
    expect(source?.src).toBe('http://host/a.mpd');
    expect(parseMediaOption(source?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    expect(source?.type).not.toContain('application/dash+xml');
    expect(cacheMocks.getCachedStreamMime).not.toHaveBeenCalled();
  });

  it('plays a cached DASH route without probing', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('application/dash+xml');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(MPD)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.getCachedStreamMime).toHaveBeenCalledWith('http://host/live');
    // A cached classification skips probing and storage; routing still fetches
    // the MPD for track labels.
    expect(cacheMocks.setCachedStreamMime).not.toHaveBeenCalled();
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
  });

  it('caches and plays a DASH route discovered by the content-type probe', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { headers: { 'content-type': 'application/dash+xml' } }),
    ));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
  });

  it('plays an extension-less MPD detected by sniffing the body', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<?xml version="1.0"?><MPD type="dynamic"></MPD>',
        { headers: { 'content-type': 'application/octet-stream' } }),
    ));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    // A sniffed classification is cached like any other, keyed by route.
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
  });

  it.each(['application/xml', 'text/xml'])(
    'plays an extension-less MPD served as %s',
    async contentType => {
      cacheMocks.getCachedStreamMime.mockResolvedValue(null);
      cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('<?xml version="1.0"?><MPD type="dynamic"></MPD>', {
          headers: { 'content-type': contentType },
        })));
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      const { parseMediaOption } = await import('../utils/webos-media-option');

      pipeline.load('http://host/live/1', null);

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
        .toEqual({ mediaTransportType: 'MPEG-DASH' });
      expect(cacheMocks.setCachedStreamMime)
        .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
    },
  );

  it('omits the type attribute when the bare source spelling is selected', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { CONFIG } = await import('../config');
    const previous = CONFIG.PLAYER.DASH_SOURCE;
    CONFIG.PLAYER.DASH_SOURCE = 'bare';
    try {
      const video = videoElement();
      const pipeline = await pipelineFor(video);

      pipeline.load('http://host/a.mpd', null);

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(video.querySelector('source')?.getAttribute('type')).toBeNull();
    } finally {
      CONFIG.PLAYER.DASH_SOURCE = previous;
    }
  });
});

describe('PlayerPipeline webOS Live player setting', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('#EXTM3U\n')));
  });

  type ResponseFilter = (type: number, response: { data: ArrayBuffer }) => void;
  let responseFilters: ResponseFilter[] = [];
  let configureCalls: unknown[] = [];

  function stubShaka(options: {
    load?: () => Promise<void>;
    supported?: boolean;
    onAttach?: (video: HTMLVideoElement) => void;
    variant?: Record<string, unknown>;
  } = {}) {
    responseFilters = [];
    configureCalls = [];
    const load = vi.fn(options.load ?? (() => Promise.resolve()));
    class Player {
      static isBrowserSupported(): boolean {
        return options.supported ?? true;
      }

      addEventListener(): void {}
      attach(video: HTMLVideoElement): Promise<void> {
        options.onAttach?.(video);
        return Promise.resolve();
      }
      configure(config: unknown): boolean {
        configureCalls.push(config);
        return true;
      }
      destroy(): Promise<void> {
        return Promise.resolve();
      }
      getAudioTracks(): [] {
        return [];
      }
      getNetworkingEngine() {
        return {
          registerRequestFilter: () => {},
          registerResponseFilter: (filter: ResponseFilter) => responseFilters.push(filter),
        };
      }
      getTextTracks(): [] {
        return [];
      }
      getVariantTracks(): Array<Record<string, unknown>> {
        return options.variant ? [{ active: true, ...options.variant }] : [];
      }
      seekRange(): { start: number; end: number } {
        return { start: 100, end: 400 };
      }
      load = load;
      selectAudioTrack(): void {}
      selectTextTrack(): void {}
    }
    vi.stubGlobal('__shaka', {
      Player,
      net: { NetworkingEngine: { RequestType: { LICENSE: 2, SEGMENT: 1 } } },
      polyfill: { installAll: vi.fn() },
      util: { Error: { Severity: { CRITICAL: 2 } } },
    });
    return load;
  }

  async function pipelineFor(video: HTMLVideoElement, livePlayer: 'system' | 'shaka', catchup = false) {
    const { StorageService } = await import('../services/storage-service');
    StorageService.setLivePlayer(livePlayer);
    const { PlayerPipeline } = await import('./player-pipeline');
    const opts = { ...callbacks(), isCatchup: () => catchup };
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(video);
    return Object.assign(pipeline, { opts });
  }

  function pathEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.flat()
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('event=playback.path.'));
  }

  it('plays live HLS natively with the system player', async () => {
    const load = stubShaka();
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'system');

    pipeline.load('http://host/live/ch1.m3u8', null);

    expect(video.querySelector('source')?.src).toBe('http://host/live/ch1.m3u8');
    expect(video.play).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(pipeline.isShakaActive()).toBe(false);
  });

  it('plays live HLS through Shaka when Shaka Player is selected', async () => {
    const load = stubShaka();
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('http://host/live/ch1.m3u8'));
    expect(video.querySelector('source')).toBeNull();
    expect(pipeline.isShakaActive()).toBe(true);
  });

  it('plays a cached HLS route through Shaka when Shaka Player is selected', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('application/vnd.apple.mpegurl');
    const load = stubShaka();
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('http://host/live/ch1'));
    expect(video.querySelector('source')).toBeNull();
  });

  it('keeps catch-up HLS on the system player', async () => {
    const load = stubShaka();
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka', true);

    pipeline.load('http://host/timeshift/ch1.m3u8', null);

    expect(video.querySelector('source')?.src).toBe('http://host/timeshift/ch1.m3u8');
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(pipeline.isShakaActive()).toBe(false);
  });

  it('logs one Shaka path event for a Shaka tune', async () => {
    stubShaka();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);

    expect(pathEvents(logSpy)).toEqual(['event=playback.path.shaka']);
    logSpy.mockRestore();
  });

  it('removes the previous native source before Shaka attaches', async () => {
    const sourcesAtAttach: string[] = [];
    const load = stubShaka({
      onAttach: video => {
        video.querySelectorAll('source').forEach(source => sourcesAtAttach.push(source.src));
        if (video.getAttribute('src')) sourcesAtAttach.push(video.getAttribute('src')!);
      },
    });
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.ts', null);
    expect(video.querySelector('source')?.src).toBe('http://host/live/ch1.ts');
    pipeline.load('http://host/live/ch2.m3u8', null);

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('http://host/live/ch2.m3u8'));
    expect(sourcesAtAttach).toEqual([]);
  });

  it.each([
    { label: 'cannot transmux', error: { severity: 2, category: 3, code: 3018 } },
    { label: 'rejects the manifest', error: { severity: 2, category: 4, code: 4032 } },
  ])('falls back to the system player when Shaka $label', async ({ error }) => {
    stubShaka({ load: () => Promise.reject(error) });
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);

    await vi.waitFor(() =>
      expect(video.querySelector('source')?.src).toBe('http://host/live/ch1.m3u8'));
    expect(video.play).toHaveBeenCalled();
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
    expect(pipeline.isShakaActive()).toBe(false);
  });

  it('falls back to the system player when Shaka cannot start', async () => {
    stubShaka({ supported: false });
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);

    await vi.waitFor(() =>
      expect(video.querySelector('source')?.src).toBe('http://host/live/ch1.m3u8'));
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
  });

  it('reports a Shaka network error instead of falling back', async () => {
    stubShaka({ load: () => Promise.reject({ severity: 2, category: 1, code: 1001 }) });
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);

    await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledOnce());
    expect(video.querySelector('source')).toBeNull();
  });

  const GUESSED = {
    videoCodec: 'hvc1.2.4.L153.B0', audioCodec: 'mp4a.40.2', hdr: null,
    frameRate: 6.25, channelsCount: 2,
  };
  const PROBED = {
    videoCodec: 'hvc1', videoRange: 'PQ', frameRate: 50, audioCodec: 'ec-3', audioLayout: '5.1',
  };
  const tsSegment = () => {
    const data = new Uint8Array(188 * 2);
    data[0] = 0x47;
    data[188] = 0x47;
    return data.buffer;
  };

  it('replaces Shaka guesses with stream info read from the first TS segment', async () => {
    tsInfoMock.parseTsInfo.mockReset().mockReturnValue(PROBED);
    const load = stubShaka({ variant: GUESSED });
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    responseFilters[0](1, { data: tsSegment() });
    responseFilters[0](1, { data: tsSegment() });

    expect(tsInfoMock.parseTsInfo).toHaveBeenCalledOnce();
    expect(pipeline.opts.onStreamInfoUpdated).toHaveBeenCalledOnce();
    expect(pipeline.streamInfo()).toEqual({
      videoCodec: 'hvc1',
      audioCodec: 'ec-3',
      videoRange: 'PQ',
      frameRate: 50,
      audioChannels: '2',
      audioLayout: '5.1',
      audioAtmos: false,
    });
  });

  it('logs the stream info it read for diagnostics', async () => {
    tsInfoMock.parseTsInfo.mockReset().mockReturnValue(PROBED);
    const load = stubShaka({ variant: GUESSED });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pipeline = await pipelineFor(videoElement(), 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    responseFilters[0](1, { data: tsSegment() });

    expect(logSpy.mock.calls.flat()).toEqual(expect.arrayContaining([
      'event=playback.shaka.stream.probed', 'range=PQ', 'fps=50', 'audio=ec-3', 'layout=5.1',
    ]));
    logSpy.mockRestore();
  });

  it('leaves non-TS segments and other request types unparsed', async () => {
    tsInfoMock.parseTsInfo.mockReset().mockReturnValue(PROBED);
    const load = stubShaka({ variant: GUESSED });
    const pipeline = await pipelineFor(videoElement(), 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    responseFilters[0](0, { data: tsSegment() });
    responseFilters[0](1, { data: new Uint8Array([0, 0, 0, 0x18]).buffer });
    responseFilters[0](1, { data: tsSegment() });

    expect(tsInfoMock.parseTsInfo).not.toHaveBeenCalled();
    expect(pipeline.streamInfo()?.audioCodec).toBe('mp4a.40.2');
  });

  it('drops the stream info read for a previous tune', async () => {
    tsInfoMock.parseTsInfo.mockReset().mockReturnValue(PROBED);
    const load = stubShaka({ variant: GUESSED });
    const pipeline = await pipelineFor(videoElement(), 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    responseFilters[0](1, { data: tsSegment() });
    pipeline.load('http://host/live/ch2.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    expect(pipeline.streamInfo()?.videoRange).toBe('');
    expect(pipeline.streamInfo()?.audioCodec).toBe('mp4a.40.2');
  });

  it('reports Shaka\'s live window as the seekable range while Shaka plays', async () => {
    const load = stubShaka();
    const video = videoElement();
    const pipeline = await pipelineFor(video, 'shaka');
    expect(pipeline.liveSeekable()).toBeNull();

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());

    const range = pipeline.liveSeekable();
    expect([range?.length, range?.start(0), range?.end(0)]).toEqual([1, 100, 400]);
  });

  it('keeps a smaller buffer for Shaka live HLS so 4K fits in TV memory', async () => {
    const load = stubShaka();
    const pipeline = await pipelineFor(videoElement(), 'shaka');

    pipeline.load('http://host/live/ch1.m3u8', null);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());

    const { CONFIG } = await import('../config');
    expect(configureCalls[0]).toMatchObject({
      streaming: {
        bufferingGoal: CONFIG.PLAYER.SHAKA_LIVE_BUFFER_AHEAD,
        bufferBehind: CONFIG.PLAYER.SHAKA_LIVE_BUFFER_BEHIND,
      },
    });
  });
});

describe('PlayerPipeline webOS mpegts.js live player', () => {
  type Listener = (...args: unknown[]) => void;

  class FakeMpegtsPlayer {
    readonly listeners = new Map<string, Listener>();
    readonly attachMediaElement = vi.fn();
    readonly load = vi.fn();
    readonly play = vi.fn();
    readonly destroy = vi.fn();
    mediaInfo: Record<string, unknown> | undefined;

    on(event: string, listener: Listener): void {
      this.listeners.set(event, listener);
    }

    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.(...args);
    }
  }

  let players: FakeMpegtsPlayer[] = [];
  const createPlayer = vi.fn((_source: { url: string }, _config?: Record<string, unknown>) => {
    const player = new FakeMpegtsPlayer();
    players.push(player);
    return player;
  });

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    players = [];
    createPlayer.mockClear();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('#EXTM3U\n')));
    vi.stubGlobal('__mpegts', {
      Events: { ERROR: 'error', MEDIA_INFO: 'media_info' },
    BaseLoader: class {},
    LoaderStatus: { kIdle: 0, kConnecting: 1, kBuffering: 2, kError: 3, kComplete: 4 },
    LoaderErrors: { EXCEPTION: 'Exception', HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid' },
      ErrorTypes: { NETWORK_ERROR: 'NetworkError', MEDIA_ERROR: 'MediaError' },
      isSupported: () => true,
      createPlayer,
    });
  });

  async function pipelineFor(video: HTMLVideoElement, catchup = false) {
    const { StorageService } = await import('../services/storage-service');
    StorageService.setLivePlayer('mpegts');
    const { PlayerPipeline } = await import('./player-pipeline');
    const opts = { ...callbacks(), isCatchup: () => catchup };
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(video);
    return Object.assign(pipeline, { opts });
  }

  it('plays live HLS through mpegts.js with its segment loader', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.m3u8', null);

    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    expect(createPlayer.mock.calls[0][0]).toEqual({ type: 'mpegts', isLive: true, url: 'http://host/live/u1/p1/101.m3u8' });
    expect(createPlayer.mock.calls[0][1]).toMatchObject({
      enableWorker: false,
      customLoader: expect.any(Function),
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 20,
      autoCleanupMinBackwardDuration: 10,
    });
    expect(players[0].attachMediaElement).toHaveBeenCalledWith(video);
    expect(players[0].load).toHaveBeenCalledOnce();
    expect(video.querySelector('source')).toBeNull();
    expect(pipeline.isMseActive()).toBe(true);
    expect(pipeline.isShakaActive()).toBe(false);
    expect(logSpy.mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.path.mpegts', 'source=hls']));
    logSpy.mockRestore();
  });

  it('plays a TS channel through mpegts.js in its worker', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.ts', null);

    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    expect(createPlayer.mock.calls[0][0].url).toBe('http://host/live/u1/p1/101.ts');
    expect(createPlayer.mock.calls[0][1]).toMatchObject({ enableWorker: true });
    expect(createPlayer.mock.calls[0][1]).not.toHaveProperty('customLoader');
  });

  it('keeps other containers on the system player', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/ch1.flv', null);

    expect(video.querySelector('source')?.src).toBe('http://host/live/ch1.flv');
    expect(logSpy.mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.skipped', 'reason=container']));
    await Promise.resolve();
    expect(createPlayer).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('keeps catch-up on the system player', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video, true);

    pipeline.load('http://host/timeshift/u1/p1/60/2024-01-01:10-00/101.ts', null);

    expect(video.querySelector('source')?.src).toBe('http://host/timeshift/u1/p1/60/2024-01-01:10-00/101.ts');
    await Promise.resolve();
    expect(createPlayer).not.toHaveBeenCalled();
  });

  it('falls back to the original URL on the system player after a media error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.m3u8', null);
    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    players[0].emit('error', 'MediaError', 'MediaMSEError');

    await vi.waitFor(() =>
      expect(video.querySelector('source')?.src).toBe('http://host/live/u1/p1/101.m3u8'));
    expect(players[0].destroy).toHaveBeenCalled();
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
    expect(pipeline.isMseActive()).toBe(false);
    expect(warnSpy.mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.fallback', 'reason=content']));
    vi.restoreAllMocks();
  });

  it('reports a network error for the normal reconnect path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.ts', null);
    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    players[0].emit('error', 'NetworkError', 'HttpStatusCodeInvalid');

    expect(pipeline.opts.onError).toHaveBeenCalledOnce();
    expect(video.querySelector('source')).toBeNull();
    vi.restoreAllMocks();
  });

  it('falls back to the system player when mpegts.js is unsupported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('__mpegts', { isSupported: () => false, createPlayer });
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.m3u8', null);

    await vi.waitFor(() =>
      expect(video.querySelector('source')?.src).toBe('http://host/live/u1/p1/101.m3u8'));
    expect(createPlayer).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('reports stream info and the buffered live window', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const video = videoElement();
    Object.defineProperty(video, 'buffered', {
      value: { length: 1, start: () => 100, end: () => 130 },
    });
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.ts', null);
    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    players[0].mediaInfo = { videoCodec: 'hvc1.2.4.L153.B0', audioCodec: 'ec-3', fps: 50, audioChannelCount: 6 };
    players[0].emit('media_info');

    expect(pipeline.opts.onStreamInfoUpdated).toHaveBeenCalledOnce();
    expect(pipeline.streamInfo()).toEqual({
      videoCodec: 'hvc1.2.4.L153.B0', audioCodec: 'ec-3', videoRange: '', frameRate: 50, audioChannels: '6',
    });
    expect(logSpy.mock.calls.flat()).toEqual(expect.arrayContaining(
      ['event=playback.mpegts.media.info', 'audioCodec=ec-3']));
    const range = pipeline.liveSeekable();
    expect([range?.start(0), range?.end(0)]).toEqual([100, 130]);
    logSpy.mockRestore();
  });

  it('destroys the mpegts.js player on the next tune', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/u1/p1/101.ts', null);
    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledOnce());
    pipeline.load('http://host/live/u1/p1/102.ts', null);

    expect(players[0].destroy).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(createPlayer).toHaveBeenCalledTimes(2));
  });
});
