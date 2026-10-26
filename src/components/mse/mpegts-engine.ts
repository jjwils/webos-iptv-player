import type { MseEngine, PipelineStreamInfo } from './engine';

export interface MpegtsMediaInfo {
  videoCodec?: string | null;
  audioCodec?: string | null;
  fps?: number | null;
  audioChannelCount?: number | null;
}

export interface MpegtsPlayerLike {
  destroy(): void;
}

// mpegts.js plays one program with one audio stream, so there are no
// renditions to pick; it reports codecs once the first frames are parsed.
export function createMpegtsEngine(
  player: MpegtsPlayerLike,
  video: HTMLVideoElement,
  mediaInfo: () => MpegtsMediaInfo | null,
  // Seconds the newest buffered media runs ahead of the live point.
  liveDelay: () => number = () => 0,
): MseEngine {
  return {
    audioOptions: () => [],
    setAudioTrack: () => false,
    subtitleOptions: () => [],
    setSubtitleTrack: () => false,
    streamInfo(): PipelineStreamInfo | null {
      const info = mediaInfo();
      if (!info?.videoCodec && !info?.audioCodec) return null;
      return {
        videoCodec: info.videoCodec || '',
        audioCodec: info.audioCodec || '',
        videoRange: '',
        frameRate: info.fps || 0,
        audioChannels: info.audioChannelCount ? String(info.audioChannelCount) : '',
      };
    },
    // A live MediaSource reports seekable from 0, long after the start was
    // evicted. HLS arrives a segment at a time, so live sits the loader's
    // starting delay behind the newest buffered media.
    seekRange() {
      const buffered = video.buffered;
      if (!buffered.length) return null;
      const start = buffered.start(0);
      return { start, end: Math.max(start, buffered.end(buffered.length - 1) - liveDelay()) };
    },
    destroy(): void {
      player.destroy();
    },
  };
}
