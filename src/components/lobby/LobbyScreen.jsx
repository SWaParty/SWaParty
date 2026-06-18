import {
  AlertCircle,
  ArrowRight,
  Film,
  Home,
  List,
  LogOut,
  Mail,
  Minus,
  Moon,
  Play,
  Plus,
  Radio,
  Sparkles,
  Settings,
  Sun,
  Trash2,
  Users,
} from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import MobileBottomTabBar from '../common/MobileBottomTabBar';
import { t } from '../../i18n';
import {
  INVITES_CHANGED_EVENT,
  INBOX_RUNTIME_UPDATED_EVENT,
  inboxRuntimeCache,
  warmInboxRuntimeCache,
} from '../../lib/inboxRuntimeCache';
import InboxDemoPanel from './InboxPanel';
import MediaLibraryPanel from './MediaLibraryPanel';

const MODAL_CLOSE_MS = 340;
const JOIN_ERROR_HIDE_MS = 1500;
const JOIN_ERROR_SHAKE_MS = 420;

function countUnreadInboxItems(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return items.reduce((acc, item) => {
    const readAt = Number(item?.readAt || 0);
    const updatedAt = Number(item?.updatedAt || item?.createdAt || 0);
    const isRead = Number.isFinite(readAt) && readAt > 0 && readAt >= updatedAt;
    return acc + (isRead ? 0 : 1);
  }, 0);
}

function formatClockTime(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function waitForModalExit() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, MODAL_CLOSE_MS);
  });
}

function mapJoinRoomError(error) {
  const message = String(error?.message || error || '').trim();
  const normalized = message.toLowerCase();
  if (
    normalized.includes('room_not_found')
    || normalized.includes('not_found')
    || normalized.includes('not found')
    || normalized.includes('invalid_room')
  ) {
    return t('lobby.joinRoomInvalidHint');
  }
  return message || t('lobby.joinRoomFailedHint');
}

function ModalShell({
  mounted = true,
  active = true,
  closing = false,
  onClose,
  contentClassName = '',
  inactiveOverlayClassName = 'fixed inset-0 z-[60] opacity-0 pointer-events-none',
  inactiveContentClassName = 'translate-y-full',
  children,
}) {
  if (!mounted) return null;

  const overlayClassName = active
    ? `modal-overlay ${closing ? 'closing' : ''}`
    : inactiveOverlayClassName;
  const contentStateClassName = active ? '' : inactiveContentClassName;

  return (
    <div className={overlayClassName} onClick={active ? onClose : undefined}>
      <div
        className={`${contentClassName} ${closing ? 'closing' : ''} ${contentStateClassName}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const LobbyScreen = memo(function LobbyScreen({
  user,
  onJoinRoom,
  activeRoom = null,
  onResumeRoom,
  onCloseActiveRoom,
  onOpenProfile,
  onOpenMobileInbox,
  onJoinRoomInvite,
  pendingJoinRoomInvite,
  onPendingJoinRoomInviteConsumed,
  isRealtimeConnected = false,
  isSelfOnline = false,
  isDark,
  toggleTheme,
}) {
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  const [roomId, setRoomId] = useState('');
  const [desktopInboxOpen, setDesktopInboxOpen] = useState(false);
  const [showRoomSetupModal, setShowRoomSetupModal] = useState(false);
  const [isRoomSetupClosing, setIsRoomSetupClosing] = useState(false);
  const [roomSetupForm, setRoomSetupForm] = useState({
    title: '',
    notice: '',
    maxMembers: 8,
  });
  const [roomActionLoading, setRoomActionLoading] = useState(false);
  const [roomActionError, setRoomActionError] = useState('');
  const [joinInlineError, setJoinInlineError] = useState('');
  const [joinErrorShaking, setJoinErrorShaking] = useState(false);
  const [roomConfirm, setRoomConfirm] = useState({
    open: false,
    action: '',
    targetRoomId: '',
    title: '',
    message: '',
    confirmLabel: '',
    danger: false,
  });
  const [isRoomConfirmClosing, setIsRoomConfirmClosing] = useState(false);
  const roomConfirmCloseTimerRef = useRef(null);
  const joinErrorHideTimerRef = useRef(null);
  const joinErrorShakeTimerRef = useRef(null);
  const activeRoomRef = useRef(activeRoom);
  const performJoinRoomRef = useRef(null);
  const consumePendingJoinRoomInviteRef = useRef(onPendingJoinRoomInviteConsumed);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 768px)').matches;
  });
  const [isMediaPanelReady, setIsMediaPanelReady] = useState(false);
  const isInboxOpen = desktopInboxOpen;
  const activeRoomMemberCount = Array.isArray(activeRoom?.members) ? activeRoom.members.length : 0;
  const activeRoomPlaybackTitle = String(activeRoom?.playback?.mediaTitle || '').trim();
  const activeRoomSuspended = activeRoom?.status === 'host_disconnected';
  const activeRoomSubtitle = activeRoomSuspended
    ? t('lobby.activeRoomSuspended', { time: formatClockTime(activeRoom?.expiresAt) })
    : activeRoomPlaybackTitle
      ? t('lobby.activeRoomPlaying', { title: activeRoomPlaybackTitle })
      : t('lobby.activeRoomMemberCount', { count: activeRoomMemberCount || 1 });
  const lobbyAccordionClass = 'transition-[min-height,background-color,border-color,color,box-shadow] [transition-duration:640ms] [transition-timing-function:cubic-bezier(0.18,0.88,0.22,1)]';
  activeRoomRef.current = activeRoom;
  consumePendingJoinRoomInviteRef.current = onPendingJoinRoomInviteConsumed;

  const clearJoinInlineError = useCallback(() => {
    if (joinErrorHideTimerRef.current) {
      window.clearTimeout(joinErrorHideTimerRef.current);
      joinErrorHideTimerRef.current = null;
    }
    if (joinErrorShakeTimerRef.current) {
      window.clearTimeout(joinErrorShakeTimerRef.current);
      joinErrorShakeTimerRef.current = null;
    }
    setJoinInlineError('');
    setJoinErrorShaking(false);
  }, []);

  const showJoinInlineError = useCallback((message) => {
    if (joinErrorHideTimerRef.current) {
      window.clearTimeout(joinErrorHideTimerRef.current);
      joinErrorHideTimerRef.current = null;
    }
    if (joinErrorShakeTimerRef.current) {
      window.clearTimeout(joinErrorShakeTimerRef.current);
      joinErrorShakeTimerRef.current = null;
    }
    setJoinInlineError(message);
    setJoinErrorShaking(false);
    window.requestAnimationFrame(() => setJoinErrorShaking(true));
    joinErrorShakeTimerRef.current = window.setTimeout(() => {
      joinErrorShakeTimerRef.current = null;
      setJoinErrorShaking(false);
    }, JOIN_ERROR_SHAKE_MS);
    joinErrorHideTimerRef.current = window.setTimeout(() => {
      joinErrorHideTimerRef.current = null;
      setJoinInlineError('');
    }, JOIN_ERROR_HIDE_MS);
  }, []);

  const openRoomConfirm = (nextConfirm) => {
    if (roomConfirmCloseTimerRef.current) {
      window.clearTimeout(roomConfirmCloseTimerRef.current);
      roomConfirmCloseTimerRef.current = null;
    }
    setIsRoomConfirmClosing(false);
    setRoomConfirm({
      open: true,
      action: '',
      targetRoomId: '',
      title: '',
      message: '',
      confirmLabel: '',
      danger: false,
      ...nextConfirm,
    });
  };

  const closeRoomConfirm = useCallback(() => {
    if (!roomConfirm.open || isRoomConfirmClosing) return;
    setIsRoomConfirmClosing(true);
    roomConfirmCloseTimerRef.current = window.setTimeout(() => {
      roomConfirmCloseTimerRef.current = null;
      setRoomConfirm((prev) => ({ ...prev, open: false }));
      setIsRoomConfirmClosing(false);
    }, MODAL_CLOSE_MS);
  }, [isRoomConfirmClosing, roomConfirm.open]);

  const performCreateRoom = async ({ closeHostRoomId = '' } = {}) => {
    if (roomActionLoading) return;
    const defaultTitle = t('lobby.roomSetupFieldTitlePlaceholder');
    const defaultNotice = t('lobby.roomSetupFieldNoticePlaceholder');
    const title = String(roomSetupForm.title || '').trim() || defaultTitle;
    const notice = String(roomSetupForm.notice || '').trim() || defaultNotice;
    const nextMaxMembers = Number(roomSetupForm.maxMembers);
    const maxMembers = Number.isFinite(nextMaxMembers) ? Math.min(99, Math.max(2, Math.floor(nextMaxMembers))) : 8;

    setRoomActionLoading(true);
    setRoomActionError('');
    try {
      await onJoinRoom({
        mode: 'create',
        title,
        notice,
        maxMembers,
        hostOnlyControl: true,
        allowChat: true,
        closeHostRoomId,
        skipHostConflictCheck: Boolean(closeHostRoomId),
      });
      setShowRoomSetupModal(false);
      setIsRoomSetupClosing(false);
    } catch (error) {
      setRoomActionError(error?.message || 'Failed to create room');
    } finally {
      setRoomActionLoading(false);
    }
  };

  const createRoom = async () => {
    await performCreateRoom();
  };

  const performJoinRoom = async (nextRoomId, { closeHostRoomId = '' } = {}) => {
    if (roomActionLoading) return;
    if (!nextRoomId) return;

    setRoomActionLoading(true);
    setRoomActionError('');
    clearJoinInlineError();
    try {
      await onJoinRoom({
        mode: 'join',
        id: nextRoomId,
        closeHostRoomId,
        skipHostConflictCheck: Boolean(closeHostRoomId),
      });
    } catch (error) {
      showJoinInlineError(mapJoinRoomError(error));
    } finally {
      setRoomActionLoading(false);
    }
  };
  performJoinRoomRef.current = performJoinRoom;

  const joinRoom = async (event) => {
    event.preventDefault();
    const nextRoomId = roomId.trim().toUpperCase();
    if (!nextRoomId) return;
    if (activeRoom?.isHost && activeRoom.id !== nextRoomId) {
      openRoomConfirm({
        action: 'join',
        targetRoomId: nextRoomId,
        title: t('lobby.confirmJoinRoomTitle'),
        message: t('lobby.confirmJoinRoomMessage', { target: nextRoomId, current: activeRoom.id }),
        confirmLabel: t('lobby.confirmJoinRoomAction'),
        danger: true,
      });
      return;
    }
    await performJoinRoom(nextRoomId);
  };

  useEffect(() => {
    const nextRoomId = String(pendingJoinRoomInvite?.hash || '').trim().toUpperCase();
    if (!nextRoomId) return;
    setRoomId(nextRoomId);
    if (typeof consumePendingJoinRoomInviteRef.current === 'function') {
      consumePendingJoinRoomInviteRef.current();
    }
    const currentActiveRoom = activeRoomRef.current;
    if (currentActiveRoom?.isHost && currentActiveRoom.id !== nextRoomId) {
      openRoomConfirm({
        action: 'join',
        targetRoomId: nextRoomId,
        title: t('lobby.confirmJoinRoomTitle'),
        message: t('lobby.confirmJoinRoomMessage', { target: nextRoomId, current: currentActiveRoom.id }),
        confirmLabel: t('lobby.confirmJoinRoomAction'),
        danger: true,
      });
      return;
    }
    void performJoinRoomRef.current?.(nextRoomId);
  }, [pendingJoinRoomInvite?.hash, pendingJoinRoomInvite?.nonce]);

  const closeActiveRoom = async () => {
    if (!activeRoom?.id || typeof onCloseActiveRoom !== 'function') return;
    if (activeRoom.isHost) {
      openRoomConfirm({
        action: 'close',
        title: t('lobby.confirmCloseRoomTitle'),
        message: t('lobby.confirmCloseRoomMessage', { id: activeRoom.id }),
        confirmLabel: t('lobby.confirmCloseRoomAction'),
        danger: true,
      });
      return;
    }
    setRoomActionLoading(true);
    setRoomActionError('');
    try {
      await onCloseActiveRoom(activeRoom.id);
    } catch (error) {
      setRoomActionError(error?.message || 'Failed to close room');
    } finally {
      setRoomActionLoading(false);
    }
  };

  const confirmRoomAction = async () => {
    const action = roomConfirm.action;
    const targetRoomId = roomConfirm.targetRoomId;
    closeRoomConfirm();
    await waitForModalExit();
    if (action === 'close') {
      setRoomActionLoading(true);
      setRoomActionError('');
      try {
        await onCloseActiveRoom(activeRoom.id);
      } catch (error) {
        setRoomActionError(error?.message || 'Failed to close room');
      } finally {
        setRoomActionLoading(false);
      }
      return;
    }
    if (action === 'join') {
      await performJoinRoom(targetRoomId, { closeHostRoomId: activeRoom?.id || '' });
      return;
    }
    if (action === 'create') {
      await performCreateRoom({ closeHostRoomId: activeRoom?.id || '' });
    }
  };

  const closeInboxPanel = () => {
    if (isDesktop) setDesktopInboxOpen(false);
  };

  const toggleInboxPanel = () => {
    if (isDesktop) {
      setDesktopInboxOpen((prev) => !prev);
      return;
    }
    if (typeof onOpenMobileInbox === 'function') onOpenMobileInbox();
  };

  const openRoomSetupModal = () => {
    setRoomActionError('');
    setRoomSetupForm({ title: '', notice: '', maxMembers: 8 });
    setIsRoomSetupClosing(false);
    setShowRoomSetupModal(true);
  };

  const closeRoomSetupModal = useCallback(() => {
    if (isRoomSetupClosing) return;
    setIsRoomSetupClosing(true);
    window.setTimeout(() => {
      setShowRoomSetupModal(false);
      setIsRoomSetupClosing(false);
    }, MODAL_CLOSE_MS);
  }, [isRoomSetupClosing]);

  useEffect(() => {
    return () => {
      if (roomConfirmCloseTimerRef.current) {
        window.clearTimeout(roomConfirmCloseTimerRef.current);
        roomConfirmCloseTimerRef.current = null;
      }
      if (joinErrorHideTimerRef.current) {
        window.clearTimeout(joinErrorHideTimerRef.current);
        joinErrorHideTimerRef.current = null;
      }
      if (joinErrorShakeTimerRef.current) {
        window.clearTimeout(joinErrorShakeTimerRef.current);
        joinErrorShakeTimerRef.current = null;
      }
    };
  }, []);

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
    if (typeof window === 'undefined') return undefined;
    if (window.innerWidth >= 768) return undefined;

    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const prevHtmlOverflow = htmlEl.style.overflow;
    const prevBodyOverflow = bodyEl.style.overflow;

    if (showRoomSetupModal) {
      htmlEl.style.overflow = 'hidden';
      bodyEl.style.overflow = 'hidden';
    } else {
      htmlEl.style.overflow = prevHtmlOverflow;
      bodyEl.style.overflow = prevBodyOverflow;
    }

    return () => {
      htmlEl.style.overflow = prevHtmlOverflow;
      bodyEl.style.overflow = prevBodyOverflow;
    };
  }, [showRoomSetupModal]);

  useEffect(() => {
    if (!isDesktop) {
      setDesktopInboxOpen(false);
      return;
    }
  }, [isDesktop]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsMediaPanelReady(true);
      return undefined;
    }

    let cancelled = false;
    let timeoutId = null;
    let idleId = null;
    const markReady = () => {
      if (!cancelled) setIsMediaPanelReady(true);
    };

    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(markReady, { timeout: 180 });
    } else {
      timeoutId = window.setTimeout(markReady, 80);
    }

    return () => {
      cancelled = true;
      if (idleId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const syncUnreadFromCache = () => {
      if (cancelled) return;
      const nextUnread = countUnreadInboxItems(inboxRuntimeCache.items);
      setInboxUnreadCount(nextUnread);
    };

    const ensureSynced = () => {
      const task = warmInboxRuntimeCache({ force: false });
      if (task && typeof task.then === 'function') {
        task.finally(syncUnreadFromCache);
        return;
      }
      syncUnreadFromCache();
    };

    ensureSynced();
    window.addEventListener(INVITES_CHANGED_EVENT, ensureSynced);
    window.addEventListener(INBOX_RUNTIME_UPDATED_EVENT, syncUnreadFromCache);
    return () => {
      cancelled = true;
      window.removeEventListener(INVITES_CHANGED_EVENT, ensureSynced);
      window.removeEventListener(INBOX_RUNTIME_UPDATED_EVENT, syncUnreadFromCache);
    };
  }, []);

  useEffect(() => {
    if (!showRoomSetupModal || isRoomSetupClosing) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRoomSetupModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeRoomSetupModal, isRoomSetupClosing, showRoomSetupModal]);

  return (
    <div className="flex flex-col h-full bg-[#f5f7fb] dark:bg-zinc-950 overflow-hidden overscroll-none relative">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar [-webkit-overflow-scrolling:touch]">
        <div>
        <header className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/swaparty.png" alt="SWaParty" className="h-9 w-auto object-contain" />
            <span className="text-xl font-bold tracking-tight text-slate-800 dark:text-zinc-100 hidden sm:block">{t('lobby.title')}</span>
          </div>

          <div className="relative flex items-center bg-white dark:bg-zinc-900 rounded-full p-2 shadow-[0_4px_20px_rgb(0,0,0,0.03)] border border-slate-100 dark:border-zinc-800">
            <div className="group flex items-center gap-3 pl-1.5 pr-4 sm:pr-5 rounded-full">
              <span className="relative inline-flex">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.name}
                    className="w-10 h-10 rounded-full border border-slate-200 dark:border-zinc-700 object-cover shadow-sm"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 flex items-center justify-center text-[15px] font-semibold text-slate-700 dark:text-zinc-200 shadow-sm">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <span
                  className={`absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-zinc-900 transition-colors ${
                    isSelfOnline
                      ? 'bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.15)]'
                      : 'bg-slate-300 dark:bg-zinc-600'
                  }`}
                  aria-hidden="true"
                />
              </span>
              <span className="text-[16px] font-bold text-slate-800 dark:text-zinc-100 hidden md:block">
                {user.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2 text-slate-400 dark:text-zinc-500">
              <div className="relative hidden md:block">
                <button
                  type="button"
                  onClick={toggleInboxPanel}
                  className={`relative p-2.5 rounded-full transition-all duration-300 flex items-center justify-center origin-center hover:text-blue-500 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/20 hover:scale-110 active:scale-95 ${isInboxOpen ? 'bg-blue-50 dark:bg-blue-500/20 text-blue-500 dark:text-blue-300 scale-105' : ''}`}
                  aria-label={t('lobby.inboxDemoTitle')}
                  title={t('lobby.inboxDemoTitle')}
                >
                  <Mail size={22} strokeWidth={2.2} />
                  {inboxUnreadCount > 0 ? (
                    <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white dark:border-zinc-900 px-1 shadow-sm transform translate-x-1/4 -translate-y-1/4">
                      {inboxUnreadCount > 99 ? '99+' : inboxUnreadCount}
                    </span>
                  ) : null}
                </button>
                {isDesktop ? (
                  <InboxDemoPanel
                    isOpen={desktopInboxOpen}
                    onClose={closeInboxPanel}
                    isDark={isDark}
                    isRealtimeConnected={isRealtimeConnected}
                    onUnreadCountChange={setInboxUnreadCount}
                    onJoinRoomInvite={onJoinRoomInvite}
                    floating
                    anchored
                  />
                ) : null}
              </div>
              <button
                type="button"
                onClick={onOpenProfile}
                className="hidden md:flex p-2.5 rounded-full transition-all duration-300 items-center justify-center hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:rotate-90 active:scale-95 origin-center"
                aria-label={t('profile.settingsNavTitle')}
                title={t('profile.settingsNavTitle')}
              >
                <Settings size={22} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                className="p-2.5 rounded-full transition-all duration-300 flex items-center justify-center hover:text-indigo-500 dark:hover:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/20 hover:-rotate-12 active:scale-95 origin-center"
                aria-label={isDark ? t('lobby.themeSwitchToLight') : t('lobby.themeSwitchToDark')}
                title={isDark ? t('lobby.themeSwitchToLight') : t('lobby.themeSwitchToDark')}
              >
                {isDark ? <Sun size={22} strokeWidth={2.2} /> : <Moon size={22} strokeWidth={2.2} />}
              </button>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 mt-4 sm:mt-6 space-y-5">
          <section className={`overflow-hidden rounded-[2rem] border shadow-[0_18px_60px_rgba(15,23,42,0.06)] transition-[box-shadow,border-color,background-color] duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${activeRoom ? 'border-white/80 bg-white/95 shadow-[0_18px_50px_rgba(15,23,42,0.08)] dark:border-white/5 dark:bg-[#18181b] dark:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.7)]' : 'border-white/70 bg-white/90 dark:border-zinc-800/80 dark:bg-zinc-900/90'}`}>
            <div className={`grid grid-cols-1 overflow-hidden md:grid-cols-2 ${lobbyAccordionClass} ${activeRoom ? 'min-h-[208px] md:min-h-[210px]' : 'min-h-[164px] md:min-h-[166px]'}`}>
              <div className={`group relative flex overflow-hidden p-4 sm:p-5 md:p-7 ${lobbyAccordionClass} ${activeRoom ? 'min-h-[208px] bg-white text-slate-950 dark:bg-[#18181b] dark:text-white md:min-h-[210px]' : 'min-h-[164px] cursor-pointer bg-white text-slate-900 dark:bg-zinc-900 dark:text-zinc-100 md:min-h-[166px]'}`}>
                {activeRoom ? (
                  <>
                    <div className="absolute right-4 top-4 z-10 hidden rounded-xl border border-slate-200/70 bg-white px-3.5 py-2.5 text-right shadow-inner dark:border-white/5 dark:bg-zinc-950/70 sm:block md:right-7 md:top-7">
                      <p className="flex items-center justify-end gap-1.5 text-[14px] font-bold text-slate-700 dark:text-white/75">
                        <Users size={15} className="text-blue-400" />
                        {t('room.onlineCount', { count: activeRoomMemberCount || 1 })}
                      </p>
                    </div>
                    <div className="relative z-10 flex h-full w-full min-w-0 flex-col justify-between gap-5">
                    <div className="min-w-0 pr-0 sm:pr-32">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wider ${activeRoomSuspended ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300'}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${activeRoomSuspended ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.35)] dark:bg-amber-300 dark:shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'animate-pulse bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)] dark:bg-emerald-300 dark:shadow-[0_0_8px_rgba(52,211,153,0.8)]'}`} />
                            {activeRoomSuspended ? t('lobby.activeRoomSuspendedBadge') : t('lobby.activeRoomBadge')}
                          </span>
                          <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-[12px] font-bold uppercase tracking-widest text-slate-400 dark:border-white/5 dark:bg-white/5 dark:text-white/40">#{activeRoom.id}</span>
                        </div>
                        <h2 className="break-words text-[22px] font-bold leading-tight tracking-tight text-slate-950 dark:text-white md:text-[26px]">
                          {activeRoom.isHost ? t('lobby.activeHostedRoomTitle') : t('lobby.activeRecentRoomTitle')}
                        </h2>
                        <p className="mt-2 break-words text-sm font-semibold leading-relaxed text-slate-600 dark:text-white/58">{activeRoomSubtitle}</p>
                    </div>
                    <div className="grid grid-cols-3 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onResumeRoom?.(activeRoom)}
                        disabled={roomActionLoading}
                        className="col-span-2 flex h-14 min-w-0 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-[15px] font-bold text-white shadow-[0_0_20px_rgba(37,99,235,0.25)] transition-[background-color,transform,box-shadow] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] hover:bg-blue-500 hover:shadow-[0_0_30px_rgba(37,99,235,0.38)] active:scale-[0.98] disabled:opacity-60"
                      >
                        <Radio size={17} className={activeRoomSuspended ? '' : 'animate-pulse'} />
                        {t('lobby.activeRoomReconnect')}
                      </button>
                      <button
                        type="button"
                        onClick={closeActiveRoom}
                        disabled={roomActionLoading}
                        className="col-span-1 flex h-14 min-w-0 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 text-[15px] font-bold text-slate-600 shadow-sm transition-[background-color,color,transform,border-color] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] hover:border-red-200 hover:bg-red-50 hover:text-red-600 active:scale-[0.98] disabled:opacity-60 dark:border-white/5 dark:bg-white/5 dark:text-white/60 dark:shadow-none dark:hover:border-red-500/20 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                      >
                        <LogOut size={17} />
                        {activeRoom.isHost ? t('lobby.activeRoomClose') : t('lobby.activeRoomLeave')}
                      </button>
                    </div>
                  </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={openRoomSetupModal}
                    className="relative flex h-full w-full items-center justify-between gap-5 text-left"
                  >
                    <span className="min-w-0 max-w-[min(100%,34rem)]">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="block text-2xl font-black tracking-tight text-slate-900 dark:text-zinc-100">{t('lobby.createRoom')}</span>
                        <span className="inline-flex items-center gap-1 rounded-lg border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-blue-600 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                          <Sparkles size={13} />
                          HOST
                        </span>
                      </span>
                      <span className="mt-2 block max-w-[30rem] text-sm font-semibold leading-relaxed text-slate-500 dark:text-zinc-400">{t('lobby.createRoomDesc')}</span>
                    </span>
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[22px] bg-blue-50 text-blue-500 shadow-sm transition-[background-color,color,transform] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-hover:bg-blue-600 group-hover:text-white dark:bg-blue-500/15 dark:text-blue-300 sm:h-16 sm:w-16">
                      <Play fill="currentColor" className="ml-1" size={26} />
                    </span>
                  </button>
                )}
              </div>

              <div className={`relative flex flex-col justify-center border-t p-4 sm:p-5 md:border-l md:border-t-0 md:p-7 ${lobbyAccordionClass} ${activeRoom ? 'min-h-[208px] border-slate-200/70 bg-white dark:border-white/10 dark:bg-[#18181b] md:min-h-[210px] md:border-l-slate-200/80 md:dark:border-l-white/10' : 'min-h-[150px] border-slate-200/70 bg-white dark:border-zinc-800 dark:bg-zinc-900 md:min-h-[150px]'}`}>
                <div className="mb-3 flex min-w-0 items-center gap-2.5">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${activeRoom ? 'border border-purple-100 bg-purple-50 text-purple-500 dark:border-purple-400/20 dark:bg-purple-400/10 dark:text-purple-300' : 'bg-purple-50 text-purple-500 dark:bg-purple-500/10 dark:text-purple-300'}`}>
                    <Users size={20} />
                  </span>
                  <h2 className={`min-w-0 break-words text-[22px] font-black leading-tight tracking-tight ${activeRoom ? 'text-slate-950 dark:text-white/90' : 'text-slate-900 dark:text-zinc-100'}`}>{t('lobby.joinRoomTitle')}</h2>
                  <span className={`min-w-0 break-words text-[13px] font-black leading-tight text-red-500 transition-[opacity,transform] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:text-red-400 ${joinInlineError ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'}`}>
                    {joinInlineError || t('lobby.joinRoomInvalidHint')}
                  </span>
                </div>
                <form onSubmit={joinRoom} className={`relative flex h-14 items-center rounded-[1.25rem] p-1.5 transition-[box-shadow,background-color,border-color] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${activeRoom ? 'border border-slate-200 bg-slate-100 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.14)] focus-within:border-purple-300 focus-within:bg-white focus-within:shadow-[inset_0_0_0_2px_rgba(168,85,247,0.18)] dark:border-white/5 dark:bg-zinc-950/70 dark:shadow-inner dark:focus-within:border-purple-400/40 dark:focus-within:bg-zinc-950' : 'bg-slate-100 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.18)] focus-within:bg-white focus-within:shadow-[inset_0_0_0_2px_rgba(168,85,247,0.24),0_12px_34px_rgba(88,28,135,0.08)] dark:bg-zinc-800/80 dark:focus-within:bg-zinc-950'} ${joinInlineError ? 'shadow-[inset_0_0_0_2px_rgba(239,68,68,0.28)]' : ''} ${joinErrorShaking ? 'animate-[swaparty-join-shake_380ms_cubic-bezier(0.36,0,0.66,-0.56)_both]' : ''}`}>
                  <input
                    type="text"
                    placeholder={t('lobby.joinRoomPlaceholder')}
                    className={`h-full min-w-0 flex-1 bg-transparent px-4 text-center text-sm font-bold uppercase tracking-widest outline-none placeholder:normal-case placeholder:tracking-normal sm:text-left ${activeRoom ? 'text-slate-950 placeholder:text-slate-400 dark:text-white dark:placeholder:text-white/30' : 'text-slate-900 placeholder:text-slate-400 dark:text-zinc-100'}`}
                    value={roomId}
                    onChange={(event) => {
                      if (joinInlineError) clearJoinInlineError();
                      setRoomId(event.target.value);
                    }}
                    maxLength={6}
                  />
                  <button
                    type="submit"
                    className={`flex h-full shrink-0 items-center justify-center gap-1.5 rounded-[0.95rem] px-4 text-sm font-bold transition-[background-color,transform,opacity] duration-300 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:px-5 ${activeRoom ? 'bg-slate-700 text-white hover:bg-slate-800 dark:bg-white/10 dark:text-white dark:hover:bg-white/20' : 'bg-slate-700 text-white hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200'}`}
                    disabled={roomId.length < 3 || roomActionLoading}
                  >
                    {roomActionLoading ? t('auth.pleaseWait') : t('lobby.joinButton')}
                    <ArrowRight size={16} />
                  </button>
                </form>
                <div className="pointer-events-none absolute inset-x-4 bottom-3 h-10 sm:inset-x-6">
                  <div className={`absolute inset-x-0 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5 text-amber-700 shadow-[0_10px_30px_rgba(180,83,9,0.08)] transition-[opacity,transform] duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200 ${activeRoom?.isHost && roomId.trim().length >= 3 && !roomActionError && !joinInlineError ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}>
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span className="text-[12px] font-semibold leading-relaxed">
                      {t('lobby.activeRoomJoinWarning')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {isMediaPanelReady ? (
            <MediaLibraryPanel />
          ) : (
            <section
              className="rounded-[2rem] border border-slate-100 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 shadow-[0_10px_34px_rgb(0,0,0,0.04)] p-6"
              aria-hidden="true"
            >
              <div className="animate-pulse space-y-4">
                <div className="h-7 w-56 rounded-xl bg-slate-200/80 dark:bg-zinc-800/80" />
                <div className="h-10 w-full rounded-2xl bg-slate-100/90 dark:bg-zinc-800/60" />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="h-56 rounded-2xl bg-slate-100 dark:bg-zinc-800/60" />
                  <div className="h-56 rounded-2xl bg-slate-100 dark:bg-zinc-800/60" />
                  <div className="h-56 rounded-2xl bg-slate-100 dark:bg-zinc-800/60" />
                </div>
              </div>
            </section>
          )}
        </main>

        </div>
      </div>
      <MobileBottomTabBar
        items={[
          {
            id: 'home',
            label: t('lobby.navHome'),
            icon: Home,
            active: true,
            onClick: () => { },
          },
          {
            id: 'inbox',
            label: t('lobby.inboxDemoTitle'),
            icon: Mail,
            active: isInboxOpen,
            onClick: toggleInboxPanel,
            badge: inboxUnreadCount,
          },
          {
            id: 'settings',
            label: t('profile.settingsNavTitle'),
            icon: Settings,
            active: false,
            onClick: onOpenProfile,
          },
        ]}
      />
      <ModalShell
        mounted={showRoomSetupModal}
        active={showRoomSetupModal}
        closing={isRoomSetupClosing}
        onClose={closeRoomSetupModal}
        contentClassName="auth-card modal-content modal-content--form w-full rounded-t-[32px] rounded-b-none sm:rounded-[28px] overflow-hidden p-0 text-left flex flex-col"
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />

        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            createRoom();
          }}
        >
          <div className="modal-body !items-stretch !text-left !px-5 sm:!px-8 !pt-7 !pb-5 overflow-y-auto min-h-0">
            <div className="mb-5">
              <h3 className="text-[20px] leading-7 font-bold text-slate-900 dark:text-zinc-100">{t('lobby.roomSetupTitle')}</h3>
              <p className="text-[13px] leading-5 text-slate-500 dark:text-zinc-400">{t('lobby.roomSetupDesc')}</p>
            </div>

            <div className="space-y-4 w-full">
              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-[14px] font-bold text-slate-700 dark:text-zinc-200">
                  <Film className="h-4 w-4 text-blue-500" />
                  {t('lobby.roomSetupFieldTitle')}
                </span>
                <input
                  type="text"
                  value={roomSetupForm.title}
                  maxLength={48}
                  onChange={(event) => setRoomSetupForm((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder={t('lobby.roomSetupFieldTitlePlaceholder')}
                  className="w-full h-12 rounded-[16px] px-4 bg-slate-50 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 text-[14px] font-semibold placeholder:text-slate-400 focus:placeholder:text-transparent dark:placeholder:text-zinc-500"
                />
              </label>

              <div className="flex items-center justify-between gap-4 rounded-[18px] border border-slate-100 bg-slate-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/80">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-purple-50 text-purple-500 dark:bg-purple-500/10 dark:text-purple-300">
                    <Users size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-bold text-slate-800 dark:text-zinc-100">{t('lobby.roomSetupFieldMaxMembers')}</span>
                    <span className="mt-0.5 block break-words text-[12px] font-semibold text-slate-500 dark:text-zinc-400">{t('lobby.roomSetupFieldMaxMembersDesc')}</span>
                  </span>
                </span>
                <span className="flex h-10 shrink-0 items-center rounded-[14px] bg-white p-1 shadow-sm dark:bg-zinc-950/70">
                  <button
                    type="button"
                    onClick={() => setRoomSetupForm((prev) => ({ ...prev, maxMembers: Math.max(2, Number(prev.maxMembers || 8) - 1) }))}
                    className="flex h-8 w-8 items-center justify-center rounded-[10px] text-slate-500 transition-[background-color,color,transform] duration-200 hover:bg-slate-100 hover:text-slate-900 active:scale-95 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
                    aria-label={t('lobby.roomSetupDecreaseMembers')}
                  >
                    <Minus size={18} />
                  </button>
                  <span className="min-w-9 px-2 text-center text-[16px] font-black text-slate-900 dark:text-zinc-100">{roomSetupForm.maxMembers}</span>
                  <button
                    type="button"
                    onClick={() => setRoomSetupForm((prev) => ({ ...prev, maxMembers: Math.min(99, Number(prev.maxMembers || 8) + 1) }))}
                    className="flex h-8 w-8 items-center justify-center rounded-[10px] text-slate-500 transition-[background-color,color,transform] duration-200 hover:bg-slate-100 hover:text-slate-900 active:scale-95 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
                    aria-label={t('lobby.roomSetupIncreaseMembers')}
                  >
                    <Plus size={18} />
                  </button>
                </span>
              </div>

              <label className="block">
                <span className="mb-2 flex items-center gap-2 text-[14px] font-bold text-slate-700 dark:text-zinc-200">
                  <List className="h-4 w-4 text-blue-500" />
                  {t('lobby.roomSetupFieldNotice')}
                </span>
                <textarea
                  value={roomSetupForm.notice}
                  maxLength={200}
                  rows={3}
                  onChange={(event) => setRoomSetupForm((prev) => ({ ...prev, notice: event.target.value }))}
                  placeholder={t('lobby.roomSetupFieldNoticePlaceholder')}
                  className="w-full rounded-[16px] px-4 py-3 bg-slate-50 dark:bg-zinc-900/80 border border-slate-200 dark:border-zinc-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 text-[14px] font-semibold resize-none placeholder:text-slate-400 focus:placeholder:text-transparent dark:placeholder:text-zinc-500"
                />
              </label>
            </div>
          </div>

          <div className="modal-actions !px-5 sm:!px-8">
            <button type="button" onClick={closeRoomSetupModal} className="modal-btn modal-btn-secondary !w-28 !rounded-[14px] !py-3.5 shrink-0">
              {t('lobby.roomSetupCancel')}
            </button>
            {roomActionError ? (
              <p className="mr-auto text-[13px] font-semibold text-red-500 dark:text-red-400">
                {roomActionError}
              </p>
            ) : null}
            <button type="submit" disabled={roomActionLoading} className="modal-btn modal-btn-primary !flex-1 !rounded-[14px] !py-3.5 gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
              {roomActionLoading ? null : <Play fill="currentColor" className="mr-1 h-4 w-4" />}
              {roomActionLoading ? t('auth.pleaseWait') : t('lobby.roomSetupConfirm')}
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        mounted={roomConfirm.open}
        active={roomConfirm.open}
        closing={isRoomConfirmClosing}
        onClose={closeRoomConfirm}
        contentClassName="auth-card modal-content modal-content--compact w-full rounded-t-[32px] rounded-b-none sm:rounded-[28px] overflow-hidden p-0 text-center"
      >
        <div className="modal-sheet-handle" />
        {roomConfirm.danger ? <div className="modal-aura is-error" /> : null}
        <div className="modal-body">
          <div className={roomConfirm.danger ? 'modal-icon-badge is-error' : 'mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[28px] border border-blue-100 bg-blue-50 shadow-[0_14px_44px_rgba(15,23,42,0.10)] dark:border-blue-500/20 dark:bg-blue-500/10'}>
            {roomConfirm.danger ? (
              <div className="modal-icon-core">
                <Trash2 className="modal-icon-glyph h-8 w-8" />
              </div>
            ) : (
              <img src="/swaparty.png" alt="" className="h-12 w-12 rounded-2xl object-contain" />
            )}
          </div>
          <h3 className="modal-heading">{roomConfirm.title}</h3>
          <p className="modal-copy">{roomConfirm.message}</p>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={closeRoomConfirm} className="modal-btn modal-btn-secondary">
            {t('lobby.roomSetupCancel')}
          </button>
          <button
            type="button"
            onClick={confirmRoomAction}
            disabled={roomActionLoading}
            className={`modal-btn ${roomConfirm.danger ? 'bg-red-500 text-white hover:bg-red-600' : 'modal-btn-primary'} disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            {roomActionLoading ? t('auth.pleaseWait') : roomConfirm.confirmLabel}
          </button>
        </div>
      </ModalShell>
    </div>
  );
});

export default LobbyScreen;
