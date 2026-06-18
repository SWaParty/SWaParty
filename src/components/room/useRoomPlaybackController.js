import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import {
  chooseAutoPlaybackSource,
  estimateAvailableBandwidthMbps,
} from './playerQuality';

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function getEffectivePlaybackTime(playback) {
  const baseTime = Math.max(0, Number(playback?.currentTimeSec || 0) || 0);
  if (!playback || playback.paused !== false) return baseTime;
  const updatedAt = Number(playback.updatedAt || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return baseTime;
  const elapsedSec = Math.max(0, (Date.now() / 1000) - updatedAt);
  const rate = clampNumber(playback.playbackRate || 1, 0.5, 4);
  const duration = Number(playback.durationSec || 0);
  const effectiveTime = baseTime + elapsedSec * rate;
  return Number.isFinite(duration) && duration > 0
    ? Math.min(effectiveTime, duration)
    : effectiveTime;
}

function getNowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isHlsPlaybackSource(source) {
  const value = String(source || '').trim();
  if (!value) return false;
  try {
    return new URL(value, window.location.href).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return value.toLowerCase().includes('.m3u8');
  }
}

function canPlayHlsNatively(video) {
  return Boolean(
    video?.canPlayType('application/vnd.apple.mpegurl')
      || video?.canPlayType('application/x-mpegURL'),
  );
}

function destroyHlsInstance(hlsRef) {
  if (!hlsRef.current) return;
  hlsRef.current.destroy();
  hlsRef.current = null;
}

export function useRoomPlaybackController({
  selectedMediaItem,
  availableQualityOptions,
  addMessage,
  userName,
  onPlaybackEvent,
  canBroadcastPlayback = true,
}) {
  const [primaryVideoSrc, setPrimaryVideoSrc] = useState('');
  const [secondaryVideoSrc, setSecondaryVideoSrc] = useState('');
  const [activeVideoSlot, setActiveVideoSlot] = useState('primary');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlayerFullscreen, setIsPlayerFullscreen] = useState(false);
  const [isPlayerBuffering, setIsPlayerBuffering] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [playerQualityKey, setPlayerQualityKey] = useState('playerQualityAuto');
  const [playbackSources, setPlaybackSources] = useState({});
  const [qualitySwitchState, setQualitySwitchState] = useState(null);
  const [qualitySwitchToastVisible, setQualitySwitchToastVisible] = useState(false);
  const [qualitySwitchPreservePlayState, setQualitySwitchPreservePlayState] = useState(null);

  const primaryVideoRef = useRef(null);
  const secondaryVideoRef = useRef(null);
  const primaryHlsRef = useRef(null);
  const secondaryHlsRef = useRef(null);
  const hlsLoadSeqRef = useRef({ primary: 0, secondary: 0 });
  const playerShellRef = useRef(null);
  const qualitySwitchTimerRef = useRef(null);
  const qualitySwitchHideTimerRef = useRef(null);
  const qualitySwitchRequestRef = useRef(null);
  const suppressedVideoEventsRef = useRef(new Map());
  const handleVideoErrorRef = useRef(null);
  const lastSeekEventAtRef = useRef(0);
  const lastTimeStateUpdateAtRef = useRef(0);
  const bufferFallbackTimerRef = useRef(null);
  const suppressBufferUntilRef = useRef(0);
  const suppressMountMediaEventsUntilRef = useRef(0);
  const pendingExternalPlaybackRef = useRef(null);
  const applyExternalPlaybackStateRef = useRef(null);
  const playbackEndedRef = useRef(false);
  const playbackEndedBroadcastedRef = useRef(false);
  const preferredQualityKeyRef = useRef('playerQualityAuto');

  const currentVideoSrc = activeVideoSlot === 'primary' ? primaryVideoSrc : secondaryVideoSrc;

  const suppressVideoEvent = useCallback((slot, eventName, ttlMs = 900) => {
    suppressedVideoEventsRef.current.set(`${slot}:${eventName}`, getNowMs() + ttlMs);
  }, []);

  const suppressVideoEvents = useCallback((slot, events, ttlMs = 900) => {
    events.forEach((eventName) => {
      suppressVideoEvent(slot, eventName, ttlMs);
    });
  }, [suppressVideoEvent]);

  const consumeSuppressedVideoEvent = useCallback((slot, eventName) => {
    const eventKey = `${slot}:${eventName}`;
    const expiresAt = suppressedVideoEventsRef.current.get(eventKey);
    if (!expiresAt) return false;
    suppressedVideoEventsRef.current.delete(eventKey);
    return getNowMs() <= expiresAt;
  }, []);

  const getActiveVideoElement = useCallback(() => (
    activeVideoSlot === 'primary' ? primaryVideoRef.current : secondaryVideoRef.current
  ), [activeVideoSlot]);

  const showQualitySwitchToast = useCallback((status, label) => {
    setQualitySwitchState({ status, label });
    setQualitySwitchToastVisible(true);
    if (qualitySwitchTimerRef.current) {
      window.clearTimeout(qualitySwitchTimerRef.current);
      qualitySwitchTimerRef.current = null;
    }
    if (qualitySwitchHideTimerRef.current) {
      window.clearTimeout(qualitySwitchHideTimerRef.current);
      qualitySwitchHideTimerRef.current = null;
    }
    const durationMs = status === 'switching' ? 0 : 1600;
    if (durationMs > 0) {
      qualitySwitchTimerRef.current = window.setTimeout(() => {
        setQualitySwitchToastVisible(false);
        qualitySwitchHideTimerRef.current = window.setTimeout(() => {
          setQualitySwitchState(null);
          qualitySwitchHideTimerRef.current = null;
        }, 260);
        qualitySwitchTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  useEffect(() => () => {
    if (qualitySwitchTimerRef.current) window.clearTimeout(qualitySwitchTimerRef.current);
    if (qualitySwitchHideTimerRef.current) window.clearTimeout(qualitySwitchHideTimerRef.current);
    if (bufferFallbackTimerRef.current) window.clearTimeout(bufferFallbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (availableQualityOptions.length === 0) return;
    if (!availableQualityOptions.some((option) => option.key === playerQualityKey)) {
      const fallbackQualityKey = availableQualityOptions[0]?.key || 'playerQualityAuto';
      preferredQualityKeyRef.current = fallbackQualityKey;
      setPlayerQualityKey(fallbackQualityKey);
    }
  }, [availableQualityOptions, playerQualityKey]);

  useEffect(() => {
    const video = getActiveVideoElement();
    if (!video) return;
    video.volume = volume;
    video.playbackRate = speed;
  }, [getActiveVideoElement, speed, volume, currentVideoSrc]);

  const mountPlaybackSource = useCallback(({
    source,
    sources = {},
    qualityKey = 'playerQualityAuto',
    durationSec = 0,
    mediaItem = null,
  }) => {
    const preferredQualityKey = preferredQualityKeyRef.current;
    const hasPreferredQuality = preferredQualityKey && preferredQualityKey !== 'playerQualityAuto' && sources?.[preferredQualityKey];
    const autoPlayback = !hasPreferredQuality && qualityKey === 'playerQualityAuto'
      ? chooseAutoPlaybackSource(mediaItem || selectedMediaItem, sources)
      : null;
    const nextQualityKey = hasPreferredQuality ? preferredQualityKey : qualityKey;
    const nextSource = hasPreferredQuality ? sources[preferredQualityKey] : (autoPlayback?.source || source);
    suppressMountMediaEventsUntilRef.current = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 700;
    suppressVideoEvents('primary', ['pause', 'seek', 'buffer'], 900);
    suppressVideoEvents('secondary', ['pause', 'seek', 'buffer'], 900);
    setActiveVideoSlot('primary');
    setPrimaryVideoSrc(nextSource || '');
    setSecondaryVideoSrc('');
    setPlaybackSources(sources);
    setPlayerQualityKey(nextQualityKey);
    setCurrentTime(0);
    setDuration(Number(durationSec || 0) || 0);
    setIsPlaying(false);
    setIsPlayerBuffering(false);
    playbackEndedRef.current = false;
    playbackEndedBroadcastedRef.current = false;
    setQualitySwitchPreservePlayState(null);
    qualitySwitchRequestRef.current = null;
    if (primaryVideoRef.current) {
      primaryVideoRef.current.pause();
      primaryVideoRef.current.load();
    }
  }, [selectedMediaItem, suppressVideoEvents]);

  const resetPlaybackSource = useCallback(() => {
    suppressMountMediaEventsUntilRef.current = getNowMs() + 900;
    suppressVideoEvents('primary', ['pause', 'seek', 'buffer'], 900);
    suppressVideoEvents('secondary', ['pause', 'seek', 'buffer'], 900);
    [primaryVideoRef.current, secondaryVideoRef.current].forEach((video) => {
      if (!video) return;
      try {
        video.pause();
        video.currentTime = 0;
        video.removeAttribute('src');
        video.load();
      } catch {
        // Best effort cleanup before leaving the room.
      }
    });
    destroyHlsInstance(primaryHlsRef);
    destroyHlsInstance(secondaryHlsRef);
    setPrimaryVideoSrc('');
    setSecondaryVideoSrc('');
    setPlaybackSources({});
    setActiveVideoSlot('primary');
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsPlayerBuffering(false);
    playbackEndedRef.current = false;
    playbackEndedBroadcastedRef.current = false;
    setQualitySwitchPreservePlayState(null);
    qualitySwitchRequestRef.current = null;
    pendingExternalPlaybackRef.current = null;
  }, [suppressVideoEvents]);

  const togglePlay = useCallback(async () => {
    const video = getActiveVideoElement();
    if (!video) return null;
    try {
      if (video.paused) {
        const atEnd = video.ended || (
          Number.isFinite(video.duration)
          && video.duration > 0
          && video.currentTime >= video.duration - 0.25
        );
        if (atEnd) {
          suppressVideoEvent(activeVideoSlot, 'seek');
          suppressVideoEvent(activeVideoSlot, 'buffer');
          video.currentTime = 0;
          setCurrentTime(0);
          playbackEndedRef.current = false;
          playbackEndedBroadcastedRef.current = false;
        }
        if (volume > 0) {
          video.muted = false;
        }
        video.volume = volume;
        await video.play();
        return true;
      }
      video.pause();
      return false;
    } catch (error) {
      console.error(t('room.playbackExceptionLog'), error);
      addMessage({ type: 'system', kind: 'error', text: t('room.playbackFailed') });
      return null;
    }
  }, [activeVideoSlot, addMessage, getActiveVideoElement, suppressVideoEvent, volume]);

  const handleSeek = useCallback((value) => {
    const video = getActiveVideoElement();
    if (!video) return;
    const max = Number(video.duration || duration || 0);
    const raw = Number(value);
    const next = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), max || 0);
    video.currentTime = next;
    setCurrentTime(next);
  }, [duration, getActiveVideoElement]);

  const handleVolumeChange = useCallback((value) => {
    const video = getActiveVideoElement();
    if (!video) return;
    const next = clampNumber(value, 0, 1);
    video.volume = next;
    setVolume(next);
  }, [getActiveVideoElement]);

  const toggleMute = useCallback(() => {
    const video = getActiveVideoElement();
    if (!video) return;
    const next = volume > 0 ? 0 : 1;
    video.volume = next;
    setVolume(next);
  }, [getActiveVideoElement, volume]);

  const handleSpeedChange = useCallback((value) => {
    const next = clampNumber(value, 0.5, 4);
    const video = getActiveVideoElement();
    if (video) video.playbackRate = next;
    setSpeed(next);
    onPlaybackEvent?.('rate', {
      currentTimeSec: Number.isFinite(video?.currentTime) ? video.currentTime : currentTime,
      playbackRate: next,
    });
  }, [currentTime, getActiveVideoElement, onPlaybackEvent]);

  const handleQualityChange = useCallback((nextQualityKey) => {
    const autoPlayback = nextQualityKey === 'playerQualityAuto'
      ? chooseAutoPlaybackSource(selectedMediaItem, playbackSources)
      : null;
    const nextSource = autoPlayback?.source || playbackSources[nextQualityKey];
    if (!nextSource) return;
    preferredQualityKeyRef.current = nextQualityKey;

    const activeVideo = getActiveVideoElement();
    const nextTime = activeVideo?.currentTime ?? currentTime;
    const shouldResume = Boolean(activeVideo && !activeVideo.paused);
    const nextLabel = availableQualityOptions.find((option) => option.key === nextQualityKey)?.label || t('room.playerQualityAuto');
    const standbySlot = activeVideoSlot === 'primary' ? 'secondary' : 'primary';

    qualitySwitchRequestRef.current = {
      slot: standbySlot,
      qualityKey: nextQualityKey,
      label: nextLabel,
      source: nextSource,
      currentTime: nextTime,
      shouldResume,
    };

    setQualitySwitchPreservePlayState(shouldResume);
    showQualitySwitchToast('switching', nextLabel);
    if (standbySlot === 'primary') {
      setPrimaryVideoSrc(nextSource);
    } else {
      setSecondaryVideoSrc(nextSource);
    }
  }, [activeVideoSlot, availableQualityOptions, currentTime, getActiveVideoElement, playbackSources, selectedMediaItem, showQualitySwitchToast]);

  const handleFullscreen = useCallback(async () => {
    const target = playerShellRef.current;
    if (!target) return;
    try {
      const currentFullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (currentFullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
        return;
      }

      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      }

      if (window.matchMedia?.('(max-width: 767px)').matches && screen.orientation?.lock) {
        await screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (error) {
      console.warn(t('room.fullscreenFailedLog'), error);
    }
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      const fullscreenTarget = document.fullscreenElement || document.webkitFullscreenElement;
      const nextFullscreen = Boolean(fullscreenTarget && playerShellRef.current?.contains(fullscreenTarget));
      setIsPlayerFullscreen(nextFullscreen);
      if (!nextFullscreen && screen.orientation?.unlock) {
        try {
          screen.orientation.unlock();
        } catch {
          // Orientation unlock is best-effort.
        }
      }
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    syncFullscreenState();
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
    };
  }, []);

  const handleVideoPlay = useCallback((slot) => {
    if (consumeSuppressedVideoEvent(slot, 'play')) return;
    if (slot !== activeVideoSlot) return;
    playbackEndedRef.current = false;
    playbackEndedBroadcastedRef.current = false;
    const video = getActiveVideoElement();
    const latestTime = Number.isFinite(video?.currentTime) ? video.currentTime : currentTime;
    setCurrentTime(latestTime);
    lastTimeStateUpdateAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    setIsPlaying(true);
    if (!canBroadcastPlayback) return;
    addMessage({ type: 'sync', kind: 'play', text: t('room.userPressedPlay', { name: userName }) });
    onPlaybackEvent?.('play', {
      currentTimeSec: latestTime,
      playbackRate: speed,
    });
  }, [activeVideoSlot, addMessage, canBroadcastPlayback, consumeSuppressedVideoEvent, currentTime, getActiveVideoElement, onPlaybackEvent, speed, userName]);

  const handleVideoPause = useCallback((slot) => {
    if (consumeSuppressedVideoEvent(slot, 'pause')) return;
    if (slot !== activeVideoSlot) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < suppressMountMediaEventsUntilRef.current) return;
    const video = getActiveVideoElement();
    const pausedAtEnd = Boolean(
      video
      && Number.isFinite(video.duration)
      && video.duration > 0
      && video.currentTime >= video.duration - 0.2
    );
    if (video?.ended || playbackEndedRef.current || pausedAtEnd) {
      playbackEndedRef.current = true;
      const endedAt = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : currentTime;
      setCurrentTime(endedAt);
      setIsPlayerBuffering(false);
      setIsPlaying(false);
      if (canBroadcastPlayback && !playbackEndedBroadcastedRef.current) {
        playbackEndedBroadcastedRef.current = true;
        onPlaybackEvent?.('pause', {
          currentTimeSec: endedAt,
          playbackRate: speed,
        });
      }
      return;
    }
    const latestTime = Number.isFinite(video?.currentTime) ? video.currentTime : currentTime;
    setCurrentTime(latestTime);
    lastTimeStateUpdateAtRef.current = now;
    setIsPlayerBuffering(false);
    setIsPlaying(false);
    if (!canBroadcastPlayback) return;
    addMessage({ type: 'sync', kind: 'pause', text: t('room.userPaused', { name: userName }) });
    onPlaybackEvent?.('pause', {
      currentTimeSec: latestTime,
      playbackRate: speed,
    });
  }, [activeVideoSlot, addMessage, canBroadcastPlayback, consumeSuppressedVideoEvent, currentTime, getActiveVideoElement, onPlaybackEvent, speed, userName]);

  const handleVideoTimeUpdate = useCallback((slot, event) => {
    if (slot !== activeVideoSlot) return;
    if (!event.currentTarget.paused && event.currentTarget.readyState >= 3) {
      setIsPlayerBuffering(false);
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastTimeStateUpdateAtRef.current >= 250 || event.currentTarget.paused) {
      lastTimeStateUpdateAtRef.current = now;
      setCurrentTime(event.currentTarget.currentTime);
    }
  }, [activeVideoSlot]);

  const handleVideoEnded = useCallback((slot, event) => {
    if (slot !== activeVideoSlot) return;
    playbackEndedRef.current = true;
    if (bufferFallbackTimerRef.current) {
      window.clearTimeout(bufferFallbackTimerRef.current);
      bufferFallbackTimerRef.current = null;
    }
    const video = event.currentTarget;
    const endedAt = Number.isFinite(video?.duration) && video.duration > 0
      ? video.duration
      : (Number.isFinite(video?.currentTime) ? video.currentTime : currentTime);
    setCurrentTime(endedAt);
    setIsPlayerBuffering(false);
    setIsPlaying(false);
    if (!canBroadcastPlayback || playbackEndedBroadcastedRef.current) return;
    playbackEndedBroadcastedRef.current = true;
    onPlaybackEvent?.('pause', {
      currentTimeSec: endedAt,
      playbackRate: speed,
    });
  }, [activeVideoSlot, canBroadcastPlayback, currentTime, onPlaybackEvent, speed]);

  const handleVideoBufferStart = useCallback((slot, event) => {
    if (slot !== activeVideoSlot) return;
    if (consumeSuppressedVideoEvent(slot, 'buffer')) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < suppressMountMediaEventsUntilRef.current) return;
    if (now < suppressBufferUntilRef.current) return;
    const video = event.currentTarget;
    if (!video.currentSrc && !video.src) return;
    if (video.paused) return;
    if (event.type === 'seeking' && video.readyState >= 2) return;
    if (bufferFallbackTimerRef.current) {
      window.clearTimeout(bufferFallbackTimerRef.current);
      bufferFallbackTimerRef.current = null;
    }
    setIsPlayerBuffering(true);
    bufferFallbackTimerRef.current = window.setTimeout(() => {
      if (video.paused || video.readyState >= 2) {
        setIsPlayerBuffering(false);
      }
      bufferFallbackTimerRef.current = null;
    }, 1800);
  }, [activeVideoSlot, consumeSuppressedVideoEvent]);

  const handleVideoBufferEnd = useCallback((slot) => {
    if (slot !== activeVideoSlot) return;
    if (bufferFallbackTimerRef.current) {
      window.clearTimeout(bufferFallbackTimerRef.current);
      bufferFallbackTimerRef.current = null;
    }
    setIsPlayerBuffering(false);
  }, [activeVideoSlot]);

  const seekVideoBeforeQualityCommit = useCallback((video, targetTime) => new Promise((resolve) => {
    if (!video || !Number.isFinite(targetTime)) {
      resolve();
      return;
    }

    let settled = false;
    let timeoutId = null;
    const cleanup = () => {
      video.removeEventListener('seeked', finish);
      video.removeEventListener('canplay', finish);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    timeoutId = window.setTimeout(finish, 1200);

    video.addEventListener('seeked', finish, { once: true });
    video.addEventListener('canplay', finish, { once: true });

    try {
      if (Math.abs((video.currentTime || 0) - targetTime) > 0.05) {
        video.currentTime = targetTime;
      }
      if (!video.seeking && video.readyState >= 2) {
        window.requestAnimationFrame(finish);
      }
    } catch {
      finish();
    }
  }), []);

  const handleVideoLoadedMetadata = useCallback(async (slot, event) => {
    const video = event.currentTarget;
    const pending = qualitySwitchRequestRef.current;

    if (pending && pending.slot === slot) {
      const oldActive = getActiveVideoElement();
      const latestPlaybackTime = oldActive && oldActive !== video
        ? oldActive.currentTime
        : (currentTime || pending.currentTime);
      const targetTime = Math.min(Math.max(latestPlaybackTime || pending.currentTime, 0), video.duration || latestPlaybackTime || pending.currentTime);
      video.volume = volume;
      video.playbackRate = speed;
      video.muted = Boolean(pending.shouldResume);
      await seekVideoBeforeQualityCommit(video, targetTime);
      if (Math.abs((video.currentTime || 0) - targetTime) > 0.35) {
        await seekVideoBeforeQualityCommit(video, targetTime);
      }

      try {
        if (pending.shouldResume) {
          await video.play();
        }
      } catch {
        video.muted = false;
      }

      if (oldActive && oldActive !== video) {
        const oldSlot = activeVideoSlot;
        suppressVideoEvent(oldSlot, 'pause');
        oldActive.pause();
      }
      setActiveVideoSlot(slot);
      setPlayerQualityKey(pending.qualityKey);
      setCurrentTime(Math.max(targetTime, video.currentTime || 0));
      setDuration(video.duration || 0);
      setIsPlaying(Boolean(pending.shouldResume));
      video.muted = false;
      if (slot === 'primary') {
        setSecondaryVideoSrc('');
      } else {
        setPrimaryVideoSrc('');
      }
      setQualitySwitchPreservePlayState(null);
      qualitySwitchRequestRef.current = null;
      showQualitySwitchToast('success', pending.label);
      setIsPlayerBuffering(false);
      return;
    }

    if (slot !== activeVideoSlot) return;
    setIsPlayerBuffering(false);
    setDuration(video.duration || 0);
    video.volume = volume;
    video.playbackRate = speed;
    if (pendingExternalPlaybackRef.current) {
      window.setTimeout(() => {
        applyExternalPlaybackStateRef.current?.(pendingExternalPlaybackRef.current);
      }, 0);
    }
  }, [activeVideoSlot, currentTime, getActiveVideoElement, seekVideoBeforeQualityCommit, showQualitySwitchToast, speed, suppressVideoEvent, volume]);

  const handleVideoSeeked = useCallback((slot, event) => {
    if (consumeSuppressedVideoEvent(slot, 'seek')) return;
    if (slot !== activeVideoSlot) return;
    const eventNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (eventNow < suppressMountMediaEventsUntilRef.current) return;
    if (!canBroadcastPlayback) return;
    addMessage({ type: 'sync', kind: 'seek', text: t('room.userSeeked', { name: userName, time: event.currentTarget.currentTime.toFixed(1) }) });
    const now = Date.now();
    if (now - lastSeekEventAtRef.current < 350) return;
    lastSeekEventAtRef.current = now;
    onPlaybackEvent?.('seek', {
      currentTimeSec: event.currentTarget.currentTime,
      playbackRate: speed,
    });
  }, [activeVideoSlot, addMessage, canBroadcastPlayback, consumeSuppressedVideoEvent, onPlaybackEvent, speed, userName]);

  const applyExternalPlaybackState = useCallback(async (playback) => {
    const video = getActiveVideoElement();
    if (!playback) return false;
    pendingExternalPlaybackRef.current = playback;
    if (!video) return false;
    if (!video.currentSrc && !video.src) return false;
    const nextTime = getEffectivePlaybackTime(playback);
    const nextRate = clampNumber(playback.playbackRate || 1, 0.5, 4);
    const shouldPause = playback.paused !== false;

    video.playbackRate = nextRate;
    video.volume = volume;
    setSpeed(nextRate);

    if (Number.isFinite(nextTime) && Math.abs((video.currentTime || 0) - nextTime) > 0.35) {
      suppressVideoEvent(activeVideoSlot, 'seek');
      suppressVideoEvent(activeVideoSlot, 'buffer');
      suppressBufferUntilRef.current = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 800;
      try {
        video.currentTime = Math.min(nextTime, video.duration || nextTime);
      } catch {
        // Ignore unavailable seek ranges while metadata is loading.
      }
    }
    if (Number.isFinite(nextTime)) {
      setCurrentTime(shouldPause ? nextTime : (video.currentTime || nextTime));
      lastTimeStateUpdateAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    if (shouldPause) {
      if (!video.paused) {
        suppressVideoEvent(activeVideoSlot, 'pause');
        video.pause();
      }
      setIsPlayerBuffering(false);
      setIsPlaying(false);
      playbackEndedRef.current = false;
      playbackEndedBroadcastedRef.current = false;
      pendingExternalPlaybackRef.current = null;
      return true;
    }

    if (video.paused) {
      suppressVideoEvent(activeVideoSlot, 'play');
      const wasMuted = video.muted;
      try {
        video.muted = wasMuted;
        await video.play();
      } catch {
        try {
          video.muted = true;
          await video.play();
          window.setTimeout(() => {
            try {
              video.muted = wasMuted;
            } catch {
              // Restoring audio is best-effort after browser autoplay fallback.
            }
          }, 600);
        } catch {
          suppressedVideoEventsRef.current.delete(`${activeVideoSlot}:play`);
          return false;
        }
      }
    }
    if (video.readyState >= 2) {
      setIsPlayerBuffering(false);
    }
    setIsPlaying(true);
    playbackEndedRef.current = false;
    playbackEndedBroadcastedRef.current = false;
    pendingExternalPlaybackRef.current = null;
    return true;
  }, [activeVideoSlot, getActiveVideoElement, suppressVideoEvent, volume]);

  useEffect(() => {
    applyExternalPlaybackStateRef.current = applyExternalPlaybackState;
  }, [applyExternalPlaybackState]);

  const handleVideoError = useCallback((slot) => {
    if (qualitySwitchRequestRef.current?.slot === slot) {
      qualitySwitchRequestRef.current = null;
      if (slot === 'primary') {
        setPrimaryVideoSrc('');
      } else {
        setSecondaryVideoSrc('');
      }
      setQualitySwitchPreservePlayState(null);
      showQualitySwitchToast('error', '');
      addMessage({ type: 'system', kind: 'error', text: t('room.playerQualitySwitchFailed') });
      return;
    }
    if (slot !== activeVideoSlot) return;
    setIsPlayerBuffering(false);
    setIsPlaying(false);
    addMessage({ type: 'system', kind: 'error', text: t('room.sourceUnsupported') });
  }, [activeVideoSlot, addMessage, showQualitySwitchToast]);

  useEffect(() => {
    handleVideoErrorRef.current = handleVideoError;
  }, [handleVideoError]);

  const bindVideoSource = useCallback(async (slot, source) => {
    const video = slot === 'primary' ? primaryVideoRef.current : secondaryVideoRef.current;
    const hlsRef = slot === 'primary' ? primaryHlsRef : secondaryHlsRef;
    if (!video) return;

    const loadSeq = hlsLoadSeqRef.current[slot] + 1;
    hlsLoadSeqRef.current[slot] = loadSeq;
    destroyHlsInstance(hlsRef);

    if (!source) {
      video.removeAttribute('src');
      video.load();
      return;
    }

    if (!isHlsPlaybackSource(source)) {
      if (video.getAttribute('src') !== source) {
        video.src = source;
        video.load();
      }
      return;
    }

    if (canPlayHlsNatively(video)) {
      if (video.getAttribute('src') !== source) {
        video.src = source;
        video.load();
      }
      return;
    }

    const { default: Hls } = await import('hls.js/dist/hls.light.mjs');
    if (hlsLoadSeqRef.current[slot] !== loadSeq) return;

    if (!Hls.isSupported()) {
      video.src = source;
      video.load();
      return;
    }

    video.removeAttribute('src');
    video.load();

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      abrEwmaDefaultEstimate: Math.max(500_000, Math.round(estimateAvailableBandwidthMbps() * 1_000_000 * 0.85)),
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(source);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      destroyHlsInstance(hlsRef);
      handleVideoErrorRef.current?.(slot);
    });
  }, []);

  useEffect(() => {
    bindVideoSource('primary', primaryVideoSrc);
  }, [bindVideoSource, primaryVideoSrc]);

  useEffect(() => {
    bindVideoSource('secondary', secondaryVideoSrc);
  }, [bindVideoSource, secondaryVideoSrc]);

  useEffect(() => () => {
    destroyHlsInstance(primaryHlsRef);
    destroyHlsInstance(secondaryHlsRef);
  }, []);

  return {
    primaryVideoRef,
    secondaryVideoRef,
    playerShellRef,
    primaryVideoSrc,
    secondaryVideoSrc,
    activeVideoSlot,
    currentVideoSrc,
    isPlaying,
    currentTime,
    duration,
    isPlayerFullscreen,
    isPlayerBuffering,
    volume,
    speed,
    playerQualityKey,
    playbackSources,
    qualitySwitchState,
    qualitySwitchToastVisible,
    qualitySwitchPreservePlayState,
    progressPercent: duration ? (currentTime / duration) * 100 : 0,
    getActiveVideoElement,
    applyExternalPlaybackState,
    mountPlaybackSource,
    resetPlaybackSource,
    setPlaybackSources,
    setCurrentTime,
    setDuration,
    setSpeed,
    setPlayerQualityKey,
    togglePlay,
    handleSeek,
    handleVolumeChange,
    toggleMute,
    handleSpeedChange,
    handleQualityChange,
    handleFullscreen,
    handleVideoPlay,
    handleVideoPause,
    handleVideoTimeUpdate,
    handleVideoLoadedMetadata,
    handleVideoSeeked,
    handleVideoEnded,
    handleVideoBufferStart,
    handleVideoBufferEnd,
    handleVideoError,
  };
}
