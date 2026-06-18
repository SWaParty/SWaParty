import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';

const PC_INTERACTIONS = Object.freeze({
  clickDelayMs: 180,
  chromeIdleMs: 1500,
  foregroundSuppressMs: 180,
  overlayMs: 900,
  seekStepSec: 5,
  volumeStep: 0.1,
  holdSpeed: 2,
});

const MOBILE_INTERACTIONS = Object.freeze({
  tapDelayMs: 180,
  longPressMs: 500,
  moveThresholdPx: 10,
  gestureThresholdPx: 14,
  tapThresholdPx: 12,
  verticalVolumeDampingPx: 170,
  verticalBrightnessDampingPx: 190,
  minSeekWindowSec: 30,
  maxSeekWindowSec: 240,
  seekResistance: 1.35,
  holdSpeed: 2,
});

const FEEDBACK = Object.freeze({
  hapticStart: 8,
  hapticCommit: 10,
  hapticLongPress: [8, 30, 8],
});

const PLAYER_CONTROL_SELECTOR = 'button, input, textarea, select, a, [role="menu"], [data-player-control="true"]';

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function formatPlayerClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
}

function isCoarsePointer() {
  return Boolean(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches);
}

function isTouchLikePointerEvent(event) {
  return event?.pointerType === 'touch' || event?.pointerType === 'pen';
}

function isPlayerControlTarget(target) {
  return Boolean(target?.closest?.(PLAYER_CONTROL_SELECTOR));
}

function triggerHaptic(pattern = FEEDBACK.hapticCommit) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  navigator.vibrate(pattern);
}

function getPlaybackFeedbackIcon(nextIsPlaying) {
  return nextIsPlaying ? 'pause' : 'play';
}

export function usePlayerInteractions({
  playerShellRef,
  getActiveVideoElement,
  isPlaying,
  currentTime,
  duration,
  volume,
  speed,
  setSpeed,
  playerBrightness,
  setPlayerBrightness,
  showEmojiPanel,
  setShowEmojiPanel,
  playerMenuOpen,
  setPlayerMenuOpen,
  showDanmaku,
  setShowDanmaku,
  setIsDanmakuAnimating,
  handleSeek,
  handleSpeedChange,
  handleVolumeChange,
  handleFullscreen,
  toggleMute,
  togglePlay,
}) {
  const [playerChromeVisible, setPlayerChromeVisible] = useState(true);
  const [transientFeedbacks, setTransientFeedbacks] = useState([]);
  const [continuousFeedback, setContinuousFeedback] = useState(null);
  const [topFeedback, setTopFeedback] = useState(null);
  const [isPlayerControlHovered, setIsPlayerControlHovered] = useState(false);

  const playerChromeTimerRef = useRef(null);
  const progressSeekChromeHideTimerRef = useRef(null);
  const playerClickTimerRef = useRef(null);
  const playerPointerRef = useRef(null);
  const transientFeedbackTimersRef = useRef(new Set());
  const continuousFeedbackTimerRef = useRef(null);
  const transientFeedbackSeqRef = useRef(0);
  const pointerMoveFrameRef = useRef(null);
  const latestPointerMoveRef = useRef(null);
  const playerLongPressTimerRef = useRef(null);
  const topFeedbackTimerRef = useRef(null);
  const pointerHoldSpeedBeforeRef = useRef(null);
  const shiftSpeedBeforeRef = useRef(null);
  const danmakuAnimTimerRef = useRef(null);
  const danmakuAnimatingRef = useRef(false);
  const gestureFrameRef = useRef(null);
  const gestureFrameTasksRef = useRef([]);
  const foregroundActivitySuppressUntilRef = useRef(0);

  const clearPlayerClickTimer = useCallback(() => {
    if (!playerClickTimerRef.current) return false;
    window.clearTimeout(playerClickTimerRef.current);
    playerClickTimerRef.current = null;
    return true;
  }, []);

  const scheduleGestureFrame = useCallback((task) => {
    gestureFrameTasksRef.current.push(task);
    if (gestureFrameRef.current) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      const currentTasks = gestureFrameTasksRef.current;
      gestureFrameTasksRef.current = [];
      currentTasks.forEach((currentTask) => currentTask?.());
      return;
    }
    gestureFrameRef.current = window.requestAnimationFrame(() => {
      const currentTasks = gestureFrameTasksRef.current;
      gestureFrameTasksRef.current = [];
      gestureFrameRef.current = null;
      currentTasks.forEach((currentTask) => currentTask?.());
    });
  }, []);

  const showTransientFeedback = useCallback((feedback) => {
    const id = `${Date.now()}-${transientFeedbackSeqRef.current}`;
    transientFeedbackSeqRef.current += 1;
    scheduleGestureFrame(() => {
      setTransientFeedbacks((current) => [...current.slice(-5), { ...feedback, id }]);
    });
    const timer = window.setTimeout(() => {
      setTransientFeedbacks((current) => current.filter((item) => item.id !== id));
      transientFeedbackTimersRef.current.delete(timer);
    }, 780);
    transientFeedbackTimersRef.current.add(timer);
  }, [scheduleGestureFrame]);

  const showContinuousFeedback = useCallback((feedback) => {
    if (continuousFeedbackTimerRef.current) {
      window.clearTimeout(continuousFeedbackTimerRef.current);
      continuousFeedbackTimerRef.current = null;
    }
    scheduleGestureFrame(() => {
      setContinuousFeedback({ ...feedback, id: feedback.type });
    });
  }, [scheduleGestureFrame]);

  const hideContinuousFeedback = useCallback((delayMs = 360) => {
    if (continuousFeedbackTimerRef.current) {
      window.clearTimeout(continuousFeedbackTimerRef.current);
    }
    continuousFeedbackTimerRef.current = window.setTimeout(() => {
      setContinuousFeedback(null);
      continuousFeedbackTimerRef.current = null;
    }, delayMs);
  }, []);

  const showTopFeedback = useCallback((feedback) => {
    if (topFeedbackTimerRef.current) {
      window.clearTimeout(topFeedbackTimerRef.current);
      topFeedbackTimerRef.current = null;
    }
    scheduleGestureFrame(() => {
      setTopFeedback({ ...feedback, id: feedback.type });
    });
    if (feedback.hideAfterMs > 0) {
      topFeedbackTimerRef.current = window.setTimeout(() => {
        setTopFeedback(null);
        topFeedbackTimerRef.current = null;
      }, feedback.hideAfterMs);
    }
  }, [scheduleGestureFrame]);

  const hideTopFeedback = useCallback(() => {
    if (topFeedbackTimerRef.current) {
      window.clearTimeout(topFeedbackTimerRef.current);
      topFeedbackTimerRef.current = null;
    }
    setTopFeedback(null);
  }, []);

  const hidePlayerChrome = useCallback((options = {}) => {
    const force = Boolean(options.force);
    if (!force && (danmakuAnimatingRef.current || isPlayerControlHovered || showEmojiPanel || playerMenuOpen || transientFeedbacks.length > 0)) return;
    setPlayerChromeVisible(false);
    setShowEmojiPanel(false);
    setPlayerMenuOpen(null);
  }, [isPlayerControlHovered, playerMenuOpen, setPlayerMenuOpen, setShowEmojiPanel, showEmojiPanel, transientFeedbacks.length]);

  const schedulePlayerChromeHide = useCallback(() => {
    if (playerChromeTimerRef.current) {
      window.clearTimeout(playerChromeTimerRef.current);
    }
    playerChromeTimerRef.current = window.setTimeout(() => {
      hidePlayerChrome();
      playerChromeTimerRef.current = null;
    }, PC_INTERACTIONS.chromeIdleMs);
  }, [hidePlayerChrome]);

  const revealPlayerChrome = useCallback(() => {
    setPlayerChromeVisible(true);
    schedulePlayerChromeHide();
  }, [schedulePlayerChromeHide]);

  useEffect(() => {
    if (!playerChromeVisible || !isCoarsePointer()) return undefined;
    schedulePlayerChromeHide();
    return undefined;
  }, [playerChromeVisible, playerMenuOpen, schedulePlayerChromeHide, showEmojiPanel, transientFeedbacks.length]);

  const keepPlayerChromeVisible = useCallback(() => {
    clearPlayerClickTimer();
    if (progressSeekChromeHideTimerRef.current) {
      window.clearTimeout(progressSeekChromeHideTimerRef.current);
      progressSeekChromeHideTimerRef.current = null;
    }
    revealPlayerChrome();
  }, [clearPlayerClickTimer, revealPlayerChrome]);

  const scheduleProgressSeekChromeHide = useCallback(() => {
    if (progressSeekChromeHideTimerRef.current) {
      window.clearTimeout(progressSeekChromeHideTimerRef.current);
    }
    progressSeekChromeHideTimerRef.current = window.setTimeout(() => {
      hidePlayerChrome({ force: true });
      progressSeekChromeHideTimerRef.current = null;
    }, 1500);
  }, [hidePlayerChrome]);

  const handleDesktopPlayerShellActivity = useCallback(() => {
    if (isCoarsePointer()) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (Date.now() < foregroundActivitySuppressUntilRef.current) return;
    revealPlayerChrome();
  }, [revealPlayerChrome]);

  const handleDesktopPlayerShellMouseLeave = useCallback(() => {
    schedulePlayerChromeHide();
  }, [schedulePlayerChromeHide]);

  const handleDesktopPlayerShellBlur = useCallback((event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      hidePlayerChrome({ force: true });
    }
  }, [hidePlayerChrome]);

  const handleDesktopPlayerControlMouseEnter = useCallback(() => {
    setIsPlayerControlHovered(true);
  }, []);

  const handleDesktopPlayerControlMouseLeave = useCallback(() => {
    setIsPlayerControlHovered(false);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        foregroundActivitySuppressUntilRef.current = Date.now() + PC_INTERACTIONS.foregroundSuppressMs;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);

  const handleDanmakuToggle = useCallback((next) => {
    setShowDanmaku(next);
    setIsDanmakuAnimating(true);
    setPlayerChromeVisible(true);
    danmakuAnimatingRef.current = true;
    if (playerChromeTimerRef.current) {
      window.clearTimeout(playerChromeTimerRef.current);
      playerChromeTimerRef.current = null;
    }
    if (danmakuAnimTimerRef.current) {
      window.clearTimeout(danmakuAnimTimerRef.current);
    }
    danmakuAnimTimerRef.current = window.setTimeout(() => {
      setIsDanmakuAnimating(false);
      danmakuAnimatingRef.current = false;
      danmakuAnimTimerRef.current = null;
      if (!next && isPlaying) {
        playerChromeTimerRef.current = window.setTimeout(() => {
          hidePlayerChrome();
        }, PC_INTERACTIONS.chromeIdleMs);
      }
    }, 500);
  }, [hidePlayerChrome, isPlaying, setIsDanmakuAnimating, setShowDanmaku]);

  const seekBy = useCallback((delta) => {
    const video = getActiveVideoElement();
    if (!video) return;
    const max = Number(video.duration || duration || 0);
    const next = clampNumber(video.currentTime + delta, 0, max || 0);
    video.currentTime = next;
  }, [duration, getActiveVideoElement]);

  const adjustVolume = useCallback((delta) => {
    const video = getActiveVideoElement();
    if (!video) return;
    const next = clampNumber(video.volume + delta, 0, 1);
    video.volume = next;
    handleVolumeChange(next);
    showContinuousFeedback({
      type: 'volume',
      icon: 'volume',
      percent: Math.round(next * 100),
      primary: `${Math.round(next * 100)}%`,
      secondary: t('room.playerVolume'),
    });
    hideContinuousFeedback(900);
  }, [getActiveVideoElement, handleVolumeChange, hideContinuousFeedback, showContinuousFeedback]);

  const handleDesktopPlayerSurfaceClick = useCallback((event) => {
    if (isCoarsePointer()) return;
    clearPlayerClickTimer();

    if (event.detail >= 2) {
      handleFullscreen();
      return;
    }

    playerClickTimerRef.current = window.setTimeout(async () => {
      const nextIsPlaying = await togglePlay();
      if (nextIsPlaying != null) {
        showTransientFeedback({ icon: getPlaybackFeedbackIcon(nextIsPlaying) });
      }
      playerClickTimerRef.current = null;
    }, PC_INTERACTIONS.clickDelayMs);
  }, [clearPlayerClickTimer, handleFullscreen, showTransientFeedback, togglePlay]);

  const handleMobilePlayerSurfacePointerDown = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    playerShellRef.current?.focus({ preventScroll: true });
    playerPointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      currentTime: getActiveVideoElement()?.currentTime ?? currentTime,
      volume: getActiveVideoElement()?.volume ?? volume,
      brightness: playerBrightness,
      gestureMode: null,
      pendingSeekTime: null,
      moved: false,
      longPressActive: false,
      chromeVisibleOnPointerDown: playerChromeVisible,
      rect: playerShellRef.current?.getBoundingClientRect() || null,
    };

    if (playerLongPressTimerRef.current) {
      window.clearTimeout(playerLongPressTimerRef.current);
    }
    playerLongPressTimerRef.current = window.setTimeout(() => {
      const current = playerPointerRef.current;
      if (!current || current.moved) return;
      clearPlayerClickTimer();
      current.longPressActive = true;
      pointerHoldSpeedBeforeRef.current = getActiveVideoElement()?.playbackRate || speed || 1;
      handleSpeedChange(MOBILE_INTERACTIONS.holdSpeed);
      triggerHaptic(FEEDBACK.hapticLongPress);
      showTopFeedback({
        type: 'speed',
        primary: `${MOBILE_INTERACTIONS.holdSpeed.toFixed(1)}x ▶▶`,
      });
      playerLongPressTimerRef.current = null;
    }, MOBILE_INTERACTIONS.longPressMs);
  }, [clearPlayerClickTimer, currentTime, getActiveVideoElement, handleSpeedChange, playerBrightness, playerChromeVisible, playerShellRef, showTopFeedback, speed, volume]);

  const handleMobilePlayerSurfacePointerMove = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    latestPointerMoveRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (pointerMoveFrameRef.current) return;
    const runMove = () => {
      pointerMoveFrameRef.current = null;
      const latest = latestPointerMoveRef.current;
      latestPointerMoveRef.current = null;
      if (!latest) return;
      const start = playerPointerRef.current;
      if (!start || start.pointerId !== latest.pointerId) return;

      const dx = latest.clientX - start.x;
      const dy = latest.clientY - start.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absX > MOBILE_INTERACTIONS.moveThresholdPx || absY > MOBILE_INTERACTIONS.moveThresholdPx) {
        start.moved = true;
        clearPlayerClickTimer();
        if (playerLongPressTimerRef.current) {
          window.clearTimeout(playerLongPressTimerRef.current);
          playerLongPressTimerRef.current = null;
        }
      }

      if (start.longPressActive) return;
      if (!start.gestureMode) {
        if (absX < MOBILE_INTERACTIONS.gestureThresholdPx && absY < MOBILE_INTERACTIONS.gestureThresholdPx) return;
        const width = Math.max(1, start.rect?.width || 1);
        start.gestureMode = absX > absY * 1.2
          ? 'seek'
          : (latest.clientX - (start.rect?.left || 0) > width / 2 ? 'volume' : 'brightness');
        triggerHaptic(FEEDBACK.hapticStart);
      }

      if (start.gestureMode === 'seek') {
        const width = Math.max(1, start.rect?.width || 1);
        const ratio = clampNumber(Math.abs(dx) / width, 0, 1);
        const direction = dx >= 0 ? 1 : -1;
        const seekWindow = Math.min(
          Math.max(duration || 20, MOBILE_INTERACTIONS.minSeekWindowSec),
          MOBILE_INTERACTIONS.maxSeekWindowSec,
        );
        const deltaSeconds = direction * Math.pow(ratio, MOBILE_INTERACTIONS.seekResistance) * seekWindow;
        const nextTime = clampNumber(start.currentTime + deltaSeconds, 0, duration || start.currentTime + deltaSeconds || 0);
        start.pendingSeekTime = nextTime;
        showContinuousFeedback({
          type: 'seek',
          icon: 'seek',
          primary: `${dx >= 0 ? '▶▶' : '◀◀'} ${formatPlayerClock(nextTime)}`,
          secondary: `${formatPlayerClock(nextTime)} / ${formatPlayerClock(duration)}`,
          percent: duration ? Math.round((nextTime / duration) * 100) : 0,
        });
        return;
      }

      if (start.gestureMode === 'volume') {
        const nextVolume = clampNumber(start.volume - (dy / MOBILE_INTERACTIONS.verticalVolumeDampingPx), 0, 1);
        handleVolumeChange(nextVolume);
        showContinuousFeedback({
          type: 'volume',
          icon: 'volume',
          percent: Math.round(nextVolume * 100),
        });
        return;
      }

      const nextBrightness = clampNumber(start.brightness - (dy / MOBILE_INTERACTIONS.verticalBrightnessDampingPx), 0.35, 1);
      setPlayerBrightness(nextBrightness);
      showContinuousFeedback({
        type: 'brightness',
        icon: 'brightness',
        percent: Math.round(nextBrightness * 100),
      });
    };
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      runMove();
      return;
    }
    pointerMoveFrameRef.current = window.requestAnimationFrame(runMove);
  }, [clearPlayerClickTimer, duration, handleVolumeChange, setPlayerBrightness, showContinuousFeedback]);

  const handleMobilePlayerSurfacePointerUp = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    const start = playerPointerRef.current;
    playerPointerRef.current = null;
    if (playerLongPressTimerRef.current) {
      window.clearTimeout(playerLongPressTimerRef.current);
      playerLongPressTimerRef.current = null;
    }
    if (!start || start.pointerId !== event.pointerId) return;

    if (start.longPressActive) {
      const previousSpeed = pointerHoldSpeedBeforeRef.current;
      pointerHoldSpeedBeforeRef.current = null;
      if (previousSpeed != null) {
        handleSpeedChange(previousSpeed);
      }
      hideTopFeedback();
      return;
    }

    if (start.gestureMode === 'volume' || start.gestureMode === 'brightness') {
      triggerHaptic(FEEDBACK.hapticCommit);
      hideContinuousFeedback();
      return;
    }

    if (start.gestureMode === 'seek' && start.pendingSeekTime != null) {
      handleSeek(start.pendingSeekTime);
      triggerHaptic(FEEDBACK.hapticCommit);
      hideContinuousFeedback();
      return;
    }

    const dxTap = event.clientX - start.x;
    const dyTap = event.clientY - start.y;
    if (Math.abs(dxTap) > MOBILE_INTERACTIONS.tapThresholdPx || Math.abs(dyTap) > MOBILE_INTERACTIONS.tapThresholdPx) {
      hideContinuousFeedback();
      return;
    }

    if (clearPlayerClickTimer()) {
      togglePlay().then((nextIsPlaying) => {
        if (nextIsPlaying != null) {
          showTransientFeedback({ icon: getPlaybackFeedbackIcon(nextIsPlaying) });
        }
      });
      triggerHaptic(FEEDBACK.hapticCommit);
      return;
    }
    playerClickTimerRef.current = window.setTimeout(() => {
      if (start.chromeVisibleOnPointerDown) {
        hidePlayerChrome({ force: true });
      } else {
        revealPlayerChrome();
      }
      playerClickTimerRef.current = null;
    }, MOBILE_INTERACTIONS.tapDelayMs);
  }, [clearPlayerClickTimer, handleSeek, handleSpeedChange, hideContinuousFeedback, hidePlayerChrome, hideTopFeedback, revealPlayerChrome, showTransientFeedback, togglePlay]);

  const handleMobilePlayerSurfacePointerCancel = useCallback((event) => {
    if (event && !isTouchLikePointerEvent(event)) return;
    if (playerLongPressTimerRef.current) {
      window.clearTimeout(playerLongPressTimerRef.current);
      playerLongPressTimerRef.current = null;
    }
    if (playerPointerRef.current?.longPressActive) {
      const previousSpeed = pointerHoldSpeedBeforeRef.current;
      pointerHoldSpeedBeforeRef.current = null;
      if (previousSpeed != null) {
        handleSpeedChange(previousSpeed);
      }
    }
    playerPointerRef.current = null;
    hideContinuousFeedback();
    hideTopFeedback();
  }, [handleSpeedChange, hideContinuousFeedback, hideTopFeedback]);

  const handleMobilePlayerChromePointerDown = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    if (isPlayerControlTarget(event.target)) {
      keepPlayerChromeVisible();
      return;
    }
    handleMobilePlayerSurfacePointerDown(event);
  }, [handleMobilePlayerSurfacePointerDown, keepPlayerChromeVisible]);

  const handleMobilePlayerChromePointerMove = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    if (isPlayerControlTarget(event.target)) return;
    handleMobilePlayerSurfacePointerMove(event);
  }, [handleMobilePlayerSurfacePointerMove]);

  const handleMobilePlayerChromePointerUp = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    if (isPlayerControlTarget(event.target)) {
      keepPlayerChromeVisible();
      return;
    }
    handleMobilePlayerSurfacePointerUp(event);
  }, [handleMobilePlayerSurfacePointerUp, keepPlayerChromeVisible]);

  const handleMobilePlayerChromePointerCancel = useCallback((event) => {
    if (!isTouchLikePointerEvent(event)) return;
    if (isPlayerControlTarget(event.target)) return;
    handleMobilePlayerSurfacePointerCancel(event);
  }, [handleMobilePlayerSurfacePointerCancel]);

  const handlePlayerProgressInput = useCallback((event) => {
    if (progressSeekChromeHideTimerRef.current) {
      window.clearTimeout(progressSeekChromeHideTimerRef.current);
      progressSeekChromeHideTimerRef.current = null;
    }
    handleSeek(event.currentTarget.value);
    revealPlayerChrome();
  }, [handleSeek, revealPlayerChrome]);

  const handlePlayerVolumeInput = useCallback((event) => {
    handleVolumeChange(event.currentTarget.value);
    revealPlayerChrome();
  }, [handleVolumeChange, revealPlayerChrome]);

  const handlePlayerBrightnessInput = useCallback((event) => {
    setPlayerBrightness(clampNumber(event.currentTarget.value, 0.35, 1));
    revealPlayerChrome();
  }, [revealPlayerChrome, setPlayerBrightness]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;
      if (!playerShellRef.current?.contains(document.activeElement)) return;

      if (event.key === 'Shift' && !shiftSpeedBeforeRef.current) {
        shiftSpeedBeforeRef.current = getActiveVideoElement()?.playbackRate || speed || 1;
        if (getActiveVideoElement()) getActiveVideoElement().playbackRate = PC_INTERACTIONS.holdSpeed;
        setSpeed(PC_INTERACTIONS.holdSpeed);
        showTopFeedback({
          type: 'speed',
          primary: `${PC_INTERACTIONS.holdSpeed.toFixed(1)}x ▶▶`,
        });
        revealPlayerChrome();
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-PC_INTERACTIONS.seekStepSec);
        showTopFeedback({
          type: 'seek',
          primary: `-${PC_INTERACTIONS.seekStepSec.toFixed(1)}s ◀◀`,
          hideAfterMs: 700,
        });
        revealPlayerChrome();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekBy(PC_INTERACTIONS.seekStepSec);
        showTopFeedback({
          type: 'seek',
          primary: `+${PC_INTERACTIONS.seekStepSec.toFixed(1)}s ▶▶`,
          hideAfterMs: 700,
        });
        revealPlayerChrome();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        adjustVolume(PC_INTERACTIONS.volumeStep);
        revealPlayerChrome();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        adjustVolume(-PC_INTERACTIONS.volumeStep);
        revealPlayerChrome();
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        handleFullscreen();
        revealPlayerChrome();
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        toggleMute();
        revealPlayerChrome();
        return;
      }
      if (event.key === 'd' || event.key === 'D') {
        event.preventDefault();
        handleDanmakuToggle(!showDanmaku);
        return;
      }
      if (event.key === '[') {
        event.preventDefault();
        handleSpeedChange(clampNumber((getActiveVideoElement()?.playbackRate ?? speed) - 0.25, 0.5, 4));
        revealPlayerChrome();
        return;
      }
      if (event.key === ']') {
        event.preventDefault();
        handleSpeedChange(clampNumber((getActiveVideoElement()?.playbackRate ?? speed) + 0.25, 0.5, 4));
        revealPlayerChrome();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        togglePlay().then((nextIsPlaying) => {
          if (nextIsPlaying != null) {
            showTransientFeedback({ icon: getPlaybackFeedbackIcon(nextIsPlaying) });
          }
        });
        revealPlayerChrome();
      }
    };

    const handleKeyUp = (event) => {
      if (event.key !== 'Shift' || shiftSpeedBeforeRef.current == null) return;
      const previousSpeed = shiftSpeedBeforeRef.current;
      shiftSpeedBeforeRef.current = null;
      if (getActiveVideoElement()) getActiveVideoElement().playbackRate = previousSpeed;
      setSpeed(previousSpeed);
      hideTopFeedback();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    adjustVolume,
    getActiveVideoElement,
    handleDanmakuToggle,
    handleFullscreen,
    handleSpeedChange,
    hideTopFeedback,
    playerShellRef,
    revealPlayerChrome,
    seekBy,
    setSpeed,
    showDanmaku,
    showTransientFeedback,
    showTopFeedback,
    speed,
    toggleMute,
    togglePlay,
  ]);

  useEffect(() => () => {
    [
      playerChromeTimerRef,
      progressSeekChromeHideTimerRef,
      playerClickTimerRef,
      playerLongPressTimerRef,
      danmakuAnimTimerRef,
      continuousFeedbackTimerRef,
      topFeedbackTimerRef,
    ].forEach((timerRef) => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    });
    transientFeedbackTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transientFeedbackTimersRef.current.clear();
    if (gestureFrameRef.current) {
      window.cancelAnimationFrame(gestureFrameRef.current);
      gestureFrameRef.current = null;
    }
    if (pointerMoveFrameRef.current) {
      window.cancelAnimationFrame(pointerMoveFrameRef.current);
      pointerMoveFrameRef.current = null;
    }
    latestPointerMoveRef.current = null;
    gestureFrameTasksRef.current = [];
    setTransientFeedbacks([]);
    setContinuousFeedback(null);
    setTopFeedback(null);
  }, []);

  return {
    playerChromeVisible,
    transientFeedbacks,
    continuousFeedback,
    topFeedback,
    isPlayerControlHovered,
    keepPlayerChromeVisible,
    revealPlayerChrome,
    hidePlayerChrome,
    handleDanmakuToggle,
    handleDesktopPlayerShellActivity,
    handleDesktopPlayerShellMouseLeave,
    handleDesktopPlayerShellBlur,
    handleDesktopPlayerControlMouseEnter,
    handleDesktopPlayerControlMouseLeave,
    handleDesktopPlayerSurfaceClick,
    handleMobilePlayerSurfacePointerDown,
    handleMobilePlayerSurfacePointerMove,
    handleMobilePlayerSurfacePointerUp,
    handleMobilePlayerSurfacePointerCancel,
    handleMobilePlayerChromePointerDown,
    handleMobilePlayerChromePointerMove,
    handleMobilePlayerChromePointerUp,
    handleMobilePlayerChromePointerCancel,
    handlePlayerProgressInput,
    scheduleProgressSeekChromeHide,
    handlePlayerVolumeInput,
    handlePlayerBrightnessInput,
    seekBy,
  };
}
