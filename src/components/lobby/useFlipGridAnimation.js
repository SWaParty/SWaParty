import { useCallback, useLayoutEffect, useRef } from 'react';

const FLIP_TRANSITION = 'transform 450ms cubic-bezier(0.32,0.72,0,1)';
const FLIP_CLEANUP_DELAY_MS = 480;
const FLIP_POSITION_TOLERANCE = 0.5;

function hasStructuralListChange(previousIds, nextIds) {
  if (previousIds.length !== nextIds.length) return true;
  for (let index = 0; index < nextIds.length; index += 1) {
    if (previousIds[index] !== nextIds[index]) return true;
  }
  return false;
}

export function useFlipGridAnimation(gridRef, itemsDependency) {
  const prevRectsRef = useRef({});
  const prevIdsRef = useRef([]);

  const resetFlipHistory = useCallback(() => {
    prevRectsRef.current = {};
    prevIdsRef.current = [];
  }, []);

  useLayoutEffect(() => {
    if (!gridRef.current) return;
    const children = Array.from(gridRef.current.children);
    const nextRects = {};
    const nextIds = [];

    children.forEach((child) => {
      const id = child.getAttribute('data-id');
      if (!id) return;
      nextIds.push(id);
      nextRects[id] = child.getBoundingClientRect();
    });

    const shouldAnimate = hasStructuralListChange(prevIdsRef.current, nextIds);
    if (!shouldAnimate) {
      prevRectsRef.current = nextRects;
      prevIdsRef.current = nextIds;
      return;
    }

    children.forEach((child) => {
      const id = child.getAttribute('data-id');
      if (!id) return;
      const nextRect = nextRects[id];
      const prevRect = prevRectsRef.current[id];

      if (prevRect) {
        const dx = prevRect.left - nextRect.left;
        const dy = prevRect.top - nextRect.top;
        if (Math.abs(dx) > FLIP_POSITION_TOLERANCE || Math.abs(dy) > FLIP_POSITION_TOLERANCE) {
          child.style.transition = 'none';
          child.style.transform = `translate(${dx}px, ${dy}px)`;
          requestAnimationFrame(() => {
            child.style.transition = FLIP_TRANSITION;
            child.style.transform = 'translate(0px, 0px)';
            window.setTimeout(() => {
              child.style.transition = '';
              child.style.transform = '';
            }, FLIP_CLEANUP_DELAY_MS);
          });
        }
      }
    });

    prevRectsRef.current = nextRects;
    prevIdsRef.current = nextIds;
  }, [gridRef, itemsDependency]);

  return resetFlipHistory;
}
