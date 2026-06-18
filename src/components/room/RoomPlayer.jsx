import {
  ChevronLeft,
  ChevronRight,
  FastForward,
  Maximize,
  Minimize,
  MessageSquare,
  MessageSquareOff,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Send,
  Settings,
  Sun,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { t } from '../../i18n';
import { RoomEmojiPicker } from './RoomEmojiPicker';

export function RoomPlayer({
  playerShellRef,
  primaryVideoRef,
  secondaryVideoRef,
  primaryVideoSrc,
  secondaryVideoSrc,
  activeVideoSlot,
  currentTime,
  duration,
  progressPercent,
  speed,
  volume,
  displayIsPlaying,
  gpuVideoRenderingEnabled = false,
  isPlayerFullscreen = false,
  playerChromeVisible,
  playerBrightness,
  transientFeedbacks = [],
  continuousFeedback = null,
  topFeedback = null,
  danmakuLayer = null,
  showDanmaku,
  isDanmakuAnimating,
  showEmojiPanel,
  playerQualityKey,
  availableQualityOptions,
  playerMenuOpen,
  togglePlay,
  handleSpeedChange,
  handleQualityChange,
  toggleMute,
  handleFullscreen,
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
  keepPlayerChromeVisible,
  revealPlayerChrome,
  handleDesktopPlayerShellActivity,
  handleDesktopPlayerShellMouseLeave,
  handleDesktopPlayerShellBlur,
  handleDesktopPlayerControlMouseEnter,
  handleDesktopPlayerControlMouseLeave,
  setShowEmojiPanel,
  setPlayerMenuOpen,
  handleDanmakuToggle,
  danmakuInput = '',
  setDanmakuInput,
  sendDanmakuMessage,
  hidePlayerChrome,
  canSendChat,
  canSubmitChat = canSendChat,
  qualitySwitchState,
  qualitySwitchToastVisible,
  isPlayerBuffering = false,
  handleVideoPlay,
  handleVideoPause,
  handleVideoTimeUpdate,
  handleVideoLoadedMetadata,
  handleVideoSeeked,
  handleVideoEnded,
  handleVideoBufferStart,
  handleVideoBufferEnd,
  handleVideoError,
}) {
  const formatTime = (value) => {
    if (!Number.isFinite(value)) return '00:00';
    const sec = Math.max(0, Math.floor(value));
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const speedOptions = [2, 1.5, 1.25, 1, 0.75, 0.5];
  const chromeVisibleClassName = playerChromeVisible || isDanmakuAnimating ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none';
  const playerCursorClassName = playerChromeVisible ? 'cursor-default' : 'cursor-none';
  const volumePercent = Math.round(volume * 100);
  const brightnessPercent = Math.round(playerBrightness * 100);
  const speedLabel = `${Number.isInteger(speed) ? speed.toFixed(1) : speed}x`;
  const currentQualityLabel = availableQualityOptions.find((option) => option.key === playerQualityKey)?.label || availableQualityOptions[0]?.label || t('room.playerQualityAuto');
  const settingsMenuPanelRef = useRef(null);
  const settingsButtonRef = useRef(null);
  const danmakuInputRef = useRef(null);
  const danmakuIdleTimerRef = useRef(null);
  const danmakuSendCloseTimerRef = useRef(null);
  const gpuVideoClassName = gpuVideoRenderingEnabled ? 'transform-gpu will-change-transform' : '';
  const gpuMotionClassName = gpuVideoRenderingEnabled ? 'transform-gpu will-change-[transform,opacity]' : '';
  const gpuTransformClassName = gpuVideoRenderingEnabled ? 'transform-gpu' : '';
  const gpuWillChangeWidthClassName = gpuVideoRenderingEnabled ? 'will-change-[width,opacity]' : '';
  const videoRenderingStyle = {
    filter: `brightness(${playerBrightness})`,
    ...(gpuVideoRenderingEnabled ? {
      transform: 'translateZ(0)',
      backfaceVisibility: 'hidden',
      contain: 'paint',
    } : {}),
  };
  const videoSrc = activeVideoSlot === 'primary' ? primaryVideoSrc : secondaryVideoSrc;
  const qualitySwitchToastText = qualitySwitchState?.status === 'switching'
    ? t('room.playerQualitySwitching', { quality: qualitySwitchState.label || currentQualityLabel })
    : qualitySwitchState?.status === 'success'
      ? t('room.playerQualitySwitched', { quality: qualitySwitchState.label || currentQualityLabel })
      : qualitySwitchState?.status === 'error'
        ? t('room.playerQualitySwitchFailed')
        : '';
  const progressValueText = t('room.playerProgressValue', { current: formatTime(currentTime), duration: formatTime(duration) });
  const volumeValueText = t('room.playerVolumeValue', { volume: volumePercent });
  const brightnessValueText = t('room.playerBrightnessValue', { brightness: brightnessPercent });
  const settingsMenuOpen = String(playerMenuOpen || '').startsWith('settings');
  const handleProgressPointerDown = (event) => {
    event.stopPropagation();
    keepPlayerChromeVisible?.();
  };
  const handleProgressPointerRelease = (event) => {
    event.stopPropagation();
    scheduleProgressSeekChromeHide?.();
  };
  const renderFeedbackIcon = (feedback, iconClassName = 'text-white') => {
    if (!feedback?.icon) return null;
    const compact = feedback.type === 'volume' || feedback.type === 'brightness';
    if (feedback.icon === 'play') {
      return <Play size={52} fill="currentColor" className={iconClassName} />;
    }
    if (feedback.icon === 'pause') {
      return <Pause size={52} fill="currentColor" className={iconClassName} />;
    }
    if (feedback.icon === 'speed' || feedback.icon === 'seek') {
      return <FastForward size={30} fill="currentColor" className={iconClassName} />;
    }
    if (feedback.icon === 'volume') {
      return volume === 0 ? <VolumeX size={compact ? 20 : 30} className={iconClassName} /> : <Volume2 size={compact ? 20 : 30} className={iconClassName} />;
    }
    if (feedback.icon === 'brightness') {
      return <Sun size={compact ? 20 : 30} className={iconClassName} />;
    }
    return null;
  };
  const closeMenuAfterBlur = (event, menuName) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setPlayerMenuOpen((current) => (current === menuName ? null : current));
    }
  };

  const closeDanmakuComposer = useCallback(() => {
    setShowEmojiPanel(false);
    setDanmakuInput('');
    danmakuInputRef.current?.blur();
    hidePlayerChrome?.({ force: true });
  }, [hidePlayerChrome, setDanmakuInput, setShowEmojiPanel]);

  const scheduleDanmakuComposerClose = useCallback((delayMs) => {
    if (danmakuSendCloseTimerRef.current) {
      window.clearTimeout(danmakuSendCloseTimerRef.current);
    }
    danmakuSendCloseTimerRef.current = window.setTimeout(() => {
      closeDanmakuComposer();
      danmakuSendCloseTimerRef.current = null;
    }, delayMs);
  }, [closeDanmakuComposer]);

  useEffect(() => {
    if (danmakuIdleTimerRef.current) {
      window.clearTimeout(danmakuIdleTimerRef.current);
      danmakuIdleTimerRef.current = null;
    }
    if (!danmakuInput.trim()) return undefined;
    danmakuIdleTimerRef.current = window.setTimeout(() => {
      closeDanmakuComposer();
      danmakuIdleTimerRef.current = null;
    }, 5000);
    return () => {
      if (danmakuIdleTimerRef.current) {
        window.clearTimeout(danmakuIdleTimerRef.current);
        danmakuIdleTimerRef.current = null;
      }
    };
  }, [closeDanmakuComposer, danmakuInput]);

  useEffect(() => () => {
    if (danmakuIdleTimerRef.current) {
      window.clearTimeout(danmakuIdleTimerRef.current);
    }
    if (danmakuSendCloseTimerRef.current) {
      window.clearTimeout(danmakuSendCloseTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (!settingsMenuOpen) {
      if (settingsMenuPanelRef.current) {
        settingsMenuPanelRef.current.style.setProperty('--settings-menu-shift-x', '0px');
      }
      if (document.activeElement === settingsButtonRef.current) {
        settingsButtonRef.current.blur();
      }
      return undefined;
    }

    const updateMenuPosition = () => {
      const panel = settingsMenuPanelRef.current;
      if (!panel) return;
      const viewportPadding = 8;
      const currentShift = Number.parseFloat(panel.style.getPropertyValue('--settings-menu-shift-x')) || 0;
      const rect = panel.getBoundingClientRect();
      const baseLeft = rect.left - currentShift;
      const baseRight = rect.right - currentShift;
      let nextShift = 0;
      if (baseRight > window.innerWidth - viewportPadding) {
        nextShift = window.innerWidth - viewportPadding - baseRight;
      }
      if (baseLeft + nextShift < viewportPadding) {
        nextShift += viewportPadding - (baseLeft + nextShift);
      }
      panel.style.setProperty('--settings-menu-shift-x', `${Math.round(nextShift)}px`);
    };

    const frameId = window.requestAnimationFrame(updateMenuPosition);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [playerMenuOpen, settingsMenuOpen]);
  const handleDanmakuSwitch = (next) => {
    handleDanmakuToggle(next);
  };
  const renderControlSlider = ({
    orientation = 'vertical',
    percent,
    min,
    max,
    step,
    value,
    onInput,
    ariaLabel,
    ariaValueText,
  }) => {
    const isVertical = orientation === 'vertical';
    return (
      <div className={isVertical ? 'w-1.5 flex-1 bg-white/20 rounded-full relative cursor-pointer' : 'relative flex-1 h-1.5 rounded-full bg-white/20 cursor-pointer'}>
        <div
          className={isVertical ? 'absolute bottom-0 left-0 w-full bg-sky-400 rounded-full' : 'absolute left-0 top-0 h-full rounded-full bg-sky-400'}
          style={isVertical ? { height: `${percent}%` } : { width: `${percent}%` }}
        />
        <div
          className={isVertical ? 'absolute left-1/2 -translate-x-1/2 translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-md' : 'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white shadow-[0_0_8px_rgba(0,0,0,0.5)]'}
          style={isVertical ? { bottom: `${percent}%` } : { left: `${percent}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onInput={onInput}
          onChange={onInput}
          onPointerDown={keepPlayerChromeVisible}
          onPointerUp={keepPlayerChromeVisible}
          className={`absolute inset-0 w-full h-full opacity-0 cursor-pointer touch-none ${isVertical ? '[writing-mode:vertical-lr] [direction:rtl]' : ''}`}
          aria-label={ariaLabel}
          aria-valuetext={ariaValueText}
        />
      </div>
    );
  };
  const sendDanmaku = async (event) => {
    const sent = await sendDanmakuMessage(event);
    setShowEmojiPanel(false);
    revealPlayerChrome();
    if (sent) {
      scheduleDanmakuComposerClose(1500);
    }
  };

  return (
    <div className="w-full flex flex-col items-center justify-center font-sans selection:bg-sky-500/30">
      <style>
        {`
          @keyframes swaparty-player-feedback-ripple {
            0% { opacity: 0; transform: translate(-50%, -50%) scale(0.72); }
            16% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            58% { opacity: 1; transform: translate(-50%, -50%) scale(1.04); }
            100% { opacity: 0; transform: translate(-50%, -50%) scale(1.55); }
          }
          @keyframes swaparty-danmaku-track {
            0% { transform: translateX(0); }
            100% { transform: translateX(calc(-100vw - 100%)); }
          }
          @keyframes swaparty-danmaku-track-gpu {
            0% { transform: translate3d(0, 0, 0); }
            100% { transform: translate3d(calc(-100vw - 100%), 0, 0); }
          }
          @keyframes swaparty-dot-spinner {
            to { transform: rotate(360deg); }
          }
        `}
      </style>
      <div
        ref={playerShellRef}
        tabIndex={0}
        onMouseMove={handleDesktopPlayerShellActivity}
        onMouseEnter={handleDesktopPlayerShellActivity}
        onMouseLeave={handleDesktopPlayerShellMouseLeave}
        onBlur={handleDesktopPlayerShellBlur}
        className={`relative w-full md:max-w-[1120px] aspect-[16/9] md:aspect-video bg-black overflow-hidden md:rounded-2xl md:shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col group md:border md:border-white/5 outline-none shrink-0 z-20 md:mt-3 ${playerCursorClassName} ${gpuMotionClassName}`}
      >
        <video
          ref={primaryVideoRef}
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback"
          playsInline
          preload={primaryVideoSrc ? 'auto' : 'metadata'}
          className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-150 ${gpuVideoClassName} ${activeVideoSlot === 'primary' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={videoRenderingStyle}
          onPlay={() => handleVideoPlay('primary')}
          onPause={() => handleVideoPause('primary')}
          onTimeUpdate={(e) => handleVideoTimeUpdate('primary', e)}
          onLoadedMetadata={(e) => handleVideoLoadedMetadata('primary', e)}
          onSeeked={(e) => handleVideoSeeked('primary', e)}
          onEnded={(e) => handleVideoEnded('primary', e)}
          onWaiting={(e) => handleVideoBufferStart('primary', e)}
          onStalled={(e) => handleVideoBufferStart('primary', e)}
          onSeeking={(e) => handleVideoBufferStart('primary', e)}
          onPlaying={() => handleVideoBufferEnd('primary')}
          onCanPlay={() => handleVideoBufferEnd('primary')}
          onCanPlayThrough={() => handleVideoBufferEnd('primary')}
          onError={() => handleVideoError('primary')}
        />

        <video
          ref={secondaryVideoRef}
          controls={false}
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback"
          playsInline
          preload={secondaryVideoSrc ? 'auto' : 'metadata'}
          className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-150 ${gpuVideoClassName} ${activeVideoSlot === 'secondary' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={videoRenderingStyle}
          onPlay={() => handleVideoPlay('secondary')}
          onPause={() => handleVideoPause('secondary')}
          onTimeUpdate={(e) => handleVideoTimeUpdate('secondary', e)}
          onLoadedMetadata={(e) => handleVideoLoadedMetadata('secondary', e)}
          onSeeked={(e) => handleVideoSeeked('secondary', e)}
          onEnded={(e) => handleVideoEnded('secondary', e)}
          onWaiting={(e) => handleVideoBufferStart('secondary', e)}
          onStalled={(e) => handleVideoBufferStart('secondary', e)}
          onSeeking={(e) => handleVideoBufferStart('secondary', e)}
          onPlaying={() => handleVideoBufferEnd('secondary')}
          onCanPlay={() => handleVideoBufferEnd('secondary')}
          onCanPlayThrough={() => handleVideoBufferEnd('secondary')}
          onError={() => handleVideoError('secondary')}
        />

        <div className={`absolute left-3 bottom-16 sm:left-5 sm:bottom-24 z-20 pointer-events-none transition-all duration-300 ease-out ${qualitySwitchState ? (qualitySwitchToastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2') : 'opacity-0 translate-y-2 invisible'}`}>
          <div className="bg-[#111214] text-white px-4 py-3 rounded-xl text-sm sm:text-base shadow-xl">
            {qualitySwitchToastText}
          </div>
        </div>

        {(topFeedback || isPlayerBuffering) ? (
          <div
            className={`pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-[#111214]/95 px-4 py-2 text-white shadow-2xl animate-in slide-in-from-top-2 fade-in duration-200 ${gpuMotionClassName}`}
            key={topFeedback?.id || 'buffering'}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              {isPlayerBuffering && !topFeedback ? (
                <span className="relative h-5 w-5 shrink-0" style={{ animation: 'swaparty-dot-spinner 780ms linear infinite' }} aria-hidden="true">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <span
                      key={index}
                      className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400"
                      style={{
                        transform: `translate(-50%, -50%) rotate(${index * 45}deg) translateY(-8px)`,
                        opacity: 0.28 + index * 0.09,
                      }}
                    />
                  ))}
                </span>
              ) : (
                <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
              )}
              <span>{topFeedback?.primary || t('room.playerBuffering')}</span>
            </div>
          </div>
        ) : null}

        {transientFeedbacks.map((feedback, index) => (
          <div
            key={feedback.id}
            className={`absolute top-1/2 left-1/2 z-30 pointer-events-none flex flex-col items-center justify-center text-center ${gpuMotionClassName}`}
            style={{
              animation: 'swaparty-player-feedback-ripple 780ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
              animationDelay: `${Math.min(index * 35, 105)}ms`,
              zIndex: 30 + index,
            }}
          >
            <div className="text-white drop-shadow-[0_12px_30px_rgba(0,0,0,0.85)]">
              {renderFeedbackIcon(feedback, feedback.icon === 'play' ? 'text-white ml-3' : 'text-white')}
            </div>
          </div>
        ))}

        {continuousFeedback ? (
          <div
            key={continuousFeedback.id}
            className={`pointer-events-none absolute left-1/2 top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center text-white shadow-2xl animate-in fade-in zoom-in-95 duration-150 ${gpuMotionClassName} ${continuousFeedback.type === 'volume' || continuousFeedback.type === 'brightness' ? 'min-w-[104px] rounded-xl border border-white/5 bg-[#111214]/70 px-3 py-3' : 'min-w-[168px] max-w-[280px] rounded-2xl border border-white/10 bg-[#111214]/95 px-5 py-4'}`}
          >
            <div className={continuousFeedback.type === 'volume' || continuousFeedback.type === 'brightness' ? 'mb-2 text-white/90' : 'mb-2 text-white'}>
              {renderFeedbackIcon(continuousFeedback, 'text-white')}
            </div>
            {continuousFeedback.primary && continuousFeedback.type !== 'volume' && continuousFeedback.type !== 'brightness' ? (
              <span className="text-sm font-semibold tracking-wide text-white">{continuousFeedback.primary}</span>
            ) : null}
            {continuousFeedback.secondary && continuousFeedback.type !== 'volume' && continuousFeedback.type !== 'brightness' ? (
              <span className="mt-1 text-xs font-medium text-white/60">{continuousFeedback.secondary}</span>
            ) : null}
            <div className={`${continuousFeedback.type === 'volume' || continuousFeedback.type === 'brightness' ? 'mt-0 h-1 w-20 bg-white/20' : 'mt-3 h-1.5 w-full bg-white/15'} overflow-hidden rounded-full`}>
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-75 ease-out"
                style={{ width: `${Math.max(0, Math.min(100, continuousFeedback.percent || 0))}%` }}
              />
            </div>
          </div>
        ) : null}

        {!videoSrc ? (
          <button
            type="button"
            className="absolute inset-0 flex touch-none flex-col items-center justify-center cursor-pointer md:touch-auto"
            onClick={handleDesktopPlayerSurfaceClick}
            onPointerDown={handleMobilePlayerSurfacePointerDown}
            onPointerMove={handleMobilePlayerSurfacePointerMove}
            onPointerUp={handleMobilePlayerSurfacePointerUp}
            onPointerCancel={handleMobilePlayerSurfacePointerCancel}
            aria-label={displayIsPlaying ? t('room.playerPause') : t('room.playerPlay')}
          >
            <div className="text-white flex flex-col items-center">
              <MonitorPlay size={48} className="mb-4 opacity-20 sm:w-16 sm:h-16" />
              <p className="text-sm sm:text-lg tracking-widest opacity-30 font-light">{t('room.playerContentArea')}</p>
            </div>
          </button>
        ) : null}

        {videoSrc ? (
          <button
            type="button"
            className="absolute inset-0 z-[1] touch-none cursor-pointer bg-transparent md:touch-auto"
            onClick={handleDesktopPlayerSurfaceClick}
            onPointerDown={handleMobilePlayerSurfacePointerDown}
            onPointerMove={handleMobilePlayerSurfacePointerMove}
            onPointerUp={handleMobilePlayerSurfacePointerUp}
            onPointerCancel={handleMobilePlayerSurfacePointerCancel}
            aria-label={displayIsPlaying ? t('room.playerPause') : t('room.playerPlay')}
          />
        ) : null}

        {showDanmaku ? danmakuLayer : null}

        <div
          className={`absolute bottom-0 z-20 w-full transition-all duration-500 ease-out bg-gradient-to-t from-[#0a0b0e] via-[#0a0b0e]/80 to-transparent pt-8 pb-2 px-2 flex flex-col gap-1.5 ${gpuMotionClassName} ${chromeVisibleClassName}`}
          onMouseEnter={handleDesktopPlayerControlMouseEnter}
          onMouseLeave={handleDesktopPlayerControlMouseLeave}
          onPointerDown={handleMobilePlayerChromePointerDown}
          onPointerMove={handleMobilePlayerChromePointerMove}
          onPointerUp={handleMobilePlayerChromePointerUp}
          onPointerCancel={handleMobilePlayerChromePointerCancel}
        >
          <div className="relative w-full h-1.5 sm:h-2 bg-white/20 rounded-full cursor-pointer group/progress transition-all duration-300 ease-out hover:h-2.5">
            <div className="absolute top-0 left-0 h-full bg-sky-400 rounded-full shadow-[0_0_10px_rgba(56,189,248,0.4)]" style={{ width: `${progressPercent}%` }} />
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 bg-white rounded-full scale-0 group-hover/progress:scale-100 transition-transform duration-200 shadow-md" style={{ left: `${progressPercent}%` }} />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onInput={handlePlayerProgressInput}
              onChange={handlePlayerProgressInput}
              onPointerDown={handleProgressPointerDown}
              onPointerUp={handleProgressPointerRelease}
              onPointerCancel={handleProgressPointerRelease}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer touch-none"
              aria-label={t('room.playerProgress')}
              aria-valuetext={progressValueText}
            />
          </div>

          <div className="relative flex min-h-10 w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 text-white/90 min-[560px]:h-10 min-[560px]:flex-nowrap sm:gap-x-4">
            <div className="flex items-center gap-2 sm:gap-5 shrink-0 z-20">
              <button
                type="button"
                onClick={togglePlay}
                title={displayIsPlaying ? t('room.playerPause') : t('room.playerPlay')}
                className="relative w-8 h-8 flex shrink-0 items-center justify-center outline-none focus:outline-none group/play active:scale-90 transition-transform"
                aria-label={displayIsPlaying ? t('room.playerPause') : t('room.playerPlay')}
              >
                <div className={`absolute transition-all duration-300 ease-out ${gpuMotionClassName} ${displayIsPlaying ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100 text-white group-hover/play:text-sky-400'}`}>
                  <Play size={24} fill="currentColor" strokeWidth={1.5} className="sm:w-[26px] sm:h-[26px]" />
                </div>
                <div className={`absolute transition-all duration-300 ease-out ${gpuMotionClassName} ${displayIsPlaying ? 'rotate-0 scale-100 opacity-100 text-white group-hover/play:text-sky-400' : '-rotate-90 scale-50 opacity-0'}`}>
                  <Pause size={24} fill="currentColor" strokeWidth={1.5} className="sm:w-[26px] sm:h-[26px]" />
                </div>
              </button>

              <div className="text-xs sm:text-sm font-medium tracking-wide font-mono opacity-80 cursor-default select-none whitespace-nowrap">
                {formatTime(currentTime)} <span className="text-white/40 mx-0.5 sm:mx-1">/</span> <span className="text-white/60">{formatTime(duration)}</span>
              </div>
            </div>

            <div className="order-3 hidden w-full min-w-0 items-center justify-center z-10 min-[920px]:order-none min-[920px]:flex min-[920px]:flex-1">
              <form
                onSubmit={sendDanmaku}
                className="flex w-full min-w-0 max-w-[420px] xl:max-w-[520px] 2xl:max-w-[600px] items-center justify-center"
              >
                <div className={`flex w-full min-w-0 items-center justify-center gap-3 transition-all duration-500 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${gpuMotionClassName} ${showDanmaku ? 'opacity-100 translate-x-0 scale-100' : 'opacity-0 translate-x-12 scale-90 pointer-events-none'} ${isDanmakuAnimating ? 'pointer-events-none' : ''}`}>
                  <div className="flex min-w-0 flex-1 items-center bg-[#1f2126] hover:bg-[#282b33] border border-white/5 rounded-[14px] px-2 py-1.5 transition-colors shadow-lg">
                    <button
                      type="button"
                      onClick={() => handleDanmakuSwitch(false)}
                      title={t('room.danmakuDisable')}
                      className="relative flex items-center justify-center w-11 h-[22px] active:scale-90 transition-transform duration-200 outline-none focus:outline-none shrink-0"
                      aria-label={t('room.danmakuDisable')}
                    >
                      <div className={`absolute inset-0 rounded-full flex items-center px-[3px] bg-sky-500 transition-all duration-300 ${gpuTransformClassName} ${showDanmaku ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
                        <div className={`w-[16px] h-[16px] bg-white rounded-full shadow-sm translate-x-[22px] ${gpuTransformClassName}`} />
                      </div>
                      <div className={`absolute transition-all duration-300 ${gpuTransformClassName} ${showDanmaku ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
                        <MessageSquareOff size={18} className="text-white/80" strokeWidth={1.5} />
                      </div>
                    </button>

                    <div className="relative flex items-center justify-center ml-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setShowEmojiPanel((prev) => !prev)}
                        title={showEmojiPanel ? t('room.emojiClose') : t('room.emojiOpen')}
                        className="p-1 rounded-full hover:bg-white/10 text-white/80 hover:text-white active:scale-90 transition-all outline-none"
                        aria-label={showEmojiPanel ? t('room.emojiClose') : t('room.emojiOpen')}
                      >
                        <Plus size={18} className={`transition-transform duration-300 ease-out ${showEmojiPanel ? 'rotate-45' : 'rotate-0'}`} strokeWidth={2.5} />
                      </button>

                      {showEmojiPanel ? (
                        <div className="absolute bottom-full left-1/2 z-50 -translate-x-1/2 pb-4">
                          <RoomEmojiPicker
                            isDark
                            width={300}
                            height={320}
                            onSelect={(emoji) => {
                              setDanmakuInput((prev) => prev + emoji);
                              setShowEmojiPanel(false);
                              revealPlayerChrome();
                            }}
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="w-px h-4 bg-white/10 mx-2 shrink-0" />

                    <input
                      ref={danmakuInputRef}
                      type="text"
                      value={danmakuInput}
                      onChange={(e) => {
                        setDanmakuInput(e.target.value);
                        revealPlayerChrome();
                      }}
                      disabled={!canSendChat}
                      placeholder={canSendChat ? t('room.danmakuPlaceholder') : t('room.chatDisabledPlaceholder')}
                      className="bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-sm text-white placeholder-white/40 flex-1 min-w-0 cursor-text disabled:opacity-60"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={!canSubmitChat || !danmakuInput.trim()}
                    title={t('room.danmakuSend')}
                    className={`w-8 h-8 sm:w-[34px] sm:h-[34px] flex items-center justify-center rounded-full active:scale-90 transition-all duration-200 outline-none focus:outline-none shrink-0 border disabled:opacity-50 ${canSubmitChat && danmakuInput.trim() ? 'bg-sky-500 border-sky-400 text-white shadow-md' : 'bg-[#1f2126] hover:bg-[#282b33] border-white/5 text-white/50'}`}
                    aria-label={t('room.danmakuSend')}
                  >
                    <Send size={14} className={`sm:w-[15px] sm:h-[15px] ${canSubmitChat && danmakuInput.trim() ? '-ml-0.5' : ''}`} />
                  </button>
                </div>
              </form>

            </div>

            <div className="ml-auto flex items-center justify-end gap-1 sm:gap-5 shrink-0 z-20">
              <div className="flex min-[920px]:hidden items-center justify-center">
                <button
                  type="button"
                  onClick={() => handleDanmakuSwitch(!showDanmaku)}
                  title={showDanmaku ? t('room.danmakuDisable') : t('room.danmakuEnable')}
                  className="w-10 h-10 shrink-0 flex items-center justify-center active:scale-90 transition-all duration-200 outline-none focus:outline-none"
                  aria-label={showDanmaku ? t('room.danmakuDisable') : t('room.danmakuEnable')}
                >
                  {showDanmaku ? <MessageSquare size={22} className="text-white" strokeWidth={1.5} /> : <MessageSquareOff size={22} className="text-white/50" strokeWidth={1.5} />}
                </button>
              </div>

              <div className={`hidden min-[920px]:flex transition-all duration-500 ease-out items-center justify-center ${gpuWillChangeWidthClassName} ${!showDanmaku ? 'w-8 opacity-100' : 'w-0 opacity-0 pointer-events-none'} ${isDanmakuAnimating ? 'pointer-events-none' : ''}`}>
                <button
                  type="button"
                  onClick={() => handleDanmakuSwitch(true)}
                  title={t('room.danmakuEnable')}
                  className={`w-8 h-8 shrink-0 flex items-center justify-center transition-all duration-500 ${gpuTransformClassName} outline-none focus:outline-none hover:text-sky-400 ${!showDanmaku ? 'translate-x-0 scale-100 text-white/90' : '-translate-x-12 scale-50 opacity-0 text-white/50'}`}
                  aria-label={t('room.danmakuEnable')}
                >
                  <MessageSquareOff size={22} strokeWidth={1.5} />
                </button>
              </div>

              <div
                className="hidden min-[920px]:flex relative items-center justify-center h-10"
                onMouseEnter={() => setPlayerMenuOpen('speed')}
                onMouseLeave={() => setPlayerMenuOpen((current) => (current === 'speed' ? null : current))}
                onFocus={() => setPlayerMenuOpen('speed')}
                onBlur={(event) => closeMenuAfterBlur(event, 'speed')}
              >
                <button type="button" title={t('room.playerSpeedMenu')} className="text-sm font-medium hover:text-sky-400 active:scale-90 transition-all duration-200 outline-none focus:outline-none whitespace-nowrap" aria-haspopup="menu" aria-expanded={playerMenuOpen === 'speed'}>
                  {speedLabel}
                </button>
                <div className={`absolute bottom-full left-1/2 -translate-x-1/2 pb-4 transition-all duration-200 ease-out z-50 ${playerMenuOpen === 'speed' ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible translate-y-2'}`}>
                  <div className="flex flex-col bg-[#181a1f] border border-white/10 rounded-xl py-1.5 shadow-2xl min-w-[80px]" role="menu" aria-label={t('room.playerSpeedMenu')}>
                    {speedOptions.map((option) => (
                      <button
                        type="button"
                        key={option}
                        onClick={() => { handleSpeedChange(option); setPlayerMenuOpen(null); }}
                        className={`px-4 py-2 text-sm text-center font-medium hover:bg-white/10 active:scale-95 transition-all outline-none ${speed === option ? 'text-sky-400' : 'text-white/90'}`}
                        role="menuitemradio"
                        aria-checked={speed === option}
                      >
                        {option}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div
                className="hidden min-[920px]:flex relative items-center justify-center w-8 h-10"
                onMouseEnter={() => setPlayerMenuOpen('volume')}
                onMouseLeave={() => setPlayerMenuOpen((current) => (current === 'volume' ? null : current))}
                onFocus={() => setPlayerMenuOpen('volume')}
                onBlur={(event) => closeMenuAfterBlur(event, 'volume')}
              >
                <button type="button" title={t('room.playerVolume')} onClick={toggleMute} className="hover:text-sky-400 active:scale-[0.8] transition-all duration-200 outline-none focus:outline-none" aria-haspopup="true" aria-expanded={playerMenuOpen === 'volume'}>
                  {volume === 0 ? <VolumeX size={22} strokeWidth={1.5} /> : <Volume2 size={22} strokeWidth={1.5} />}
                </button>
                <div className={`absolute bottom-full left-1/2 -translate-x-1/2 pb-4 transition-all duration-200 ease-out z-50 ${playerMenuOpen === 'volume' ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible translate-y-2'}`}>
                  <div className="bg-[#181a1f] rounded-2xl w-9 h-32 flex flex-col items-center py-4 shadow-2xl border border-white/10">
                    {renderControlSlider({
                      percent: volumePercent,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      value: volume,
                      onInput: handlePlayerVolumeInput,
                      ariaLabel: t('room.playerVolume'),
                      ariaValueText: volumeValueText,
                    })}
                  </div>
                </div>
              </div>

              <div
                className="hidden min-[920px]:flex relative items-center justify-center w-8 h-10"
                onMouseEnter={() => setPlayerMenuOpen('brightness')}
                onMouseLeave={() => setPlayerMenuOpen((current) => (current === 'brightness' ? null : current))}
                onFocus={() => setPlayerMenuOpen('brightness')}
                onBlur={(event) => closeMenuAfterBlur(event, 'brightness')}
              >
                <button type="button" title={t('room.playerBrightness')} className="hover:text-sky-400 active:scale-[0.8] transition-all duration-200 outline-none focus:outline-none" aria-haspopup="true" aria-expanded={playerMenuOpen === 'brightness'}>
                  <Sun size={22} strokeWidth={1.5} />
                </button>
                <div className={`absolute bottom-full left-1/2 -translate-x-1/2 pb-4 transition-all duration-200 ease-out z-50 ${playerMenuOpen === 'brightness' ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible translate-y-2'}`}>
                  <div className="bg-[#181a1f] rounded-2xl w-9 h-32 flex flex-col items-center py-4 shadow-2xl border border-white/10">
                    {renderControlSlider({
                      percent: brightnessPercent,
                      min: 0.35,
                      max: 1,
                      step: 0.01,
                      value: playerBrightness,
                      onInput: handlePlayerBrightnessInput,
                      ariaLabel: t('room.playerBrightness'),
                      ariaValueText: brightnessValueText,
                    })}
                  </div>
                </div>
              </div>

              <div
                className="hidden min-[920px]:flex relative items-center justify-center h-10"
                onMouseEnter={() => setPlayerMenuOpen('quality')}
                onMouseLeave={() => setPlayerMenuOpen((current) => (current === 'quality' ? null : current))}
                onFocus={() => setPlayerMenuOpen('quality')}
                onBlur={(event) => closeMenuAfterBlur(event, 'quality')}
              >
                <button type="button" title={t('room.playerQualityMenu')} className="text-sm font-medium hover:text-sky-400 active:scale-90 transition-all duration-200 outline-none focus:outline-none whitespace-nowrap" aria-haspopup="menu" aria-expanded={playerMenuOpen === 'quality'}>{currentQualityLabel}</button>
                <div className={`absolute bottom-full left-1/2 -translate-x-1/2 pb-4 transition-all duration-200 ease-out z-50 ${playerMenuOpen === 'quality' ? 'opacity-100 visible translate-y-0' : 'opacity-0 invisible translate-y-2'}`}>
                  <div className="flex flex-col bg-[#181a1f] border border-white/10 rounded-xl py-1.5 shadow-2xl min-w-[120px]" role="menu" aria-label={t('room.playerQualityMenu')}>
                    {availableQualityOptions.map((option) => (
                      <button
                        type="button"
                        key={option.key}
                        onClick={() => { handleQualityChange(option.key); setPlayerMenuOpen(null); }}
                        className={`px-4 py-2 text-sm text-center font-medium hover:bg-white/10 active:scale-95 transition-all outline-none ${playerQualityKey === option.key ? 'text-sky-400' : 'text-white/90'}`}
                        role="menuitemradio"
                        aria-checked={playerQualityKey === option.key}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div
                className="flex min-[920px]:hidden relative items-center justify-center w-10 h-10"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setPlayerMenuOpen((current) => (String(current || '').startsWith('settings') ? null : current));
                  }
                }}
              >
                <button
                  ref={settingsButtonRef}
                  type="button"
                  title={t('room.playerSettings')}
                  onClick={(event) => {
                    const button = event.currentTarget;
                    setPlayerMenuOpen((current) => {
                      const shouldClose = String(current || '').startsWith('settings');
                      if (shouldClose) button.blur();
                      return shouldClose ? null : 'settings';
                    });
                  }}
                  className={`flex items-center justify-center active:scale-90 transition-all duration-300 outline-none focus:outline-none ${settingsMenuOpen ? 'text-sky-400 rotate-90' : 'text-white hover:text-sky-400'}`}
                  aria-haspopup="menu"
                  aria-expanded={settingsMenuOpen}
                  aria-label={t('room.playerSettings')}
                >
                  <Settings size={22} strokeWidth={1.5} />
                </button>

                <div
                  ref={settingsMenuPanelRef}
                  className={`absolute right-1/2 bottom-[calc(100%+6px)] h-[138px] w-[184px] max-w-[calc(100vw-32px)] translate-x-[calc(50%+var(--settings-menu-shift-x,0px))] transition-all duration-300 ease-out z-50 origin-bottom sm:h-[160px] sm:w-[196px] ${settingsMenuOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-90 translate-y-2 pointer-events-none'}`}
                >
                  <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1a1c22] shadow-2xl" role="menu" aria-label={t('room.playerSettings')}>
                    {playerMenuOpen === 'settings-speed' ? (
                      <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-150">
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings')}
                          className="px-3 py-2 flex items-center gap-1 text-[12px] font-medium text-white/60 hover:text-white transition-colors border-b border-white/5 shrink-0 shadow-sm"
                          aria-label={t('room.playerSettingsBack')}
                        >
                          <ChevronLeft size={16} />
                          {t('room.playerSpeedMenu')}
                        </button>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 scroll-smooth">
                          {speedOptions.map((option) => (
                            <button
                              type="button"
                              key={option}
                              onClick={() => { handleSpeedChange(option); setPlayerMenuOpen('settings'); }}
                              className={`w-full px-4 py-2 text-[13px] text-left font-medium active:scale-[0.98] transition-colors outline-none ${speed === option ? 'text-sky-400 bg-white/5' : 'text-white/80 hover:bg-white/5'}`}
                              role="menuitemradio"
                              aria-checked={speed === option}
                            >
                              {option}x
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {playerMenuOpen === 'settings-quality' ? (
                      <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-150">
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings')}
                          className="px-3 py-2 flex items-center gap-1 text-[12px] font-medium text-white/60 hover:text-white transition-colors border-b border-white/5 shrink-0 shadow-sm"
                          aria-label={t('room.playerSettingsBack')}
                        >
                          <ChevronLeft size={16} />
                          {t('room.playerQualityMenu')}
                        </button>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 scroll-smooth">
                          {availableQualityOptions.map((option) => (
                            <button
                              type="button"
                              key={option.key}
                              onClick={() => { handleQualityChange(option.key); setPlayerMenuOpen('settings'); }}
                              className={`w-full px-4 py-2 text-[13px] text-left font-medium active:scale-[0.98] transition-colors outline-none ${playerQualityKey === option.key ? 'text-sky-400 bg-white/5' : 'text-white/80 hover:bg-white/5'}`}
                              role="menuitemradio"
                              aria-checked={playerQualityKey === option.key}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {playerMenuOpen === 'settings-av' ? (
                      <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-150">
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings')}
                          className="px-3 py-2 flex items-center gap-1 text-[12px] font-medium text-white/60 hover:text-white transition-colors border-b border-white/5 shadow-sm shrink-0"
                          aria-label={t('room.playerSettingsBack')}
                        >
                          <ChevronLeft size={16} />
                          {t('room.playerVolumeBrightness')}
                        </button>
                        <div className="min-h-0 flex-1 flex flex-col gap-4 px-3.5 py-3 overflow-y-auto overscroll-contain scroll-smooth">
                          <div className="flex items-center gap-3">
                            <button type="button" onClick={toggleMute} className="text-white/70 active:scale-90 outline-none w-5 flex justify-center shrink-0" aria-label={t('room.playerVolume')}>
                              {volume === 0 ? <VolumeX size={18} strokeWidth={1.5} /> : <Volume2 size={18} strokeWidth={1.5} />}
                            </button>
                            {renderControlSlider({
                              orientation: 'horizontal',
                              percent: volumePercent,
                              min: 0,
                              max: 1,
                              step: 0.01,
                              value: volume,
                              onInput: handlePlayerVolumeInput,
                              ariaLabel: t('room.playerVolume'),
                              ariaValueText: volumeValueText,
                            })}
                          </div>

                          <div className="flex items-center gap-3">
                            <Sun size={18} strokeWidth={1.5} className="text-white/70 w-5 flex justify-center shrink-0" />
                            {renderControlSlider({
                              orientation: 'horizontal',
                              percent: brightnessPercent,
                              min: 0.35,
                              max: 1,
                              step: 0.01,
                              value: playerBrightness,
                              onInput: handlePlayerBrightnessInput,
                              ariaLabel: t('room.playerBrightness'),
                              ariaValueText: brightnessValueText,
                            })}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {playerMenuOpen === 'settings' ? (
                      <div className="flex h-full min-h-0 flex-col py-1 overflow-y-auto overscroll-contain scroll-smooth animate-in fade-in duration-200">
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings-speed')}
                          className="min-h-0 flex-1 px-3.5 py-2 flex items-center justify-between text-[13px] font-medium text-white/90 hover:bg-white/10 active:scale-[0.98] transition-all text-left"
                          role="menuitem"
                        >
                          <span>{t('room.playerSpeedMenu')}</span>
                          <span className="text-white/50 flex items-center gap-1">{speedLabel} <ChevronRight size={16} /></span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings-av')}
                          className="min-h-0 flex-1 px-3.5 py-2 flex items-center justify-between text-[13px] font-medium text-white/90 hover:bg-white/10 active:scale-[0.98] transition-all text-left"
                          role="menuitem"
                        >
                          <span>{t('room.playerVolumeBrightness')}</span>
                          <span className="text-white/50"><ChevronRight size={16} /></span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen('settings-quality')}
                          className="min-h-0 flex-1 px-3.5 py-2 flex items-center justify-between text-[13px] font-medium text-white/90 hover:bg-white/10 active:scale-[0.98] transition-all text-left"
                          role="menuitem"
                        >
                          <span>{t('room.playerQualityMenu')}</span>
                          <span className="text-white/50 flex items-center gap-1">{currentQualityLabel} <ChevronRight size={16} /></span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <button type="button" title={t('room.playerFullscreen')} onClick={handleFullscreen} className="hover:text-sky-400 active:scale-[0.8] transition-all duration-200 outline-none focus:outline-none ml-1">
                {isPlayerFullscreen ? (
                  <Minimize size={20} className="sm:w-[22px] sm:h-[22px]" strokeWidth={1.5} />
                ) : (
                  <Maximize size={20} className="sm:w-[22px] sm:h-[22px]" strokeWidth={1.5} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
