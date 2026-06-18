import { useEffect, useLayoutEffect, useRef } from 'react';

const DANMAKU_DISPLAY_DURATION_SEC = 6;

function getNowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function ChatDanmakuLayer({
  items = [],
  currentTime = 0,
  isPlaying = false,
  className = '',
}) {
  const canvasRef = useRef(null);
  const frameRef = useRef(0);
  const tickRef = useRef(null);
  const itemsRef = useRef([]);
  const playbackClockRef = useRef({ time: 0, at: 0 });
  const wasPlayingRef = useRef(false);
  const lastDrawAtRef = useRef(0);
  const viewportRef = useRef({ cssWidth: 1, cssHeight: 1, scaleX: 1, scaleY: 1, compact: false });
  const widthCacheRef = useRef(new Map());

  useEffect(() => {
    itemsRef.current = items;
    if (isPlaying && items.length > 0 && !frameRef.current && tickRef.current) {
      frameRef.current = window.requestAnimationFrame(tickRef.current);
    }
  }, [isPlaying, items]);

  useEffect(() => {
    const now = getNowMs();
    const nextTime = Math.max(0, Number(currentTime || 0));
    const wasPlaying = wasPlayingRef.current;
    const projectedTime = playbackClockRef.current.time
      + (wasPlaying ? Math.max(0, now - playbackClockRef.current.at) / 1000 : 0);

    if (!isPlaying) {
      playbackClockRef.current = {
        time: Math.abs(projectedTime - nextTime) < 0.5 ? projectedTime : nextTime,
        at: now,
      };
      wasPlayingRef.current = false;
      return;
    }

    if (wasPlaying && Math.abs(projectedTime - nextTime) < 0.35) {
      wasPlayingRef.current = true;
      return;
    }

    playbackClockRef.current = {
      time: nextTime,
      at: now,
    };
    wasPlayingRef.current = true;
  }, [currentTime, isPlaying]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, window.matchMedia?.('(max-width: 767px)')?.matches ? 1.5 : 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      viewportRef.current = {
        cssWidth,
        cssHeight,
        scaleX: canvas.width / cssWidth,
        scaleY: canvas.height / cssHeight,
        compact: cssWidth < 768,
      };
    };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return undefined;
    let closed = false;

    const draw = (now) => {
      const width = canvas.width;
      const height = canvas.height;
      const { cssWidth, cssHeight, scaleX, scaleY, compact } = viewportRef.current;
      const fontSize = compact ? 15 : 18;
      const playbackTime = playbackClockRef.current.time
        + (isPlaying ? Math.max(0, now - playbackClockRef.current.at) / 1000 : 0);

      context.clearRect(0, 0, width, height);
      context.save();
      context.scale(scaleX, scaleY);
      context.font = `${fontSize}px sans-serif`;
      context.textBaseline = 'middle';
      context.fillStyle = '#fff';

      const cache = widthCacheRef.current;
      itemsRef.current.forEach((item) => {
        const text = String(item.text || '').trim();
        if (!text) return;
        const itemTime = Number.isFinite(Number(item.time)) ? Number(item.time) : Number(item.videoTime || 0);
        const elapsed = playbackTime - itemTime;
        if (elapsed < 0 || elapsed > DANMAKU_DISPLAY_DURATION_SEC) return;
        const cacheKey = `${fontSize}:${item.id || text}:${text}`;
        let textWidth = cache.get(cacheKey);
        if (!textWidth) {
          textWidth = context.measureText(text).width;
          cache.set(cacheKey, textWidth);
        }
        const progress = elapsed / DANMAKU_DISPLAY_DURATION_SEC;
        const x = cssWidth - progress * (cssWidth + textWidth + 48);
        if (x + textWidth < 0 || x > cssWidth) return;
        const y = Math.max(fontSize, Math.min(cssHeight - fontSize, (Number(item.topPercent || 0) / 100) * cssHeight));
        context.fillText(text, x, y);
      });

      context.restore();
    };

    const tick = (now) => {
      if (closed) return;
      const { compact } = viewportRef.current;
      const frameInterval = compact ? 33 : 16;
      if (!lastDrawAtRef.current || now - lastDrawAtRef.current >= frameInterval) {
        lastDrawAtRef.current = now;
        draw(now);
      }
      if (isPlaying && itemsRef.current.length > 0) {
        frameRef.current = window.requestAnimationFrame(tick);
      } else {
        frameRef.current = 0;
      }
    };

    tickRef.current = tick;
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      closed = true;
      tickRef.current = null;
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [isPlaying]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute left-0 right-0 top-[8%] z-10 h-[68%] w-full ${className}`}
      aria-hidden="true"
    />
  );
}
