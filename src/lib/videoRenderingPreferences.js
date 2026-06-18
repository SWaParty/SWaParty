export const VIDEO_RENDERING_PREFERENCE_CHANGED_EVENT = 'swaparty:video-rendering-preference-changed';

const GPU_VIDEO_RENDERING_STORAGE_KEY = 'swaparty.video.gpu_rendering.enabled.v1';
const DEFAULT_GPU_VIDEO_RENDERING_ENABLED = false;

function canUseStorage() {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function normalizeBoolean(value, fallback = DEFAULT_GPU_VIDEO_RENDERING_ENABLED) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

export function readGpuVideoRenderingPreference() {
  if (!canUseStorage()) return DEFAULT_GPU_VIDEO_RENDERING_ENABLED;

  try {
    return normalizeBoolean(window.localStorage.getItem(GPU_VIDEO_RENDERING_STORAGE_KEY));
  } catch {
    return DEFAULT_GPU_VIDEO_RENDERING_ENABLED;
  }
}

export function writeGpuVideoRenderingPreference(enabled) {
  const nextEnabled = Boolean(enabled);

  if (canUseStorage()) {
    try {
      window.localStorage.setItem(GPU_VIDEO_RENDERING_STORAGE_KEY, nextEnabled ? '1' : '0');
    } catch {
      // Preference persistence is best-effort only.
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(VIDEO_RENDERING_PREFERENCE_CHANGED_EVENT, {
      detail: { gpuVideoRenderingEnabled: nextEnabled },
    }));
  }

  return nextEnabled;
}

export function subscribeGpuVideoRenderingPreference(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') return () => {};

  const handlePreferenceChange = (event) => {
    listener(Boolean(event?.detail?.gpuVideoRenderingEnabled));
  };

  window.addEventListener(VIDEO_RENDERING_PREFERENCE_CHANGED_EVENT, handlePreferenceChange);
  return () => {
    window.removeEventListener(VIDEO_RENDERING_PREFERENCE_CHANGED_EVENT, handlePreferenceChange);
  };
}

function detectWebGL() {
  if (typeof document === 'undefined') {
    return { hasWebGL: false, renderer: '' };
  }

  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { hasWebGL: false, renderer: '' };

    let renderer = '';
    try {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');
      }
    } catch {
      renderer = '';
    }

    return { hasWebGL: true, renderer };
  } catch {
    return { hasWebGL: false, renderer: '' };
  } finally {
    canvas = null;
  }
}

async function detectMediaDecodingCapability() {
  if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) {
    return null;
  }

  try {
    return await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="avc1.42E01E"',
        width: 1920,
        height: 1080,
        bitrate: 5_000_000,
        framerate: 30,
      },
    });
  } catch {
    return null;
  }
}

export async function detectGpuVideoRenderingSupport() {
  const { hasWebGL, renderer } = detectWebGL();
  const hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  const decodingInfo = await detectMediaDecodingCapability();

  return {
    hasWebGL,
    hasWebGPU,
    renderer,
    mediaCapabilitiesAvailable: typeof navigator !== 'undefined' && Boolean(navigator.mediaCapabilities?.decodingInfo),
    decodingInfo,
    canUseGpuCompositing: hasWebGL || hasWebGPU,
  };
}
