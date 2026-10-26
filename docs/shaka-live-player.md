# Shaka Player and mpegts.js for live TV

**Settings → Advanced → Live player** picks how live channels play on webOS:

| Option | Path |
|---|---|
| System player (default) | The webOS native media pipeline, as before |
| Shaka Player | Shaka over MSE: Shaka downloads the HLS segments, transmuxes MPEG-TS to fragmented MP4, and feeds the TV's hardware decoder |
| mpegts.js | mpegts.js over MSE: HLS segments, or a TS stream, fed through one continuous MPEG-TS transmuxer |

The setting applies from the next tune. Shaka changes live HLS; mpegts.js
changes live HLS and MPEG-TS. Everything else, including DASH, catch-up, and
VOD, keeps its existing path, and the desktop preview always uses its MSE
libraries.

## Why

Some TVs play a live HLS channel badly through the native pipeline even
though their decoders handle every elementary stream in it. The reference
case is a 4K50 HDR10 HEVC channel whose only audio is DVB E-AC-3 (Dolby
Digital Plus) in MPEG-TS, on a 2021 webOS 6 TV without Dolby Atmos decoding:

| Path | Result |
|---|---|
| System player | Stutters |
| hls.js | Rejects the stream ("Unsupported EC-3 in M2TS") |
| mpegts.js 1.8.2 as published | Plays silently; it recognizes ATSC E-AC-3 (stream type 0x87) only |
| Shaka Player | Smooth, with sound, 0 dropped frames |

Shaka's TS parser accepts both DVB (stream type 0x06 with descriptor 0x7a)
and ATSC E-AC-3, and the TV's MSE accepts `audio/mp4; codecs="ec-3"`.

## Implementation notes

- **Full build.** The package ships Shaka's standard ES5
  `shaka-player.compiled.js` (HLS and DASH) instead of the DASH-only build.
  It is still loaded on demand, so the system player pays no startup or
  memory cost. `scripts/shaka-compat-gate.mjs` pins every post-Chromium-53
  API the bundle calls and the polyfill Shaka installs for each.
- **Transmuxer worker.** Transmuxing runs in
  `js/shaka-player.transmuxer-worker.js` (`mediaSource.transmuxWorkerUrl`)
  to keep the UI thread free; on the main thread the renderer sat at ~100%
  CPU and stuttered even at 1080p. Shaka installs its Map upsert polyfills
  on the page only, while the worker calls `Map.prototype.getOrInsertComputed`
  (Chrome 145+), so every segment failed with error 3018
  (`TRANSMUXING_FAILED`). `prepareShakaWorker()` prepends the polyfill and
  gates the worker's API use at build time.
- **Live position.** Shaka keeps the playhead inside its own live seek range.
  `Player.reconcileLiveDvrPosition` steps aside while Shaka is active
  (`PlayerPipeline.isShakaActive()`); otherwise the two seek against each
  other every second or two.
  Shaka also never sets a live seekable range on the MediaSource, so
  `video.seekable` follows the buffer as it grows and is evicted. The
  timeshift bar, rewind, and go-to-live use Shaka's `seekRange()` instead
  (`PlayerPipeline.liveSeekable()`).
- **Fallback.** If Shaka cannot start, or rejects the stream's content
  (a media or manifest error, such as a codec its transmuxer lacks), the same
  tune reloads on the system player (`event=playback.shaka.fallback`).
  Network errors take the normal reconnect path.
- **Source element.** Shaka attaches through its own `<source>`, so the
  pipeline removes a `<source>` left by a previous native tune first;
  otherwise the browser keeps playing the old channel.
- **Stream info.** Shaka fills its variant tracks from the playlist, and
  when the playlist omits `CODECS`, `VIDEO-RANGE`, `FRAME-RATE`, or `CHANNELS`
  it guesses from the first segment: HDR and channel layout stay unknown, and
  its frame rate divides by the gap between the first two frames in decode
  order, which B-frames make 8× too low. A response filter therefore reads
  the first TS segment itself (`src/parsers/ts-info.ts`): the HEVC SPS VUI
  transfer characteristics (and the preferred-transfer SEI) for HDR10/HLG,
  Dolby Vision RPU NAL units, the display-order frame rate, and the
  E-AC-3/AC-3/AAC channel layout. The OSD prefers these values and shows the
  layout (5.1, 7.1) after the audio codec
  (`event=playback.shaka.stream.probed`). The webOS media service exposes no
  stream details for MSE pipelines, so the segment is the only source.
- **Memory.** The TV renderer shares about 1.3 GB with the system. With a
  30 s buffer ahead and Shaka's default 30 s behind, 4K playback held the
  renderer near 400 MB with the system out of free memory, and webOS killed
  the app after some minutes. Shaka live HLS buffers
  `CONFIG.PLAYER.SHAKA_LIVE_BUFFER_AHEAD` (20 s) ahead and
  `SHAKA_LIVE_BUFFER_BEHIND` (10 s) behind.
- **Latency.** Shaka buffers ahead (`CONFIG.PLAYER.BUFFER_LENGTH`) and starts
  behind the live edge, so live playback runs further behind real time than
  the system player.

## mpegts.js

Shaka downloads each HLS segment whole and holds several copies of it while
it transmuxes; on a 4K channel the renderer reached 340–450 MB, against
about 250 MB with mpegts.js, on a TV with 1.3 GB.

- **Patched bundle.** The published mpegts.js drops this audio, so the build
  ships `js/mpegts.js` patched by `scripts/mpegts-patch.mjs`:
  - DVB AC-3 and E-AC-3 (stream type 0x06 with descriptor 0x6a or 0x7a) are
    recognized; upstream has this branch commented out.
  - An E-AC-3-only program counts as having audio.
  - Dependent E-AC-3 substreams (7.1) join their independent frame as one
    sample instead of doubling the audio; one that a PES boundary cuts off
    from its frame is skipped rather than timed as a frame of its own. The
    `dec3` box still signals no dependent substreams, so the container
    describes 5.1; decoders read the layout from the bitstream.
  - The `dec3` data rate and the sample duration are computed correctly.

  Each patch must match the bundle exactly once, so an upgrade that moves
  the code fails the build. `scripts/mpegts-patch.test.mjs` runs the patched
  library against a synthetic DVB E-AC-3 stream.
- **HLS.** mpegts.js reads only a continuous stream, so
  `src/services/mpegts-hls-loader.ts` feeds it the HLS segments as one: it
  takes the highest-bandwidth variant, starts three segments behind the live
  edge, streams each segment's body through as it arrives, reloads the
  playlist when it runs out, and jumps back near the live edge if it falls
  out of the window (`event=playback.mpegts.hls.behind`) or the media
  sequence restarts (`event=playback.mpegts.hls.reset`). Each segment, and
  each retry, starts on its own packet boundary, so a truncated segment
  cannot misalign the next. While paused it stops downloading once the
  buffer runs 10 s past its starting live delay, so 4K cannot fill the
  SourceBuffer. A provider's separate `.ts` output for the same channel can
  be missing segments the HLS playlist has.
- **Timestamp gaps.** Some providers' segments jump their timestamps forward
  by seconds mid-segment. Shaka skips such a hole; a continuous demuxer
  stalls on it, then repeats the last E-AC-3 frame to fill the audio, which
  sounds like rapid clicking. `src/services/ts-timeline.ts` closes each jump
  as the bytes stream in, shifting later PTS, DTS, and PCR back by the jump,
  and reuses the jump the other stream measured so audio stays on video
  (`event=playback.mpegts.hls.gap`). It tracks only the first audio and
  video streams in the PMT; other streams follow the video. A jump the other
  stream does not make within 2 s means only that stream lost data, so it
  is undone (`event=playback.mpegts.hls.gap.undone`). A stream that is
  really missing content still runs dry and waits for the next segment.
- **Main thread.** A custom loader cannot be passed into mpegts.js's worker,
  so HLS transmuxes on the main thread; 4K50 plays with no dropped frames
  and the UI stays responsive. A TS URL keeps mpegts.js's worker.
- **Memory.** mpegts.js keeps three minutes behind the playhead by default.
  The pipeline evicts down to `CONFIG.PLAYER.MPEGTS_BUFFER_BEHIND_MIN` (10 s)
  once `MPEGTS_BUFFER_BEHIND_MAX` (20 s) sits behind it.
- **Live window.** The timeshift bar spans the buffered media, since mpegts.js
  keeps no playlist window to seek into. HLS arrives a segment at a time, so
  live sits the loader's starting delay (three segments) behind the newest
  buffered media; Go to Live then keeps that much in hand.
- **Fallback.** A media error (`event=playback.mpegts.fallback`) or a TV
  without MSE support reloads the original URL on the system player; network
  errors take the normal reconnect path. Containers other than HLS and TS
  stay on the system player (`event=playback.mpegts.skipped`).
- **Stream info.** The OSD shows the codecs, frame rate, and channel count
  that mpegts.js reports (`event=playback.mpegts.media.info`); it reports no
  HDR format.
