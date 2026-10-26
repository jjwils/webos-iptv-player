const PACKET = 188;
const PTS_WRAP = 2 ** 33;
// A forward step this large is a hole in the stream, not a frame interval.
const JUMP_TICKS = 90000;
// The audio and video sides of one hole measure within a frame of each other.
const SNAP_TICKS = 9000;
// How far the other track may play past a one-sided jump before it is undone.
const CONFIRM_TICKS = 180000;

const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x27]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
// DVB carries AC-3, E-AC-3, AAC, and DTS as private data marked by a descriptor.
const DVB_AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b, 0x7c]);

function readTimestamp(b: Uint8Array, i: number): number {
  return (((b[i] >> 1) & 0x07) * 2 ** 30)
    + (b[i + 1] << 22) + ((b[i + 2] >> 1) << 15) + (b[i + 3] << 7) + (b[i + 4] >> 1);
}

function writeTimestamp(b: Uint8Array, i: number, value: number): void {
  const v = ((value % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  b[i] = (b[i] & 0xf1) | ((Math.floor(v / 2 ** 30) & 0x07) << 1);
  b[i + 1] = Math.floor(v / 2 ** 22) & 0xff;
  b[i + 2] = ((Math.floor(v / 2 ** 15) & 0x7f) << 1) | 1;
  b[i + 3] = Math.floor(v / 2 ** 7) & 0xff;
  b[i + 4] = ((v & 0x7f) << 1) | 1;
}

function shiftPcrBase(b: Uint8Array, i: number, offset: number): void {
  const base = b[i] * 2 ** 25 + (b[i + 1] << 17) + (b[i + 2] << 9) + (b[i + 3] << 1) + (b[i + 4] >> 7);
  const v = (((base - offset) % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
  b[i] = Math.floor(v / 2 ** 25) & 0xff;
  b[i + 1] = Math.floor(v / 2 ** 17) & 0xff;
  b[i + 2] = Math.floor(v / 2 ** 9) & 0xff;
  b[i + 3] = Math.floor(v / 2) & 0xff;
  b[i + 4] = (b[i + 4] & 0x7f) | ((v & 1) << 7);
}

function wrapDelta(delta: number): number {
  if (delta > PTS_WRAP / 2) return delta - PTS_WRAP;
  if (delta < -PTS_WRAP / 2) return delta + PTS_WRAP;
  return delta;
}

function syncOffset(data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x47 && (i + PACKET >= data.length || data[i + PACKET] === 0x47)) return i;
  }
  return data.length;
}

interface PendingJump {
  pid: number;
  value: number;
  at: number;
}

export type TimelineEvent =
  | { kind: 'jump'; ticks: number; pid: number }
  | { kind: 'undone'; ticks: number; pid: number };

// Makes a live MPEG-TS timeline continuous. Some providers' HLS segments jump
// their timestamps forward by seconds mid-segment (dropped GOPs); Shaka skips
// such a hole, while a continuous TS demuxer stalls on it and repeats audio to
// fill it. Only the program's first audio and video streams are tracked. A jump
// on one shifts that stream's later timestamps back; the matching jump on the
// other reuses the same value so they stay in sync, and a jump the other stream
// never makes is undone, since then only that stream lost data.
export class TsTimeline {
  private carry: Uint8Array = new Uint8Array(0);
  private resync = true;
  private pmtPid = -1;
  private videoPid = -1;
  private audioPid = -1;
  private offsets = new Map<number, number>();
  private lastTime = new Map<number, number>();
  private lastStep = new Map<number, number>();
  private pending: PendingJump | null = null;
  onEvent: ((event: TimelineEvent) => void) | null = null;

  // A new segment, or a retried one, starts on a packet boundary of its own.
  startSegment(): void {
    this.carry = new Uint8Array(0);
    this.resync = true;
  }

  // Returns whole packets, rewritten; a trailing partial packet waits for the next chunk.
  push(chunk: Uint8Array): Uint8Array {
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    if (this.resync || data[0] !== 0x47) {
      const start = syncOffset(data);
      if (start === data.length && data.length < PACKET * 2) {
        this.carry = data === chunk ? data.slice() : data;
        return new Uint8Array(0);
      }
      data = data.subarray(start);
      this.resync = false;
    }
    const whole = data.length - (data.length % PACKET);
    this.carry = data.slice(whole);
    const out = data.buffer === chunk.buffer ? data.slice(0, whole) : data.subarray(0, whole);
    for (let p = 0; p + PACKET <= out.length; p += PACKET) this.rewritePacket(out, p);
    return out;
  }

  private rewritePacket(b: Uint8Array, p: number): void {
    if (b[p] !== 0x47) {
      this.resync = true;
      return;
    }
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    if (pid === 0) {
      this.readPat(b, p);
      return;
    }
    if (pid === this.pmtPid) {
      this.readPmt(b, p);
      return;
    }
    // The PES may reveal a new offset, so it goes before this packet's PCR.
    this.rewritePes(b, p, pid);
    const offset = this.offsetFor(pid);
    if (((b[p + 3] >> 4) & 0x02) && b[p + 4] >= 7 && (b[p + 5] & 0x10) && offset !== 0) {
      shiftPcrBase(b, p + 6, offset);
    }
  }

  private payloadStart(b: Uint8Array, p: number): number {
    const adaptation = (b[p + 3] >> 4) & 0x03;
    if (!(b[p + 1] & 0x40) || !(adaptation & 0x01)) return -1;
    const start = adaptation === 3 ? p + 5 + b[p + 4] : p + 4;
    return start < p + PACKET ? start : -1;
  }

  private readPat(b: Uint8Array, p: number): void {
    const start = this.payloadStart(b, p);
    if (start < 0) return;
    const table = start + 1 + b[start];
    if (table + 12 > p + PACKET || b[table] !== 0x00) return;
    for (let i = table + 8; i + 4 <= table + 3 + (((b[table + 1] & 0x0f) << 8) | b[table + 2]) - 4
        && i + 4 <= p + PACKET; i += 4) {
      if (((b[i] << 8) | b[i + 1]) !== 0) {
        this.pmtPid = ((b[i + 2] & 0x1f) << 8) | b[i + 3];
        return;
      }
    }
  }

  private readPmt(b: Uint8Array, p: number): void {
    const start = this.payloadStart(b, p);
    if (start < 0) return;
    const table = start + 1 + b[start];
    if (table + 12 > p + PACKET || b[table] !== 0x02) return;
    const end = Math.min(p + PACKET, table + 3 + (((b[table + 1] & 0x0f) << 8) | b[table + 2]) - 4);
    let i = table + 12 + (((b[table + 10] & 0x0f) << 8) | b[table + 11]);
    let video = -1;
    let audio = -1;
    while (i + 5 <= end) {
      const type = b[i];
      const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
      const infoLength = ((b[i + 3] & 0x0f) << 8) | b[i + 4];
      let dvbAudio = false;
      for (let d = i + 5; d + 2 <= Math.min(end, i + 5 + infoLength); d += 2 + b[d + 1]) {
        if (DVB_AUDIO_DESCRIPTORS.has(b[d])) dvbAudio = true;
      }
      if (video < 0 && VIDEO_TYPES.has(type)) video = pid;
      if (audio < 0 && (AUDIO_TYPES.has(type) || (type === 0x06 && dvbAudio))) audio = pid;
      i += 5 + infoLength;
    }
    this.videoPid = video;
    this.audioPid = audio;
  }

  // Streams other than the tracked audio and video follow the video's offset.
  private offsetFor(pid: number): number {
    if (pid === this.videoPid || pid === this.audioPid) return this.offsets.get(pid) ?? 0;
    return this.offsets.get(this.videoPid >= 0 ? this.videoPid : this.audioPid) ?? 0;
  }

  private rewritePes(b: Uint8Array, p: number, pid: number): void {
    const i = this.payloadStart(b, p);
    if (i < 0 || i + 9 > p + PACKET || b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) return;
    const streamId = b[i + 3];
    if (streamId < 0xbd || streamId === 0xbe || streamId === 0xbf) return;
    const flags = b[i + 7] >> 6;
    if (!(flags & 0x02)) return;
    const hasDts = (flags & 0x01) !== 0;
    const ptsAt = i + 9;
    if (ptsAt + (hasDts ? 10 : 5) > p + PACKET) return;
    // DTS rises steadily under B-frame reordering, unlike PTS.
    const time = readTimestamp(b, hasDts ? ptsAt + 5 : ptsAt);
    const tracked = pid === this.videoPid || pid === this.audioPid;
    let offset = this.offsetFor(pid);

    if (tracked) {
      let shifted = wrapDelta(time - offset);
      const last = this.lastTime.get(pid);
      if (last !== undefined) {
        const delta = wrapDelta(shifted - last);
        const step = this.lastStep.get(pid) ?? 0;
        if (delta - step > JUMP_TICKS) {
          const jump = this.jumpFor(pid, delta - step, last + step);
          offset += jump;
          this.offsets.set(pid, offset);
          shifted -= jump;
          this.onEvent?.({ kind: 'jump', ticks: jump, pid });
        } else if (delta > 0 && delta < JUMP_TICKS) {
          this.lastStep.set(pid, delta);
        }
      }
      this.lastTime.set(pid, shifted);
      this.checkPending(pid, shifted);
      offset = this.offsets.get(pid) ?? 0;
    }
    if (offset === 0) return;
    writeTimestamp(b, ptsAt, readTimestamp(b, ptsAt) - offset);
    if (hasDts) writeTimestamp(b, ptsAt + 5, readTimestamp(b, ptsAt + 5) - offset);
  }

  private jumpFor(pid: number, measured: number, at: number): number {
    const pending = this.pending;
    if (pending && pending.pid !== pid && Math.abs(pending.value - measured) < SNAP_TICKS) {
      this.pending = null;
      return pending.value;
    }
    // With a single tracked stream there is no partner to wait for.
    if (this.videoPid >= 0 && this.audioPid >= 0) this.pending = { pid, value: measured, at };
    return measured;
  }

  private checkPending(pid: number, time: number): void {
    const pending = this.pending;
    if (!pending || pending.pid === pid) return;
    if (wrapDelta(time - pending.at) <= CONFIRM_TICKS) return;
    this.pending = null;
    this.offsets.set(pending.pid, (this.offsets.get(pending.pid) ?? 0) - pending.value);
    const last = this.lastTime.get(pending.pid);
    if (last !== undefined) this.lastTime.set(pending.pid, last + pending.value);
    this.onEvent?.({ kind: 'undone', ticks: pending.value, pid: pending.pid });
  }
}
