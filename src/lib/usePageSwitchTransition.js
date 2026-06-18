import { useCallback, useEffect, useRef, useState } from 'react';
import { PAGE_SWITCH_DURATION_MS } from './pageTransitionTokens';

export function usePageSwitchTransition(initialPage, { durationMs = PAGE_SWITCH_DURATION_MS } = {}) {
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const currentPageRef = useRef(initialPage);
  const transitionTimerRef = useRef(null);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  const clearTransitionTimer = useCallback(() => {
    if (!transitionTimerRef.current) return;
    window.clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = null;
  }, []);

  const switchPage = useCallback((nextPage) => {
    const next = String(nextPage || '').trim();
    if (!next) return;
    if (isTransitioning) return;
    if (currentPageRef.current === next) return;

    clearTransitionTimer();
    setIsTransitioning(true);
    transitionTimerRef.current = window.setTimeout(() => {
      setCurrentPage(next);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setIsTransitioning(false);
        });
      });
      transitionTimerRef.current = null;
    }, durationMs);
  }, [clearTransitionTimer, durationMs, isTransitioning]);

  const forceSetPage = useCallback((nextPage) => {
    const next = String(nextPage || '').trim();
    if (!next) return;
    clearTransitionTimer();
    setCurrentPage(next);
    setIsTransitioning(false);
  }, [clearTransitionTimer]);

  useEffect(() => {
    return () => {
      clearTransitionTimer();
    };
  }, [clearTransitionTimer]);

  return {
    currentPage,
    isTransitioning,
    switchPage,
    forceSetPage,
  };
}
