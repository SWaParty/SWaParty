import { Users } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import AuthScreen from './components/auth/AuthScreen';
import VerifyEmailScreen from './components/auth/VerifyEmailScreen';
import LegalScreen from './components/legal/LegalScreen';
import InboxDemoPanel from './components/lobby/InboxPanel';
import LobbyScreen from './components/lobby/LobbyScreen';
import WatchRoom from './components/room/WatchRoom';
import { t } from './i18n';
import {
  applyLocaleWithFallback,
  clearCachedUser,
  clearUserCacheDirty,
  isUserCacheDirty,
  readCachedUser,
  writeCachedUser,
} from './lib/localUserCache';
import {
  INVITES_CHANGED_EVENT,
  refreshInboxRuntimeAndNotify,
  warmInboxRuntimeCache,
} from './lib/inboxRuntimeCache';
import {
  PAGE_SWITCH_DURATION_MS,
  PAGE_SWITCH_HIDDEN_CLASS,
  PAGE_SWITCH_TRANSITION_CLASS,
  PAGE_SWITCH_VISIBLE_CLASS,
} from './lib/pageTransitionTokens';
import { usePageSwitchTransition } from './lib/usePageSwitchTransition';
import {
  CONTACTS_CHANGED_EVENT,
  prefetchContactsCache,
  publishContactsChanged,
} from './lib/quickContactsCache';
import {
  publishPresenceOnlineUserIds,
  normalizePresenceOnlineUserIds,
  normalizePresenceUserId,
} from './lib/realtimePresenceBus';
import { publishMediaChanged, publishRoomRealtimeEvent } from './lib/realtimeMediaBus';
import { publishProfileUpdated } from './lib/realtimeProfileBus';
import { buildRoomClientHeaders } from './lib/roomClientId';
import {
  clearProfileMetaCacheDirty,
  writeCachedProfileMeta,
} from './lib/localProfileCache';
import {
  AUTH_FORGOT_PATH,
  AUTH_TWO_FACTOR_PATH,
  buildAuthPath,
  getAuthModeFromPath,
  isAuthPath,
  isForgotPath,
  isTwoFactorPath,
  normalizeAuthMode,
} from './routes/authRoutes';
import { getLegalPageFromPath } from './routes/legalRoutes';
import { INBOX_PATH, isInboxPath } from './routes/inboxRoutes';
import {
  SETTINGS_TAB_PROFILE,
  buildSettingsPath,
  getSettingsTabFromPath,
  isSettingsPath,
} from './routes/settingsRoutes';
import {
  buildRoomPath,
  getRoomHashFromPath,
  isRoomPath,
} from './routes/roomRoutes';

const REMOTE_CONTACT_REMOVED_EVENT = 'swaparty-contact-removed-by-peer';
const CONTACT_RELATION_NOTICE_EVENT = 'swaparty-contact-relation-notice';
const REALTIME_RECONNECT_BASE_MS = 1000;
const REALTIME_RECONNECT_MAX_MS = 18000;
const REALTIME_WS_DEFAULT_URL = 'wss://rt.example.com';
const PRESENCE_CLEAR_GRACE_MS = 10000;
const REALTIME_ROOM_REFRESH_DEBOUNCE_MS = 350;
const INBOX_EVENT_DEBOUNCE_MS = 1200;
const INBOX_FORCE_REFRESH_MIN_INTERVAL_MS = 4000;
const CONTACT_NOTICE_CLOSE_MS = 220;
const loadProfileScreen = () => import('./components/profile/ProfileScreen');
const ProfileScreen = lazy(loadProfileScreen);

function isReloadNavigation() {
  try {
    const nav = performance.getEntriesByType('navigation')?.[0];
    return nav?.type === 'reload';
  } catch {
    return false;
  }
}

function mapRoomSnapshotToRoom(snapshot, currentUserId = '') {
  const sourceRoom = snapshot?.room || {};
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [];
  const roomHash = String(sourceRoom.hash || '').trim();
  const hostUserId = String(sourceRoom.hostUserId || '').trim();
  return {
    id: roomHash,
    hash: roomHash,
    dbId: sourceRoom.id || '',
    title: String(sourceRoom.title || '').trim() || t('room.defaultRoomTitle'),
    notice: String(sourceRoom.notice || '').trim(),
    maxMembers: Number(sourceRoom.maxMembers || 8) || 8,
    hostOnlyControl: sourceRoom.hostOnlyControl !== false,
    allowChat: sourceRoom.allowChat !== false,
    status: sourceRoom.status || 'open',
    hostLastSeenAt: Number(sourceRoom.hostLastSeenAt || 0) || null,
    hostDisconnectedAt: Number(sourceRoom.hostDisconnectedAt || 0) || null,
    expiresAt: Number(sourceRoom.expiresAt || 0) || null,
    playback: snapshot?.playback || null,
    hostId: hostUserId,
    isHost: hostUserId && hostUserId === String(currentUserId || '').trim(),
    members: members.map((member) => ({
      id: member.userId || member.id,
      userId: member.userId || '',
      name: member.displayName || t('room.memberFallbackName'),
      displayName: member.displayName || '',
      avatar: member.avatarUrl || '',
      avatarUrl: member.avatarUrl || '',
      role: member.role || 'member',
      isHost: member.role === 'host' || member.userId === hostUserId,
    })),
    snapshot,
  };
}

export default function App() {
  const [pathname, setPathname] = useState(() => (typeof window !== 'undefined' ? window.location.pathname : '/'));
  const isVerifyPage = pathname === '/verify';
  const legalPage = getLegalPageFromPath(pathname);
  const isLegalPage = Boolean(legalPage);
  const settingsTabFromPath = getSettingsTabFromPath(pathname);
  const [authMode, setAuthMode] = useState(() => {
    return normalizeAuthMode(getAuthModeFromPath(pathname));
  });
  const [authForgotOpen, setAuthForgotOpen] = useState(() => {
    return isForgotPath(pathname);
  });
  const [authTwoFactorOpen, setAuthTwoFactorOpen] = useState(() => {
    return isTwoFactorPath(pathname);
  });
  const [user, setUser] = useState(null);
  const userRef = useRef(null);
  const [room, setRoom] = useState(null);
  const [roomRouteLoadingHash, setRoomRouteLoadingHash] = useState('');
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  const initialMainPage = isSettingsPath(pathname)
    ? 'profile'
    : (isInboxPath(pathname) && !isDesktop ? 'inbox' : 'lobby');
  const {
    currentPage: currentMainPage,
    isTransitioning: isMainPageFading,
    switchPage: navigateMainPage,
    forceSetPage: setMainPageImmediate,
  } = usePageSwitchTransition(initialMainPage, { durationMs: PAGE_SWITCH_DURATION_MS });
  const [profileActiveTab, setProfileActiveTab] = useState(() => settingsTabFromPath || SETTINGS_TAB_PROFILE);
  const [authReady, setAuthReady] = useState(isVerifyPage || isLegalPage);
  const [authEnterAnimationVersion, setAuthEnterAnimationVersion] = useState(0);
  const [contactNoticeModal, setContactNoticeModal] = useState({ open: false, title: '', content: '' });
  const [activeRoomSummaries, setActiveRoomSummaries] = useState([]);
  const [pendingJoinRoomInvite, setPendingJoinRoomInvite] = useState(null);
  const [isContactNoticeClosing, setIsContactNoticeClosing] = useState(false);
  const shouldResetTwoFactorOnBootRef = useRef((() => {
    if (typeof window === 'undefined') return false;
    return isReloadNavigation() && isTwoFactorPath(window.location.pathname);
  })());
  const contactNoticeCloseTimerRef = useRef(null);
  const deferredNavTaskTokenRef = useRef(0);

  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined' && window.location.pathname === '/verify') {
      const urlTheme = new URLSearchParams(window.location.search).get('theme');
      if (urlTheme === 'dark') {
        localStorage.setItem('theme', 'dark');
        return true;
      }
      if (urlTheme === 'light') {
        localStorage.setItem('theme', 'light');
        return false;
      }
    }
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') return true;
    if (savedTheme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const viewTransitionWarmedRef = useRef(false);
  const themeTransitionRunningRef = useRef(false);
  const realtimeSocketRef = useRef(null);
  const realtimeReconnectTimerRef = useRef(null);
  const roomRefreshTimerRef = useRef(null);
  const currentRoomRefreshTimerRef = useRef(null);
  const inboxRefreshTimerRef = useRef(null);
  const inboxLastForceRefreshAtRef = useRef(0);
  const presenceClearTimerRef = useRef(null);
  const realtimeConnectedRef = useRef(false);
  const presenceOnlineUserIdsRef = useRef(new Set());
  const roomLoadRef = useRef({ hash: '', inFlight: false });
  const roomRef = useRef(null);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);
  const primaryActiveRoom = useMemo(() => (
    activeRoomSummaries.find((item) => item.isHost && (item.status === 'open' || item.status === 'host_disconnected'))
    || activeRoomSummaries[0]
    || null
  ), [activeRoomSummaries]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const updateRealtimeConnected = (nextValue) => {
    const next = Boolean(nextValue);
    realtimeConnectedRef.current = next;
    setIsRealtimeConnected(next);
  };

  const runAfterFrames = useCallback((task, frames = 2) => {
    const token = ++deferredNavTaskTokenRef.current;
    let remaining = Math.max(0, Number(frames) || 0);
    const step = () => {
      if (token !== deferredNavTaskTokenRef.current) return;
      if (remaining <= 0) {
        task();
        return;
      }
      remaining -= 1;
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }, []);

  const normalizeAppUser = (rawUser) => {
    if (!rawUser) return null;
    return {
      id: rawUser.id,
      publicId: rawUser.publicId || null,
      name: rawUser.displayName || rawUser.name || rawUser.email?.split('@')[0] || 'Guest',
      email: rawUser.email,
      avatarUrl: rawUser.avatarUrl || null,
      locale: rawUser.locale || null,
    };
  };

  const handleUserUpdate = useCallback((nextUser) => {
    const normalized = normalizeAppUser(nextUser);
    userRef.current = normalized;
    setUser(normalized);
    if (!normalized) {
      clearCachedUser();
      return;
    }
    writeCachedUser(normalized);
    clearUserCacheDirty();
    applyLocaleWithFallback(normalized.locale);
  }, []);

  const refreshSessionUser = useCallback(async ({ clearOnUnauth = false } = {}) => {
    try {
      const resp = await fetch('/api/auth/session', { credentials: 'include' });
      const payload = await resp.json().catch(() => ({}));
      if (resp.ok && payload?.authenticated && payload?.user) {
        handleUserUpdate(payload.user);
        return payload.user;
      }
      if (clearOnUnauth) {
        clearCachedUser();
        userRef.current = null;
        setUser(null);
        applyLocaleWithFallback(null);
      }
    } catch {
      // Session refresh is best effort when the browser returns to foreground.
    }
    return null;
  }, [handleUserUpdate]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const requestRoomSnapshot = useCallback(async (roomHash, { join = false, createBody = null, joinBody = null } = {}) => {
    const normalizedHash = String(roomHash || '').trim();
    const endpoint = createBody
      ? '/api/rooms'
      : `/api/rooms/${encodeURIComponent(normalizedHash)}${join ? '/join' : ''}`;
    const hasJsonBody = Boolean(createBody || joinBody);
    const response = await fetch(endpoint, {
      method: createBody || join ? 'POST' : 'GET',
      credentials: 'include',
      headers: buildRoomClientHeaders(hasJsonBody ? { 'content-type': 'application/json' } : {}),
      body: createBody ? JSON.stringify(createBody) : joinBody ? JSON.stringify(joinBody) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false || !payload?.data?.room?.hash) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return mapRoomSnapshotToRoom(payload.data, user?.id);
  }, [user?.id]);

  const refreshActiveRooms = useCallback(async () => {
    if (!user) {
      setActiveRoomSummaries([]);
      return [];
    }
    try {
      const response = await fetch('/api/rooms/active', { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false || !Array.isArray(payload?.data)) {
        setActiveRoomSummaries([]);
        return [];
      }
      const rooms = payload.data
        .map((snapshot) => mapRoomSnapshotToRoom(snapshot, user.id))
        .filter((item) => item.id);
      setActiveRoomSummaries(rooms);
      return rooms;
    } catch {
      setActiveRoomSummaries([]);
      return [];
    }
  }, [user]);

  useEffect(() => {
    if (viewTransitionWarmedRef.current) return;
    if (!document.startViewTransition) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const warm = () => {
      if (viewTransitionWarmedRef.current) return;
      viewTransitionWarmedRef.current = true;

      const prev = document.documentElement.dataset.themeTransition;
      let transition = null;
      try {
        transition = document.startViewTransition(() => { });
      } catch {
        return;
      }

      transition.finished.catch(() => { }).finally(() => {
        if (prev === undefined) {
          delete document.documentElement.dataset.themeTransition;
        } else {
          document.documentElement.dataset.themeTransition = prev;
        }
      });
    };

    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(() => warm(), { timeout: 800 });
      return () => window.cancelIdleCallback(id);
    }

    const timer = window.setTimeout(warm, 120);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark' || savedTheme === 'light') return;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDark(prefersDark);
    localStorage.setItem('theme', prefersDark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const hasSavedTheme = localStorage.getItem('theme');

    if (!hasSavedTheme) {
      setIsDark(mediaQuery.matches);
    }

    const handleSystemThemeChange = (event) => {
      if (!localStorage.getItem('theme')) {
        setIsDark(event.matches);
      }
    };

    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange);
  }, []);

  useEffect(() => {
    if (isVerifyPage || isLegalPage) return undefined;
    let alive = true;
    const restoreSession = async () => {
      const cachedUser = readCachedUser();
      if (cachedUser && alive) {
        setUser(cachedUser);
        applyLocaleWithFallback(cachedUser.locale);
      }

      const needSessionFetch = !cachedUser || isUserCacheDirty();
      if (!needSessionFetch) {
        if (alive) setAuthReady(true);
        return;
      }

      try {
        const nextUser = await refreshSessionUser({ clearOnUnauth: false });
        if (!alive) return;
        if (!nextUser && !cachedUser) {
          clearCachedUser();
          setUser(null);
          applyLocaleWithFallback(null);
        }
      } catch {
        if (!cachedUser && alive) {
          applyLocaleWithFallback(null);
        }
      } finally {
        if (alive) setAuthReady(true);
      }
    };
    restoreSession();
    return () => {
      alive = false;
    };
  }, [isLegalPage, isVerifyPage, refreshSessionUser]);

  useEffect(() => {
    if (!user?.id || typeof window === 'undefined' || isVerifyPage || isLegalPage) return undefined;
    let refreshTimer = null;
    const scheduleForegroundRefresh = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshSessionUser();
      }, 120);
    };
    window.addEventListener('focus', scheduleForegroundRefresh);
    document.addEventListener('visibilitychange', scheduleForegroundRefresh);
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      window.removeEventListener('focus', scheduleForegroundRefresh);
      document.removeEventListener('visibilitychange', scheduleForegroundRefresh);
    };
  }, [isLegalPage, isVerifyPage, refreshSessionUser, user?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncAuthModeFromUrl = () => {
      const path = window.location.pathname;
      setPathname(path);
      const modeFromPath = getAuthModeFromPath(path);
      if (modeFromPath) setAuthMode(modeFromPath);
      setAuthForgotOpen(isForgotPath(path));
      setAuthTwoFactorOpen(isTwoFactorPath(path));
    };

    window.addEventListener('popstate', syncAuthModeFromUrl);
    return () => window.removeEventListener('popstate', syncAuthModeFromUrl);
  }, []);

  useEffect(() => {
    return () => {
      updateRealtimeConnected(false);
      if (realtimeReconnectTimerRef.current) {
        window.clearTimeout(realtimeReconnectTimerRef.current);
        realtimeReconnectTimerRef.current = null;
      }
      if (inboxRefreshTimerRef.current) {
        window.clearTimeout(inboxRefreshTimerRef.current);
        inboxRefreshTimerRef.current = null;
      }
      if (presenceClearTimerRef.current) {
        window.clearTimeout(presenceClearTimerRef.current);
        presenceClearTimerRef.current = null;
      }
      if (contactNoticeCloseTimerRef.current) {
        window.clearTimeout(contactNoticeCloseTimerRef.current);
        contactNoticeCloseTimerRef.current = null;
      }
      if (realtimeSocketRef.current) {
        try {
          realtimeSocketRef.current.close(1000, 'app_unmount');
        } catch {
          // ignore
        }
        realtimeSocketRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onContactRelationNotice = (event) => {
      const detail = event?.detail || {};
      const explicitTitle = String(detail.title || '').trim();
      const explicitContent = String(detail.content || '').trim();
      if (explicitTitle && explicitContent) {
        setIsContactNoticeClosing(false);
        setContactNoticeModal({ open: true, title: explicitTitle, content: explicitContent });
        return;
      }
      const role = String(detail.role || '').trim();
      const name = String(detail.name || detail.displayName || '').trim() || t('profile.fallbackDisplayName');
      const title = t('profile.contactRelationRemovedTitle');
      const content = role === 'actor'
        ? t('profile.contactRelationRemovedBySelfContent', { name })
        : t('profile.contactRelationRemovedByPeerContent', { name });
      setIsContactNoticeClosing(false);
      setContactNoticeModal({ open: true, title, content });
    };

    window.addEventListener(CONTACT_RELATION_NOTICE_EVENT, onContactRelationNotice);
    return () => {
      window.removeEventListener(CONTACT_RELATION_NOTICE_EVENT, onContactRelationNotice);
    };
  }, []);

  const closeContactNoticeModal = () => {
    if (!contactNoticeModal.open || isContactNoticeClosing) return;
    setIsContactNoticeClosing(true);
    if (contactNoticeCloseTimerRef.current) {
      window.clearTimeout(contactNoticeCloseTimerRef.current);
      contactNoticeCloseTimerRef.current = null;
    }
    contactNoticeCloseTimerRef.current = window.setTimeout(() => {
      setContactNoticeModal({ open: false, title: '', content: '' });
      setIsContactNoticeClosing(false);
      contactNoticeCloseTimerRef.current = null;
    }, CONTACT_NOTICE_CLOSE_MS);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || isVerifyPage || isLegalPage || !authReady) return;
    const path = pathname;

    if (user) {
      if (isAuthPath(path)) {
        window.history.replaceState({}, '', '/');
        setPathname('/');
        if (!isMainPageFading && currentMainPage !== 'lobby') {
          navigateMainPage('lobby');
        }
        return;
      }

      if (isRoomPath(path)) {
        const roomHash = getRoomHashFromPath(path);
        if (roomHash && room?.id !== roomHash && (!roomLoadRef.current.inFlight || roomLoadRef.current.hash !== roomHash)) {
          roomLoadRef.current = { hash: roomHash, inFlight: true };
          setRoomRouteLoadingHash(roomHash);
          requestRoomSnapshot(roomHash, { join: true })
            .then((nextRoom) => {
              if (roomLoadRef.current.hash === roomHash) {
                setRoom(nextRoom);
              }
            })
            .catch(() => {
              if (roomLoadRef.current.hash === roomHash) {
                roomLoadRef.current = { hash: '', inFlight: false };
                setRoomRouteLoadingHash('');
                window.history.replaceState({}, '', '/');
                setPathname('/');
              }
            })
            .finally(() => {
              if (roomLoadRef.current.hash === roomHash) {
                roomLoadRef.current = { hash: roomHash, inFlight: false };
                setRoomRouteLoadingHash('');
              }
            });
        }
        return;
      }

      if (room) {
        setRoom(null);
      }
      if (roomRouteLoadingHash) {
        setRoomRouteLoadingHash('');
      }

      if (isSettingsPath(path)) {
        const normalizedTab = getSettingsTabFromPath(path) || SETTINGS_TAB_PROFILE;
        const normalizedPath = buildSettingsPath(normalizedTab);
        if (path !== normalizedPath) {
          window.history.replaceState({}, '', normalizedPath);
          setPathname(normalizedPath);
        }
        setProfileActiveTab(normalizedTab);
        if (!isMainPageFading && currentMainPage !== 'profile') {
          navigateMainPage('profile');
        }
        return;
      }

      if (isInboxPath(path)) {
        if (isDesktop) {
          window.history.replaceState({}, '', '/');
          setPathname('/');
          if (!isMainPageFading && currentMainPage !== 'lobby') {
            navigateMainPage('lobby');
          }
          return;
        }
        if (!isMainPageFading && currentMainPage !== 'inbox') {
          navigateMainPage('inbox');
        }
        return;
      }

      if (!isMainPageFading && currentMainPage !== 'lobby') {
        navigateMainPage('lobby');
      }
      return;
    }

    if (shouldResetTwoFactorOnBootRef.current && isTwoFactorPath(path)) {
      shouldResetTwoFactorOnBootRef.current = false;
      setAuthMode('login');
      setAuthForgotOpen(false);
      setAuthTwoFactorOpen(false);
      const loginPath = buildAuthPath('login');
      window.history.replaceState({}, '', loginPath);
      setPathname(loginPath);
      return;
    }

    shouldResetTwoFactorOnBootRef.current = false;

    if (isRoomPath(path)) {
      setAuthMode('login');
      setAuthForgotOpen(false);
      setAuthTwoFactorOpen(false);
      return;
    }

    const modeFromPath = getAuthModeFromPath(path);
    if (modeFromPath) {
      if (modeFromPath !== authMode) setAuthMode(modeFromPath);
      setAuthForgotOpen(isForgotPath(path));
      setAuthTwoFactorOpen(isTwoFactorPath(path));
      return;
    }

    setAuthMode('login');
    setAuthForgotOpen(false);
    setAuthTwoFactorOpen(false);
    const loginPath = buildAuthPath('login');
    window.history.replaceState({}, '', loginPath);
    setPathname(loginPath);
  }, [authMode, authReady, currentMainPage, isDesktop, isLegalPage, isMainPageFading, isVerifyPage, navigateMainPage, pathname, requestRoomSnapshot, room, roomRouteLoadingHash, user]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mediaQuery = window.matchMedia('(min-width: 768px)');
    const handleBreakpoint = (event) => {
      setIsDesktop(event.matches);
    };
    setIsDesktop(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleBreakpoint);
    return () => mediaQuery.removeEventListener('change', handleBreakpoint);
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    if (isInboxPath(pathname)) {
      window.history.replaceState({}, '', '/');
      setPathname('/');
    }
    if (currentMainPage === 'inbox') {
      setMainPageImmediate('lobby');
    }
  }, [currentMainPage, isDesktop, pathname, setMainPageImmediate]);

  useEffect(() => {
    if (!user || room) return;
    const tabFromPath = getSettingsTabFromPath(pathname);
    if (tabFromPath) {
      setProfileActiveTab(tabFromPath);
    }
  }, [pathname, room, user]);

  useEffect(() => {
    if (!user || room || isVerifyPage || isLegalPage) return undefined;
    let cancelled = false;
    refreshActiveRooms().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [isLegalPage, isVerifyPage, refreshActiveRooms, room, user]);

  useEffect(() => {
    if (!user) return undefined;

    prefetchContactsCache({ force: false });

    const onContactsChanged = () => {
      prefetchContactsCache({ force: true });
    };

    window.addEventListener(CONTACTS_CHANGED_EVENT, onContactsChanged);
    return () => {
      window.removeEventListener(CONTACTS_CHANGED_EVENT, onContactsChanged);
    };
  }, [user]);

  useEffect(() => {
    if (!user || typeof window === 'undefined') return undefined;
    let cancelled = false;

    const warm = () => {
      if (cancelled) return;
      warmInboxRuntimeCache({ force: false }).catch(() => {
        // ignore warmup failure
      });
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(() => warm(), { timeout: 1200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    const timer = window.setTimeout(() => warm(), 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [user]);

  useEffect(() => {
    if (!user || room || typeof window === 'undefined') return undefined;
    let cancelled = false;
    let timeoutId = null;
    let idleId = null;

    const prefetchProfileScreenChunk = () => {
      if (cancelled) return;
      loadProfileScreen().catch(() => {
        // ignore prefetch failure
      });
    };

    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(prefetchProfileScreenChunk, { timeout: 1500 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    timeoutId = window.setTimeout(prefetchProfileScreenChunk, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [room, user]);

  useEffect(() => {
    if (!user || typeof window === 'undefined') return undefined;
    const scheduleInboxRefresh = ({ forcePreferred = true } = {}) => {
      if (inboxRefreshTimerRef.current) {
        window.clearTimeout(inboxRefreshTimerRef.current);
      }
      inboxRefreshTimerRef.current = window.setTimeout(() => {
        inboxRefreshTimerRef.current = null;
        const now = Date.now();
        const shouldForce = forcePreferred && (now - inboxLastForceRefreshAtRef.current >= INBOX_FORCE_REFRESH_MIN_INTERVAL_MS);
        if (shouldForce) {
          inboxLastForceRefreshAtRef.current = now;
        }
        warmInboxRuntimeCache({ force: shouldForce }).catch(() => {
          // ignore sync failure
        });
      }, INBOX_EVENT_DEBOUNCE_MS);
    };

    const syncInboxCache = (event) => {
      if (event?.detail?.runtimeSynced) return;
      scheduleInboxRefresh({ forcePreferred: true });
    };

    window.addEventListener(INVITES_CHANGED_EVENT, syncInboxCache);
    return () => {
      if (inboxRefreshTimerRef.current) {
        window.clearTimeout(inboxRefreshTimerRef.current);
        inboxRefreshTimerRef.current = null;
      }
      window.removeEventListener(INVITES_CHANGED_EVENT, syncInboxCache);
    };
  }, [user]);

  const realtimeUserId = user?.id || '';

  useEffect(() => {
    if (!realtimeUserId || typeof window === 'undefined') return undefined;

    const wsBase = String(import.meta.env.VITE_REALTIME_WS_URL || REALTIME_WS_DEFAULT_URL).trim();
    let closedByCleanup = false;
    let reconnectAttempts = 0;
    const sessionUserId = normalizePresenceUserId(realtimeUserId);

    const emitPresenceChanged = () => {
      publishPresenceOnlineUserIds(Array.from(presenceOnlineUserIdsRef.current), Date.now());
    };

    const clearPresence = () => {
      presenceOnlineUserIdsRef.current = new Set();
      emitPresenceChanged();
    };
    const cancelPresenceClearTimer = () => {
      if (!presenceClearTimerRef.current) return;
      window.clearTimeout(presenceClearTimerRef.current);
      presenceClearTimerRef.current = null;
    };
    const schedulePresenceClear = () => {
      cancelPresenceClearTimer();
      presenceClearTimerRef.current = window.setTimeout(() => {
        presenceClearTimerRef.current = null;
        if (!realtimeConnectedRef.current) {
          clearPresence();
        }
      }, PRESENCE_CLEAR_GRACE_MS);
    };

    const setPresenceSnapshot = (onlineUserIds) => {
      const ids = normalizePresenceOnlineUserIds(onlineUserIds);
      const nextSet = new Set(ids);
      if (realtimeConnectedRef.current && sessionUserId) {
        nextSet.add(sessionUserId);
      }
      presenceOnlineUserIdsRef.current = nextSet;
      emitPresenceChanged();
    };

    const setPresenceUserOnline = (targetUserId, online) => {
      const uid = normalizePresenceUserId(targetUserId);
      if (!uid) return;
      const nextSet = new Set(presenceOnlineUserIdsRef.current);
      if (online) nextSet.add(uid);
      else nextSet.delete(uid);
      if (realtimeConnectedRef.current && sessionUserId) {
        nextSet.add(sessionUserId);
      }
      presenceOnlineUserIdsRef.current = nextSet;
      emitPresenceChanged();
    };

    const fetchRealtimeToken = async () => {
      try {
        const resp = await fetch('/api/realtime/token', { credentials: 'include' });
        const payload = await resp.json().catch(() => ({}));
        if (resp.status === 401) return { unauthorized: true, token: '' };
        if (!resp.ok || !payload?.ok || !payload?.token) return { unauthorized: false, token: '' };
        return { unauthorized: false, token: String(payload.token || '').trim() };
      } catch {
        return { unauthorized: false, token: '' };
      }
    };

    const scheduleRoomRefresh = () => {
      if (roomRefreshTimerRef.current) {
        window.clearTimeout(roomRefreshTimerRef.current);
      }
      roomRefreshTimerRef.current = window.setTimeout(() => {
        roomRefreshTimerRef.current = null;
        refreshActiveRooms().catch(() => {
          // Active room summaries will be refreshed by the next realtime event or page focus.
        });
      }, REALTIME_ROOM_REFRESH_DEBOUNCE_MS);
    };

    const scheduleCurrentRoomRefresh = (roomHash) => {
      const normalizedHash = getRoomHashFromPath(buildRoomPath(roomHash));
      if (!normalizedHash) return;
      if (currentRoomRefreshTimerRef.current) {
        window.clearTimeout(currentRoomRefreshTimerRef.current);
      }
      currentRoomRefreshTimerRef.current = window.setTimeout(async () => {
        currentRoomRefreshTimerRef.current = null;
        try {
          const nextRoom = await requestRoomSnapshot(normalizedHash);
          setRoom(nextRoom);
        } catch {
          // Current room can be refreshed by the next websocket event or a route reload.
        }
      }, REALTIME_ROOM_REFRESH_DEBOUNCE_MS);
    };

    const dispatchRealtimeEvent = (evt) => {
      if (!evt || typeof evt !== 'object') return;
      const eventType = String(evt.type || '').trim();
      const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {};

      if (eventType.startsWith('room.')) {
        const eventRoomHash = getRoomHashFromPath(buildRoomPath(payload.roomHash || payload.hash || payload.room?.hash));
        const currentRoomHash = getRoomHashFromPath(buildRoomPath(roomRef.current?.id || roomRef.current?.hash));
        scheduleRoomRefresh();
        if (eventRoomHash && currentRoomHash && eventRoomHash === currentRoomHash) {
          if (eventType === 'room.dismissed') {
            setRoom(null);
            if (isRoomPath(window.location.pathname)) {
              window.history.replaceState({}, '', '/');
              setPathname('/');
            }
          } else {
            scheduleCurrentRoomRefresh(eventRoomHash);
          }
        }
      }
      if (eventType === 'contact.added' || eventType === 'contact.removed') {
        publishContactsChanged({ reason: eventType });
        refreshInboxRuntimeAndNotify({ force: true, reason: eventType }).catch(() => {
          // Inbox panel can still refresh on open.
        });
      }
      if (eventType === 'profile.updated') {
        publishProfileUpdated(payload);
        publishContactsChanged({ reason: eventType });
        if (String(payload.userId || '').trim() === sessionUserId) {
          const nextUser = {
            ...userRef.current,
            id: userRef.current?.id || payload.userId,
            publicId: payload.publicId || userRef.current?.publicId || null,
            email: payload.email || userRef.current?.email || '',
            displayName: payload.displayName || userRef.current?.name,
            avatarUrl: payload.avatarUrl || userRef.current?.avatarUrl || null,
            locale: payload.locale || userRef.current?.locale || null,
          };
          handleUserUpdate(nextUser);
          writeCachedProfileMeta(nextUser, {
            id: nextUser.id,
            publicId: nextUser.publicId || null,
            email: nextUser.email,
            displayName: nextUser.displayName || nextUser.name || '',
            avatarUrl: nextUser.avatarUrl || null,
            locale: nextUser.locale || null,
          });
          clearProfileMetaCacheDirty(nextUser);
        }
      }
      if (eventType === 'invite.created' || eventType === 'invite.updated' || eventType === 'inbox.changed') {
        refreshInboxRuntimeAndNotify({ force: true, reason: eventType }).catch(() => {
          // Inbox panel can still refresh on open.
        });
      }
      if (eventType === 'media.updated' || eventType === 'media.deleted' || eventType === 'media.categories.updated') {
        publishMediaChanged({
          type: eventType,
          payload,
          ts: evt.ts || Date.now(),
        });
      }
      if (
        eventType === 'room.media.changed'
        || eventType === 'room.playback.updated'
        || eventType === 'room.message.created'
        || eventType === 'room.host.disconnected'
        || eventType === 'room.host.reconnected'
      ) {
        publishRoomRealtimeEvent({
          type: eventType,
          payload,
          ts: evt.ts || Date.now(),
        });
      }
      if (eventType === 'contact.removed') {
        const actorUserId = String(payload.actorUserId || '').trim();
        const removedDisplayName = String(payload.displayName || payload.name || '').trim() || t('profile.fallbackDisplayName');
        if (actorUserId !== sessionUserId) {
          window.dispatchEvent(new CustomEvent(REMOTE_CONTACT_REMOVED_EVENT, {
            detail: {
              contactUserId: payload.contactUserId || payload.userId || '',
              displayName: removedDisplayName,
            },
          }));
        }
      }
      if (eventType === 'presence.snapshot') {
        setPresenceSnapshot(payload.onlineUserIds || payload.users || []);
      }
      if (eventType === 'presence.update') {
        const targetUserId = payload.userId || payload.uid || payload.id;
        const nextOnline = payload.online ?? payload.isOnline ?? payload.status === 'online';
        setPresenceUserOnline(targetUserId, nextOnline);
      }
    };

    const scheduleReconnect = () => {
      if (closedByCleanup) return;
      const delay = Math.min(REALTIME_RECONNECT_BASE_MS * (2 ** reconnectAttempts), REALTIME_RECONNECT_MAX_MS);
      reconnectAttempts += 1;
      if (realtimeReconnectTimerRef.current) {
        window.clearTimeout(realtimeReconnectTimerRef.current);
      }
      realtimeReconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    const connect = async () => {
      if (closedByCleanup) return;
      if (realtimeSocketRef.current && (realtimeSocketRef.current.readyState === WebSocket.OPEN || realtimeSocketRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }

      const tokenResult = await fetchRealtimeToken();
      if (closedByCleanup) return;
      if (tokenResult.unauthorized) return;
      if (!tokenResult.token) {
        scheduleReconnect();
        return;
      }

      const wsUrl = `${wsBase.replace(/\/+$/, '')}/ws?token=${encodeURIComponent(tokenResult.token)}`;
      const socket = new WebSocket(wsUrl);
      realtimeSocketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttempts = 0;
        updateRealtimeConnected(true);
        cancelPresenceClearTimer();
        if (sessionUserId) {
          setPresenceUserOnline(sessionUserId, true);
        }
      });

      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(String(event.data || '{}'));
          dispatchRealtimeEvent(parsed);
        } catch {
          // ignore malformed message
        }
      });

      socket.addEventListener('close', () => {
        if (realtimeSocketRef.current === socket) {
          realtimeSocketRef.current = null;
        }
        updateRealtimeConnected(false);
        if (!closedByCleanup) {
          schedulePresenceClear();
          scheduleReconnect();
        }
      });

      socket.addEventListener('error', () => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.close();
          } catch {
            // ignore
          }
        }
      });
    };

    connect();

    const reconnectOnForeground = () => {
      if (closedByCleanup) return;
      if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
      const socket = realtimeSocketRef.current;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
      if (realtimeReconnectTimerRef.current) {
        window.clearTimeout(realtimeReconnectTimerRef.current);
        realtimeReconnectTimerRef.current = null;
      }
      reconnectAttempts = 0;
      connect();
    };

    window.addEventListener('focus', reconnectOnForeground);
    document.addEventListener('visibilitychange', reconnectOnForeground);

    return () => {
      closedByCleanup = true;
      window.removeEventListener('focus', reconnectOnForeground);
      document.removeEventListener('visibilitychange', reconnectOnForeground);
      updateRealtimeConnected(false);
      cancelPresenceClearTimer();
      if (realtimeReconnectTimerRef.current) {
        window.clearTimeout(realtimeReconnectTimerRef.current);
        realtimeReconnectTimerRef.current = null;
      }
      if (roomRefreshTimerRef.current) {
        window.clearTimeout(roomRefreshTimerRef.current);
        roomRefreshTimerRef.current = null;
      }
      if (currentRoomRefreshTimerRef.current) {
        window.clearTimeout(currentRoomRefreshTimerRef.current);
        currentRoomRefreshTimerRef.current = null;
      }
      if (realtimeSocketRef.current) {
        try {
          realtimeSocketRef.current.close(1000, 'user_changed');
        } catch {
          // ignore
        }
        realtimeSocketRef.current = null;
      }
      clearPresence();
    };
  }, [handleUserUpdate, refreshActiveRooms, realtimeUserId, requestRoomSnapshot]);

  const handleAuthModeChange = (nextMode) => {
    const mode = normalizeAuthMode(nextMode);
    setAuthMode(mode);
    setAuthForgotOpen(false);
    setAuthTwoFactorOpen(false);
    const targetPath = buildAuthPath(mode);
    if (pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
      setPathname(targetPath);
    }
  };

  const handleForgotModalChange = (open) => {
    const nextOpen = Boolean(open);
    setAuthForgotOpen(nextOpen);
    if (nextOpen) setAuthTwoFactorOpen(false);
    const targetPath = nextOpen ? AUTH_FORGOT_PATH : buildAuthPath('login');
    if (pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
      setPathname(targetPath);
    }
  };

  const handleTwoFactorModalChange = (open) => {
    const nextOpen = Boolean(open);
    setAuthTwoFactorOpen(nextOpen);
    if (nextOpen) setAuthForgotOpen(false);
    const targetPath = nextOpen ? AUTH_TWO_FACTOR_PATH : buildAuthPath('login');
    if (pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
      setPathname(targetPath);
    }
  };

  const toggleTheme = useCallback(async (event) => {
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount > 0) {
      selection.removeAllRanges();
    }

    const buttonRect = event?.currentTarget?.getBoundingClientRect?.();
    const x = buttonRect ? buttonRect.left + buttonRect.width / 2 : (event?.clientX ?? window.innerWidth / 2);
    const y = buttonRect ? buttonRect.top + buttonRect.height / 2 : (event?.clientY ?? window.innerHeight / 2);
    const startRadius = buttonRect ? Math.max(buttonRect.width, buttonRect.height) / 2 : 22;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ) * 1.05;

    const applyThemeToggle = (sync = false) => {
      const updater = () => {
        setIsDark((prev) => {
          const next = !prev;
          localStorage.setItem('theme', next ? 'dark' : 'light');
          return next;
        });
      };
      if (sync) {
        flushSync(updater);
      } else {
        updater();
      }
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduceMotion) {
      applyThemeToggle();
      return;
    }

    if (themeTransitionRunningRef.current) {
      applyThemeToggle();
      return;
    }

    document.documentElement.style.setProperty('--theme-transition-x', `${x}px`);
    document.documentElement.style.setProperty('--theme-transition-y', `${y}px`);
    document.documentElement.style.setProperty('--theme-transition-start-radius', `${startRadius}px`);
    document.documentElement.style.setProperty('--theme-transition-end-radius', `${endRadius}px`);

    const nextMode = isDark ? 'to-light' : 'to-dark';
    document.documentElement.dataset.themeTransition = nextMode;
    themeTransitionRunningRef.current = true;

    let transition = null;
    try {
      transition = document.startViewTransition(() => {
        applyThemeToggle(true);
      });
    } catch {
      themeTransitionRunningRef.current = false;
      delete document.documentElement.dataset.themeTransition;
      applyThemeToggle();
      return;
    }

    try {
      await transition.finished.catch(() => { });
    } finally {
      themeTransitionRunningRef.current = false;
      delete document.documentElement.dataset.themeTransition;
    }
  }, [isDark]);

  const handleOpenProfile = useCallback(() => {
    const nextTab = SETTINGS_TAB_PROFILE;
    navigateMainPage('profile');
    runAfterFrames(() => {
      setProfileActiveTab(nextTab);
      const targetPath = buildSettingsPath(nextTab);
      setPathname((currentPath) => {
        if (currentPath !== targetPath) {
          window.history.pushState({}, '', targetPath);
          return targetPath;
        }
        return currentPath;
      });
    }, 2);
  }, [navigateMainPage, runAfterFrames]);

  const handleCloseProfile = useCallback(() => {
    setPathname((currentPath) => {
      if (currentPath !== '/') {
        window.history.pushState({}, '', '/');
        return '/';
      }
      return currentPath;
    });
    navigateMainPage('lobby');
  }, [navigateMainPage]);

  const handleOpenMobileInbox = useCallback(() => {
    if (isDesktop) return;
    setPathname((currentPath) => {
      if (currentPath !== INBOX_PATH) {
        window.history.pushState({}, '', INBOX_PATH);
        return INBOX_PATH;
      }
      return currentPath;
    });
    navigateMainPage('inbox');
  }, [isDesktop, navigateMainPage]);

  const handleCloseMobileInbox = useCallback(() => {
    setPathname((currentPath) => {
      if (currentPath !== '/') {
        window.history.pushState({}, '', '/');
        return '/';
      }
      return currentPath;
    });
    navigateMainPage('lobby');
  }, [navigateMainPage]);

  const handleProfileTabChange = useCallback((nextTab) => {
    const tab = String(nextTab || '').trim();
    if (!tab) return;
    setProfileActiveTab(tab);
    const targetPath = buildSettingsPath(tab);
    setPathname((currentPath) => {
      if (currentPath !== targetPath) {
        window.history.pushState({}, '', targetPath);
        return targetPath;
      }
      return currentPath;
    });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Ignore network errors on logout and clear local auth state anyway.
    }
    setAuthEnterAnimationVersion((prev) => prev + 1);
    handleUserUpdate(null);
    setMainPageImmediate('lobby');
    setRoom(null);
  }, [handleUserUpdate, setMainPageImmediate]);

  const closeRoomByHash = useCallback(async (roomHash) => {
    const normalizedHash = getRoomHashFromPath(buildRoomPath(roomHash));
    if (!normalizedHash) throw new Error('invalid_room');
    const targetRoom = activeRoomSummaries.find((item) => item.id === normalizedHash);
    const action = targetRoom && !targetRoom.isHost ? 'leave' : 'dismiss';
    const response = await fetch(`/api/rooms/${encodeURIComponent(normalizedHash)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: buildRoomClientHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    setActiveRoomSummaries((prev) => prev.filter((item) => item.id !== normalizedHash));
    if (room?.id === normalizedHash) setRoom(null);
  }, [activeRoomSummaries, room?.id]);

  const handleJoinRoom = useCallback(async (nextRoom) => {
    const mode = String(nextRoom?.mode || '').trim();
    const normalizedHash = getRoomHashFromPath(buildRoomPath(nextRoom?.id));
    if (mode !== 'create' && !normalizedHash) throw new Error('invalid_room');
    const activeHostRoom = activeRoomSummaries.find((item) => (
      item.isHost && (item.status === 'open' || item.status === 'host_disconnected')
    ));
    if (!nextRoom?.skipHostConflictCheck && mode !== 'create' && activeHostRoom && activeHostRoom.id !== normalizedHash) {
      throw new Error('active_host_room_exists');
    }
    const shouldDismissHostedRoom = mode !== 'create'
      && activeHostRoom
      && activeHostRoom.id !== normalizedHash
      && Boolean(nextRoom?.dismissHostedRoom || nextRoom?.closeHostRoomId || nextRoom?.skipHostConflictCheck);
    const normalizedRoom = mode === 'create'
      ? await requestRoomSnapshot('', {
        createBody: {
          title: nextRoom?.title || t('room.defaultRoomTitle'),
          notice: nextRoom?.notice || '',
          maxMembers: nextRoom?.maxMembers || 8,
          hostOnlyControl: nextRoom?.hostOnlyControl !== false,
          allowChat: nextRoom?.allowChat !== false,
        },
      })
      : await requestRoomSnapshot(normalizedHash, {
        join: true,
        joinBody: shouldDismissHostedRoom ? { dismissHostedRoom: true } : null,
      });
    const roomHash = getRoomHashFromPath(buildRoomPath(normalizedRoom?.id));
    if (!roomHash) throw new Error('invalid_room');
    const targetPath = buildRoomPath(roomHash);
    roomLoadRef.current = { hash: roomHash, inFlight: false };
    setRoom(normalizedRoom);
    setActiveRoomSummaries((prev) => [normalizedRoom, ...prev.filter((item) => item.id !== normalizedRoom.id)]);
    setPathname((currentPath) => {
      if (currentPath !== targetPath) {
        window.history.pushState({}, '', targetPath);
        return targetPath;
      }
      return currentPath;
    });
  }, [activeRoomSummaries, requestRoomSnapshot]);

  const handleJoinRoomInvite = useCallback(async (roomHash) => {
    const normalizedHash = getRoomHashFromPath(buildRoomPath(roomHash));
    if (!normalizedHash) throw new Error('invalid_room');
    setPendingJoinRoomInvite({ hash: normalizedHash, nonce: Date.now() });
    setRoom(null);
    setPathname((currentPath) => {
      if (currentPath !== '/') {
        window.history.pushState({}, '', '/');
        return '/';
      }
      return currentPath;
    });
    if (!isMainPageFading && currentMainPage !== 'lobby') {
      navigateMainPage('lobby');
    }
  }, [currentMainPage, isMainPageFading, navigateMainPage]);

  const handleResumeRoom = useCallback(async (targetRoom) => {
    const roomHash = getRoomHashFromPath(buildRoomPath(targetRoom?.id));
    if (!roomHash) return;
    let nextRoom = null;
    if (targetRoom?.isHost) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomHash)}/heartbeat`, {
        method: 'POST',
        credentials: 'include',
        headers: buildRoomClientHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false || !payload?.data?.room?.hash) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      nextRoom = mapRoomSnapshotToRoom(payload.data, user?.id);
    } else {
      nextRoom = await requestRoomSnapshot(roomHash, { join: true });
    }
    const targetPath = buildRoomPath(roomHash);
    roomLoadRef.current = { hash: roomHash, inFlight: false };
    setRoom(nextRoom);
    setPathname((currentPath) => {
      if (currentPath !== targetPath) {
        window.history.pushState({}, '', targetPath);
        return targetPath;
      }
      return currentPath;
    });
  }, [requestRoomSnapshot, user?.id]);

  const handleLeaveRoom = useCallback(async () => {
    const roomHash = getRoomHashFromPath(buildRoomPath(room?.id));
    if (roomHash) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomHash)}/leave`, {
        method: 'POST',
        credentials: 'include',
        headers: buildRoomClientHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      if (payload?.data?.room?.hash) {
        const nextRoom = mapRoomSnapshotToRoom(payload.data, user?.id);
        if (nextRoom?.id) {
          setActiveRoomSummaries((prev) => [nextRoom, ...prev.filter((item) => item.id !== nextRoom.id)]);
        }
      }
    }
    roomLoadRef.current = { hash: '', inFlight: false };
    setRoom(null);
    refreshActiveRooms();
    setPathname((currentPath) => {
      if (isRoomPath(currentPath)) {
        window.history.pushState({}, '', '/');
        return '/';
      }
      return currentPath;
    });
  }, [refreshActiveRooms, room?.id, user?.id]);

  const handleDismissRoom = useCallback(async () => {
    const roomHash = getRoomHashFromPath(buildRoomPath(room?.id));
    if (!roomHash) return;
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomHash)}/dismiss`, {
      method: 'POST',
      credentials: 'include',
      headers: buildRoomClientHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    roomLoadRef.current = { hash: '', inFlight: false };
    setRoom(null);
    refreshActiveRooms();
    setPathname((currentPath) => {
      if (isRoomPath(currentPath)) {
        window.history.pushState({}, '', '/');
        return '/';
      }
      return currentPath;
    });
  }, [refreshActiveRooms, room?.id]);

  const lockViewportScroll = authReady && !isVerifyPage && !isLegalPage && Boolean(user);
  const roomRouteHash = isRoomPath(pathname) ? getRoomHashFromPath(pathname) : '';
  const shouldHoldRoomRoute = Boolean(
    user
      && roomRouteHash
      && (!room || room.id !== roomRouteHash),
  );

  useEffect(() => {
    if (!lockViewportScroll || typeof document === 'undefined') return undefined;

    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const prevHtmlOverflow = htmlEl.style.overflow;
    const prevBodyOverflow = bodyEl.style.overflow;
    const prevHtmlOverscroll = htmlEl.style.overscrollBehavior;
    const prevBodyOverscroll = bodyEl.style.overscrollBehavior;

    htmlEl.style.overflow = 'hidden';
    bodyEl.style.overflow = 'hidden';
    htmlEl.style.overscrollBehavior = 'none';
    bodyEl.style.overscrollBehavior = 'none';

    return () => {
      htmlEl.style.overflow = prevHtmlOverflow;
      bodyEl.style.overflow = prevBodyOverflow;
      htmlEl.style.overscrollBehavior = prevHtmlOverscroll;
      bodyEl.style.overscrollBehavior = prevBodyOverscroll;
    };
  }, [lockViewportScroll]);

  return (
    <div className={`${isDark ? 'dark' : ''} antialiased`}>
      <div className={`${lockViewportScroll ? 'h-[100svh] md:h-screen overflow-hidden overscroll-none' : 'min-h-dvh'} bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-gray-100 font-sans selection:bg-blue-500/30`}>
        {!authReady ? null : (
          <>
            {isVerifyPage ? (
              <VerifyEmailScreen />
            ) : isLegalPage ? (
              <LegalScreen page={legalPage} isDark={isDark} onToggleTheme={toggleTheme} />
            ) : !user ? (
              <AuthScreen
                enterAnimationVersion={authEnterAnimationVersion}
                onLogin={handleUserUpdate}
                initialMode={authMode}
                onModeChange={handleAuthModeChange}
                forgotOpen={authForgotOpen}
                onForgotModalChange={handleForgotModalChange}
                twoFactorOpen={authTwoFactorOpen}
                onTwoFactorModalChange={handleTwoFactorModalChange}
                isDark={isDark}
                toggleTheme={toggleTheme}
              />
            ) : shouldHoldRoomRoute ? (
              <div className="flex h-full w-full items-center justify-center bg-[#F5F5F7] dark:bg-zinc-950" aria-busy="true">
                <div className="h-9 w-9 animate-spin rounded-full border-4 border-slate-200 border-t-blue-500 dark:border-zinc-800 dark:border-t-blue-400" />
              </div>
            ) : !room ? (
              <div className="h-full w-full bg-[#F5F5F7] dark:bg-zinc-950 overflow-hidden overscroll-none relative">
                <div
                  className={`absolute inset-0 bg-[#F5F5F7] dark:bg-zinc-950 ${PAGE_SWITCH_TRANSITION_CLASS} ${isMainPageFading ? PAGE_SWITCH_HIDDEN_CLASS : PAGE_SWITCH_VISIBLE_CLASS}`}
                >
                  <div className={`h-full w-full ${currentMainPage === 'lobby' ? 'block' : 'hidden'}`}>
                    <LobbyScreen
                      user={user}
                      onJoinRoom={handleJoinRoom}
                      activeRoom={primaryActiveRoom}
                      onResumeRoom={handleResumeRoom}
                      onCloseActiveRoom={closeRoomByHash}
                      onOpenProfile={handleOpenProfile}
                      onOpenMobileInbox={handleOpenMobileInbox}
                      onJoinRoomInvite={handleJoinRoomInvite}
                      pendingJoinRoomInvite={pendingJoinRoomInvite}
                      onPendingJoinRoomInviteConsumed={() => setPendingJoinRoomInvite(null)}
                      isRealtimeConnected={isRealtimeConnected}
                      isSelfOnline={isRealtimeConnected}
                      isDark={isDark}
                      toggleTheme={toggleTheme}
                    />
                  </div>

                  <div className={`h-full w-full ${currentMainPage === 'profile' ? 'block' : 'hidden'}`}>
                    <Suspense fallback={<div className="h-full w-full" />}>
                      <ProfileScreen
                        user={user}
                        initialTab={profileActiveTab}
                        onTabChange={handleProfileTabChange}
                        onUpdateUser={handleUserUpdate}
                        onBack={handleCloseProfile}
                        isOpen={currentMainPage === 'profile' && !isMainPageFading}
                        cleanupDelayMs={PAGE_SWITCH_DURATION_MS + 60}
                        onLogout={handleLogout}
                        isDark={isDark}
                        toggleTheme={toggleTheme}
                        activeRoom={primaryActiveRoom}
                      />
                    </Suspense>
                  </div>

                  <div className={`h-full w-full ${currentMainPage === 'inbox' ? 'block' : 'hidden'}`}>
                    <InboxDemoPanel
                      isOpen={currentMainPage === 'inbox' && !isMainPageFading}
                      onClose={handleCloseMobileInbox}
                      isDark={isDark}
                      isRealtimeConnected={isRealtimeConnected}
                      onUnreadCountChange={() => { }}
                      onJoinRoomInvite={handleJoinRoomInvite}
                      floating={false}
                      fullScreen
                    />
                  </div>
                </div>
              </div>
            ) : (
              <WatchRoom
                key={room.id || room.hash}
                user={user}
                room={room}
                onLeave={handleLeaveRoom}
                onDismiss={handleDismissRoom}
                isDark={isDark}
                toggleTheme={toggleTheme}
              />
            )}
            {contactNoticeModal.open ? (
              <div className={`modal-overlay ${isContactNoticeClosing ? 'closing' : ''}`} onClick={closeContactNoticeModal}>
                <div
                  className={`auth-card modal-content modal-content--compact ${isContactNoticeClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="modal-sheet-handle" />
                  <div className="modal-aura is-success" />
                  <div className="modal-body">
                    <div className="modal-icon-badge is-success">
                      <div className="modal-icon-core">
                        <Users className="modal-icon-glyph w-8 h-8" />
                      </div>
                    </div>
                    <h3 className="modal-heading">{contactNoticeModal.title}</h3>
                    <p className="modal-copy">{contactNoticeModal.content}</p>
                  </div>
                  <div className="modal-actions single">
                    <button type="button" onClick={closeContactNoticeModal} className="modal-btn modal-btn-primary">
                      {t('auth.modalAcknowledge')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
