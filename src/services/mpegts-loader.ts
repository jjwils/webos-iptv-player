import { createLogger } from '../utils/logger';

const log = createLogger('Mpegts');
const MPEGTS_SCRIPT = 'js/mpegts.js';

type MpegtsNamespace = typeof import('mpegts.js').default;

interface MpegtsWindow extends Window {
  __mpegts?: MpegtsNamespace;
  mpegts?: MpegtsNamespace;
}

let scriptPromise: Promise<MpegtsNamespace> | null = null;

// The build ships a patched mpegts.js (scripts/mpegts-patch.mjs), loaded on demand.
export function loadMpegts(): Promise<MpegtsNamespace> {
  const scope = window as MpegtsWindow;
  const existing = scope.__mpegts ?? scope.mpegts;
  if (existing) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;

  const pending = new Promise<MpegtsNamespace>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MPEGTS_SCRIPT;
    script.async = true;
    script.onload = () => {
      const loaded = scope.mpegts;
      if (!loaded) {
        reject(new Error('mpegts.js script loaded without exposing its namespace'));
        return;
      }
      scope.__mpegts = loaded;
      resolve(loaded);
    };
    script.onerror = () => reject(new Error('Failed to load the mpegts.js bundle'));
    document.head.appendChild(script);
  });
  const result = pending.catch(error => {
    scriptPromise = null;
    log.warn('mpegts.js bundle load failed', error);
    throw error;
  });
  scriptPromise = result;
  return result;
}
