import { describe, expect, it, vi } from 'vitest';
import { createMpegtsEngine, type MpegtsMediaInfo } from './mpegts-engine';

function engineWith(info: MpegtsMediaInfo | null, ranges: Array<[number, number]> = [], liveDelay?: number) {
  const player = { destroy: vi.fn() };
  const video = {
    buffered: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] },
  } as unknown as HTMLVideoElement;
  return {
    engine: createMpegtsEngine(player, video, () => info, liveDelay === undefined ? undefined : () => liveDelay),
    player,
  };
}

describe('mpegts.js engine', () => {
  it('has no stream info until mpegts.js parses the first frames', () => {
    expect(engineWith(null).engine.streamInfo()).toBeNull();
    expect(engineWith({ fps: 50 }).engine.streamInfo()).toBeNull();
  });

  it('spans the live window from the oldest to the newest buffered range', () => {
    expect(engineWith(null).engine.seekRange?.()).toBeNull();
    expect(engineWith(null, [[10, 20], [21, 40]]).engine.seekRange?.()).toEqual({ start: 10, end: 40 });
  });

  it('puts live the loader\'s starting delay behind the newest HLS media', () => {
    expect(engineWith(null, [[10, 60]], 25).engine.seekRange?.()).toEqual({ start: 10, end: 35 });
    expect(engineWith(null, [[10, 20]], 25).engine.seekRange?.()).toEqual({ start: 10, end: 10 });
  });

  it('exposes no renditions and destroys its player', () => {
    const { engine, player } = engineWith(null);
    expect(engine.audioOptions()).toEqual([]);
    expect(engine.setAudioTrack(0)).toBe(false);
    expect(engine.subtitleOptions()).toEqual([]);
    engine.destroy();
    expect(player.destroy).toHaveBeenCalledOnce();
  });
});
