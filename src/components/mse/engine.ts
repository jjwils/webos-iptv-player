import type { AudioOption, SubtitleOption } from '../../types';

export interface PipelineStreamInfo {
  videoCodec: string;
  audioCodec: string;
  videoRange: string;
  frameRate: number;
  audioChannels: string;
  audioAtmos?: boolean;
  // "<main>.<lfe>" read from the stream, e.g. "5.1".
  audioLayout?: string;
}

// The desktop preview plays through an MSE library — hls.js or Shaka — which
// then owns the audio/text renditions. Both are reached through this one
// interface so the track code stays engine-agnostic.
export interface MseEngine {
  audioOptions(): AudioOption[];
  setAudioTrack(index: number): boolean;
  subtitleOptions(): SubtitleOption[];
  setSubtitleTrack(index: number): boolean;
  streamInfo(): PipelineStreamInfo | null;
  // The library's own live window, when it keeps one apart from video.seekable.
  seekRange?(): { start: number; end: number } | null;
  destroy(): void | Promise<void>;
}
