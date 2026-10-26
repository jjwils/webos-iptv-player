// Build-time fixes for the minified mpegts.js bundle. Each patch must match
// exactly once, so an upgrade that moves the code fails the build instead of
// shipping a silent stream. The bundle builds its worker from its own source,
// so these apply to the transmuxer worker too.
const PATCHES = [
  {
    name: 'DVB AC-3 and E-AC-3 descriptors',
    // Stream type 0x06 carries DVB (E-)AC-3, marked by descriptor 0x6a or 0x7a;
    // upstream ships this branch commented out, so the audio PID is dropped.
    find: 'if(5===y){var E=String.fromCharCode',
    replace: 'if((106===y||122===y)&&!g)106===y?d.common_pids.ac3=f:d.common_pids.eac3=f;'
      + 'else if(5===y){var E=String.fromCharCode',
  },
  {
    name: 'E-AC-3 marks the program as having audio',
    find: 'd.common_pids.ac3||d.common_pids.opus||d.common_pids.mp3)&&(this.has_audio_=!0)',
    replace: 'd.common_pids.ac3||d.common_pids.eac3||d.common_pids.opus||d.common_pids.mp3)&&(this.has_audio_=!0)',
  },
  {
    name: 'E-AC-3 dependent substreams join their independent frame',
    // A 7.1 stream follows each independent syncframe with a dependent one;
    // read separately, each would become its own sample and double the audio.
    find: 'n=(a.readBits(2),a.readBits(3),a.readBits(11)+1<<1),',
    replace: 'n=(a.readBits(2),a.readBits(3),a.readBits(11)+1<<1);'
      + 'for(;i+n+4<=e.byteLength&&2935==(e[i+n]<<8|e[i+n+1])&&e[i+n+2]>>6==1;)'
      + 'n+=((7&e[i+n+2])<<8|e[i+n+3])+1<<1;'
      // One cut off from its frame by a PES boundary is skipped, not timed as a frame of its own.
      + 'if(e[i+2]>>6==1){if(i+n>this.data_.byteLength){this.eof_flag_=!0,this.has_last_incomplete_data=!0;break}'
      + 'this.current_syncword_offset_=this.findNextSyncwordOffset(i+n),a.destroy();continue}var ',
  },
  {
    name: 'E-AC-3 dec3 data rate',
    // Upstream masks before shifting (operator precedence) and divides by the
    // wrong block size; data_rate is kbit/s across 256-sample blocks.
    find: 'i=Math.floor(e.frame_size*e.sampling_frequency/(16*e.num_blks));t=[255&i,248&i,',
    replace: 'i=Math.floor(e.frame_size*e.sampling_frequency/(32e3*e.num_blks));t=[i>>5&255,(31&i)<<3,',
  },
  {
    name: 'E-AC-3 sample duration',
    find: 'i=1536/s.sampling_frequency*1e3;var _={codec:"ec-3",data:s}',
    replace: 'i=256*s.num_blks/s.sampling_frequency*1e3;var _={codec:"ec-3",data:s}',
  },
];

function count(haystack, needle) {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

export function patchMpegts(code) {
  let out = code;
  for (const patch of PATCHES) {
    if (count(out, patch.find) !== 1) {
      throw new Error(`mpegts.js patch "${patch.name}" no longer matches the bundle exactly once.`);
    }
    out = out.replace(patch.find, () => patch.replace);
  }
  return out;
}
