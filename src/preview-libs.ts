// The desktop preview exposes hls.js through a global.
// This file is NOT loaded on webOS
import Hls from 'hls.js';

(window as unknown as Record<string, unknown>).__Hls = Hls;
