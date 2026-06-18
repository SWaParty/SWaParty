import { BrushCleaning, Check, ChevronLeft, MailOpen, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import {
  INVITES_CHANGED_EVENT,
  INBOX_RUNTIME_UPDATED_EVENT,
  inboxRuntimeCache,
  publishInboxChanged,
  publishInboxRuntimeUpdated,
  warmInboxRuntimeCache,
} from '../../lib/inboxRuntimeCache';
import { publishContactsChanged } from '../../lib/quickContactsCache';

const INBOX_REFRESH_MIN_INTERVAL_MS = 10000;
const INBOX_FALLBACK_POLL_MS = 30000;
const PANEL_CLOSE_RESET_MS = 340;

function isItemRead(item) {
  const readAt = Number(item?.readAt || 0);
  const updatedAt = Number(item?.updatedAt || item?.createdAt || 0);
  if (!Number.isFinite(readAt) || readAt <= 0) return false;
  return readAt >= updatedAt;
}

function toRelativeMinutes(unixSec) {
  if (!unixSec) return '';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSec));
  if (diffSec < 60) return '1m';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function toItemKey(item) {
  const kind = String(item?.kind || 'invite').trim();
  const id = String(item?.id || '').trim();
  return `${kind}:${id}`;
}

function toDateTime(unixSec) {
  if (!unixSec) return '';
  const value = Number(unixSec);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value * 1000).toLocaleString();
}

function resolveItemStatusLabel(item) {
  const kind = String(item?.kind || 'invite').trim();
  const inviteStatus = String(item?.status || '').trim();
  const noticeReason = String(item?.reason || '').trim();
  if (kind === 'room_invite') return t('lobby.inboxRoomInviteStatus');
  if (kind === 'invite') {
    if (inviteStatus === 'accepted') return t('lobby.inboxStatusAccepted');
    if (inviteStatus === 'rejected') return t('lobby.inboxStatusRejected');
    if (inviteStatus === 'canceled') return t('lobby.inboxStatusCanceled');
    return t('lobby.inboxStatusInfo');
  }
  if (noticeReason === 'invite_rejected') return t('lobby.inboxStatusRejected');
  if (noticeReason === 'invite_canceled_by_peer') return t('lobby.inboxStatusCanceled');
  if (noticeReason === 'account_deleted') return t('lobby.inboxStatusAccountDeleted');
  return t('lobby.inboxStatusInfo');
}

export default function InboxPanel({
  isOpen,
  onClose,
  isDark,
  isRealtimeConnected = false,
  onUnreadCountChange,
  onJoinRoomInvite,
  floating = true,
  anchored = false,
  fullScreen = false,
  className = '',
}) {
  const [items, setItems] = useState(() => (Array.isArray(inboxRuntimeCache.items) ? inboxRuntimeCache.items : []));
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [inFlightIds, setInFlightIds] = useState({});
  const [activeItemKey, setActiveItemKey] = useState('');
  const lastFetchAtRef = useRef(Number(inboxRuntimeCache.lastFetchAt || 0));
  const hasLoadedRef = useRef(Boolean(inboxRuntimeCache.hasLoaded) || (Array.isArray(inboxRuntimeCache.items) && inboxRuntimeCache.items.length > 0));
  const inFlightFetchRef = useRef(null);
  const snapshotRef = useRef(inboxRuntimeCache.snapshot || '[]');
  const listScrollRef = useRef(null);
  const closeResetTimerRef = useRef(null);

  const fetchIncoming = async ({ silent = false } = {}) => {
    const nowMs = Date.now();
    if (inFlightFetchRef.current) return inFlightFetchRef.current;
    if (hasLoadedRef.current && nowMs - lastFetchAtRef.current < INBOX_REFRESH_MIN_INTERVAL_MS) return null;

    if (!silent && !hasLoadedRef.current) setIsLoading(true);
    const task = (async () => {
      try {
        const resp = await fetch('/api/contacts/invites/incoming?limit=50', { credentials: 'include' });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.ok || !Array.isArray(data.items)) {
          if (!hasLoadedRef.current) {
            setItems([]);
            snapshotRef.current = '[]';
          }
          return;
        }

        const nextItems = data.items;
        const nextSnapshot = JSON.stringify(
          nextItems.map((item) => ({
            kind: String(item?.kind || ''),
            id: String(item?.id || ''),
            status: String(item?.status || ''),
            updatedAt: Number(item?.updatedAt || 0),
            readAt: Number(item?.readAt || 0),
            message: String(item?.message || ''),
          })),
        );
        if (nextSnapshot !== snapshotRef.current) {
          setItems(nextItems);
          snapshotRef.current = nextSnapshot;
          inboxRuntimeCache.items = nextItems;
          inboxRuntimeCache.snapshot = nextSnapshot;
          publishInboxRuntimeUpdated({
            items: nextItems,
            unreadCount: nextItems.reduce((acc, item) => acc + (isItemRead(item) ? 0 : 1), 0),
          });
        }

        hasLoadedRef.current = true;
        lastFetchAtRef.current = Date.now();
        inboxRuntimeCache.hasLoaded = true;
        inboxRuntimeCache.lastFetchAt = lastFetchAtRef.current;
      } catch {
        if (!hasLoadedRef.current) {
          setItems([]);
          snapshotRef.current = '[]';
        }
      } finally {
        inFlightFetchRef.current = null;
        if (!silent) setIsLoading(false);
      }
    })();

    inFlightFetchRef.current = task;
    return task;
  };

  useEffect(() => {
    inboxRuntimeCache.items = items;
    if (items.length > 0) {
      inboxRuntimeCache.hasLoaded = true;
    }
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    const hydrateFromRuntimeCache = () => {
      if (cancelled) return;
      const cachedItems = Array.isArray(inboxRuntimeCache.items) ? inboxRuntimeCache.items : [];
      setItems(cachedItems);
      snapshotRef.current = inboxRuntimeCache.snapshot || '[]';
      hasLoadedRef.current = Boolean(inboxRuntimeCache.hasLoaded) || cachedItems.length > 0;
      lastFetchAtRef.current = Number(inboxRuntimeCache.lastFetchAt || 0);
      if (!hasLoadedRef.current) {
        fetchIncoming({ silent: false });
      }
    };

    const task = warmInboxRuntimeCache({ force: false });
    if (task && typeof task.then === 'function') {
      task.finally(hydrateFromRuntimeCache);
      return () => {
        cancelled = true;
      };
    }
    hydrateFromRuntimeCache();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      if (closeResetTimerRef.current) {
        window.clearTimeout(closeResetTimerRef.current);
      }
      closeResetTimerRef.current = window.setTimeout(() => {
        setActiveItemKey('');
        if (listScrollRef.current) {
          listScrollRef.current.scrollTop = 0;
        }
        closeResetTimerRef.current = null;
      }, PANEL_CLOSE_RESET_MS);
      return;
    }
    if (closeResetTimerRef.current) {
      window.clearTimeout(closeResetTimerRef.current);
      closeResetTimerRef.current = null;
    }
    window.requestAnimationFrame(() => {
      const cachedItems = Array.isArray(inboxRuntimeCache.items) ? inboxRuntimeCache.items : [];
      setItems(cachedItems);
      snapshotRef.current = inboxRuntimeCache.snapshot || '[]';
      hasLoadedRef.current = Boolean(inboxRuntimeCache.hasLoaded) || cachedItems.length > 0;
      lastFetchAtRef.current = Number(inboxRuntimeCache.lastFetchAt || 0);

      const nowMs = Date.now();
      const isFresh = hasLoadedRef.current && (nowMs - lastFetchAtRef.current) < INBOX_REFRESH_MIN_INTERVAL_MS;
      if (!isFresh) {
        fetchIncoming({ silent: true });
      }
    });
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (closeResetTimerRef.current) {
        window.clearTimeout(closeResetTimerRef.current);
        closeResetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isRealtimeConnected) return;
      if (!isOpen) return;
      if (document.visibilityState !== 'visible') return;
      fetchIncoming({ silent: true });
    }, INBOX_FALLBACK_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isOpen, isRealtimeConnected]);

  useEffect(() => {
    const refreshIncoming = () => {
      if (!isOpen) return;
      lastFetchAtRef.current = 0;
      fetchIncoming({ silent: true });
    };
    window.addEventListener(INVITES_CHANGED_EVENT, refreshIncoming);
    return () => {
      window.removeEventListener(INVITES_CHANGED_EVENT, refreshIncoming);
    };
  }, [isOpen]);

  useEffect(() => {
    const syncFromRuntimeCache = () => {
      if (!isOpen || !Array.isArray(inboxRuntimeCache.items)) return;
      setItems(inboxRuntimeCache.items);
    };
    window.addEventListener(INBOX_RUNTIME_UPDATED_EVENT, syncFromRuntimeCache);
    return () => {
      window.removeEventListener(INBOX_RUNTIME_UPDATED_EVENT, syncFromRuntimeCache);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!activeItemKey) return;
    const exists = items.some((item) => toItemKey(item) === activeItemKey);
    if (!exists) setActiveItemKey('');
  }, [activeItemKey, items]);

  const unreadCount = useMemo(() => {
    return items.reduce((acc, item) => acc + (isItemRead(item) ? 0 : 1), 0);
  }, [items]);

  useEffect(() => {
    if (typeof onUnreadCountChange !== 'function') return;
    onUnreadCountChange(unreadCount);
  }, [unreadCount, onUnreadCountChange]);

  const markAllRead = () => {
    const now = Math.floor(Date.now() / 1000);
    setItems((prev) => prev.map((item) => ({ ...item, readAt: now })));
    fetch('/api/contacts/invites/read-all', { method: 'POST', credentials: 'include' }).catch(() => { });
    fetch('/api/contacts/inbox/read-all', { method: 'POST', credentials: 'include' }).catch(() => { });
  };

  const markItemRead = async (item) => {
    if (!item || isItemRead(item)) return;
    const kind = String(item.kind || 'invite').trim();
    const id = String(item.id || '').trim();
    if (!id) return;
    const now = Math.floor(Date.now() / 1000);
    setItems((prev) => prev.map((row) => {
      if (String(row.id || '').trim() !== id) return row;
      if (String(row.kind || 'invite').trim() !== kind) return row;
      return { ...row, readAt: now };
    }));
    const endpoint = kind === 'invite'
      ? `/api/contacts/invites/${encodeURIComponent(id)}/read`
      : `/api/contacts/inbox/${encodeURIComponent(id)}/read`;
    await fetch(endpoint, { method: 'POST', credentials: 'include' }).catch(() => { });
  };

  const openDetail = (item) => {
    if (!item) return;
    markItemRead(item);
    setActiveItemKey(toItemKey(item));
  };

  const handleInviteAction = async (inviteId, action) => {
    if (!inviteId || inFlightIds[inviteId]) return;
    setInFlightIds((prev) => ({ ...prev, [inviteId]: true }));
    try {
      const resp = await fetch(`/api/contacts/invites/${encodeURIComponent(inviteId)}/${action}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data?.ok) {
        lastFetchAtRef.current = 0;
        await fetchIncoming({ silent: true });
        if (action === 'accept') {
          publishContactsChanged({ reason: 'invite.accepted' });
        }
        publishInboxChanged({ reason: `invite.${action}` });
      }
    } finally {
      setInFlightIds((prev) => {
        const next = { ...prev };
        delete next[inviteId];
        return next;
      });
    }
  };

  const handleRoomInviteJoin = async (item) => {
    const roomHash = String(item?.roomHash || item?.reason || '').trim().toUpperCase();
    const itemKey = toItemKey(item);
    if (!roomHash || inFlightIds[itemKey]) return;
    setInFlightIds((prev) => ({ ...prev, [itemKey]: true }));
    try {
      await markItemRead(item);
      if (typeof onJoinRoomInvite === 'function') {
        await onJoinRoomInvite(roomHash);
      }
    } finally {
      setInFlightIds((prev) => {
        const next = { ...prev };
        delete next[itemKey];
        return next;
      });
    }
  };

  const handleClearAll = async () => {
    if (!items.length || isClearing) return;
    setIsClearing(true);
    const tasks = items.map((item) => {
      const kind = String(item?.kind || 'invite');
      if (kind === 'invite') {
        return fetch(`/api/contacts/invites/${encodeURIComponent(item.id)}/dismiss`, {
          method: 'POST',
          credentials: 'include',
        });
      }
      return fetch(`/api/contacts/inbox/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    });
    await Promise.allSettled(tasks);
    lastFetchAtRef.current = 0;
    await fetchIncoming({ silent: false });
    setActiveItemKey('');
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
    publishInboxChanged({ reason: 'inbox.cleared' });
    setIsClearing(false);
  };

  const activeItem = useMemo(() => {
    if (!activeItemKey) return null;
    return items.find((item) => toItemKey(item) === activeItemKey) || null;
  }, [activeItemKey, items]);

  const isDetailView = Boolean(activeItem);
  const handleClosePanel = () => {
    if (typeof onClose === 'function') onClose();
  };

  const shellClass = floating
    ? anchored
      ? `absolute top-[calc(100%+16px)] right-0 z-50 w-[380px] max-w-[calc(100vw-24px)] h-[480px] max-h-[calc(100vh-140px)] transform origin-top-right transition-all modal-motion-standard ${isOpen ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'
      } ${className}`
      : `fixed right-6 top-24 z-30 w-[360px] max-w-[calc(100vw-24px)] h-[420px] max-h-[calc(100vh-120px)] transition-all modal-motion-standard ${isOpen ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-1 scale-[0.98] pointer-events-none'
      } ${className}`
    : `w-full h-full ${className}`;

  return (
    <div className={shellClass}>
      <style>{`
        .inbox-no-scrollbar::-webkit-scrollbar { display: none; }
        .inbox-no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
      <div className={`h-full overflow-hidden flex flex-col ${floating
        ? 'border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg rounded-2xl'
        : fullScreen
          ? 'border-0 bg-[#F5F5F7] dark:bg-zinc-950 rounded-none'
          : 'border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg rounded-t-[2rem] rounded-b-none'
        }`}>

        {/* ======================= 重构的固定头部区 ======================= */}
        <div className={`${fullScreen
          ? 'bg-white dark:bg-zinc-900 border-b border-slate-200/70 dark:border-zinc-800/70 shadow-sm'
          : 'bg-white dark:bg-zinc-900 border-b border-gray-100 dark:border-zinc-800 shadow-[0_2px_10px_rgb(0,0,0,0.02)] dark:shadow-none'
          } shrink-0 z-10 relative`}
        >
          <div className={`${fullScreen ? 'flex items-center justify-between px-4 pt-6 pb-3 relative' : 'px-5 py-4 flex items-center justify-between gap-2'}`}>
            <div className="min-w-0 flex items-center gap-2 flex-1">
              {/* 返回按钮容器，结合宽度与透明度实现无缝展开 */}
              <div className={`flex items-center transition-all modal-motion-standard ${isDetailView ? 'w-10 opacity-100' : 'w-0 opacity-0 pointer-events-none overflow-hidden'}`}>
                <button
                  type="button"
                  onClick={() => setActiveItemKey('')}
                  className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors active:scale-95 ${isDark ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-gray-100 text-gray-500'
                    }`}
                >
                  <ChevronLeft size={24} strokeWidth={2} />
                </button>
              </div>

              <span className={`${fullScreen ? 'font-bold text-[17px] text-slate-800 dark:text-zinc-100 tracking-tight' : 'text-[18px] font-bold text-gray-900 dark:text-zinc-100'} truncate`}>
                {isDetailView ? (String(activeItem?.sender?.displayName || '').trim() || t('profile.fallbackDisplayName')) : t('lobby.inboxDemoTitle')}
              </span>
            </div>

            <div className={`flex items-center transition-opacity modal-motion-standard shrink-0 ${fullScreen ? 'gap-1 -mr-1' : 'gap-2'}`}>
            {/* 操作按钮区 (列表页显示，详情页折叠隐藏) */}
              <div className={`flex items-center transition-all modal-motion-standard ${fullScreen ? 'gap-1' : 'gap-2'} ${isDetailView ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100 w-auto'}`}>
              <button
                type="button"
                onClick={markAllRead}
                className={`${fullScreen ? 'p-2' : 'w-10 h-10'} rounded-full flex items-center justify-center transition-all active:scale-95 tooltip ${fullScreen
                  ? (isDark ? 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100')
                  : (isDark ? 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800' : 'bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-800')
                  }`}
                aria-label={t('lobby.inboxDemoMarkRead')}
                title={t('lobby.inboxDemoMarkRead')}
              >
                <BrushCleaning size={22} strokeWidth={2} />
              </button>

              <button
                type="button"
                onClick={handleClearAll}
                disabled={!items.length || isClearing}
                className={`${fullScreen ? 'p-2' : 'w-10 h-10'} rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${fullScreen
                  ? (isDark ? 'text-zinc-400 hover:text-rose-400 hover:bg-rose-900/20' : 'text-slate-500 hover:text-rose-500 hover:bg-rose-50')
                  : (isDark ? 'bg-zinc-900 text-zinc-300 hover:bg-rose-900/30 hover:text-rose-400' : 'bg-white text-gray-500 hover:bg-rose-50 hover:text-rose-500')
                  }`}
                aria-label={t('lobby.inboxDemoClearAll')}
                title={t('lobby.inboxDemoClearAll')}
              >
                {isClearing ? <X className="w-[22px] h-[22px] animate-spin" /> : <Trash2 size={22} strokeWidth={2} />}
              </button>

              {/* 加高的竖线分割 */}
                <div className={`w-px h-5 mx-1 ${isDark ? 'bg-zinc-700' : 'bg-gray-200'}`}></div>
              </div>

            {/* 关闭信箱按钮：无边框但保留大触控区 */}
              <button
                type="button"
                onClick={handleClosePanel}
                className={`${fullScreen ? 'p-2' : 'w-10 h-10'} rounded-full flex items-center justify-center transition-all shrink-0 active:scale-95 ${fullScreen
                  ? (isDark ? 'bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80' : 'bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-100')
                  : (isDark ? 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800' : 'bg-white text-gray-400 hover:text-gray-600 hover:bg-gray-100')
                  }`}
                aria-label={t('lobby.inboxDemoClose')}
              >
                <X size={22} strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>
        {/* ================================================================ */}

        <div className="flex-1 overflow-hidden relative">
          <div className={`h-full w-[200%] flex transition-transform modal-motion-standard ${isDetailView ? '-translate-x-1/2' : 'translate-x-0'}`}>
            <div ref={listScrollRef} className="w-1/2 h-full overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch] p-2 inbox-no-scrollbar">
              {isLoading && !items.length ? (
                <div className="h-full min-h-[220px]" />
              ) : items.length === 0 ? (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                  <div className="w-14 h-14 rounded-2xl bg-gray-100 dark:bg-zinc-800/80 text-gray-400 dark:text-zinc-500 flex items-center justify-center mb-3">
                    <MailOpen className="w-7 h-7" />
                  </div>
                  <div className="text-[14px] font-semibold text-gray-700 dark:text-zinc-200">{t('lobby.inboxDemoEmptyTitle')}</div>
                  <div className="text-[12px] text-gray-500 dark:text-zinc-400 mt-1">{t('lobby.inboxDemoEmptyDesc')}</div>
                </div>
              ) : (
                items.map((item) => {
                  const sender = item.sender || {};
                  const kind = String(item.kind || 'invite');
                  const isInvite = kind === 'invite';
                  const isRoomInvite = kind === 'room_invite';
                  const inviteStatus = String(item.status || '').trim();
                  const isPendingInvite = isInvite && inviteStatus === 'pending';
                  const isPendingRoomInvite = isRoomInvite && inviteStatus === 'pending';
                  const displayName = String(sender.displayName || '').trim() || String(sender.email || '').split('@')[0] || t('profile.fallbackDisplayName');
                  const email = String(sender.email || '').trim();
                  const message = String(item.message || '').trim();
                  const unread = !isItemRead(item);
                  const itemKey = toItemKey(item);
                  const pending = Boolean(inFlightIds[item.id] || inFlightIds[itemKey]);

                  return (
                    <div
                      key={itemKey}
                      className="rounded-xl px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-zinc-800/70 transition-colors flex items-start gap-3 cursor-pointer"
                      onClick={() => openDetail(item)}
                    >
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-blue-500 bg-blue-50 dark:bg-blue-500/10">
                        <UserPlus className="w-4 h-4" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[13px] font-semibold text-gray-900 dark:text-zinc-100 truncate">{displayName}</div>
                          {unread ? <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" /> : null}
                        </div>
                        <div className="text-[12px] text-gray-600 dark:text-zinc-400 mt-0.5 line-clamp-2">{message || email}</div>
                        <div className="text-[11px] text-gray-400 dark:text-zinc-500 mt-1">{toRelativeMinutes(item.createdAt)}</div>
                      </div>

                      {isPendingInvite ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleInviteAction(item.id, 'accept');
                            }}
                            disabled={pending}
                            className="w-8 h-8 rounded-lg flex items-center justify-center border border-emerald-200 text-emerald-600 bg-emerald-50 hover:bg-emerald-100 transition-colors disabled:opacity-60"
                            title={t('profile.quickContactsInviteSent')}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleInviteAction(item.id, 'reject');
                            }}
                            disabled={pending}
                            className="w-8 h-8 rounded-lg flex items-center justify-center border border-rose-200 text-rose-600 bg-rose-50 hover:bg-rose-100 transition-colors disabled:opacity-60"
                            title={t('profile.searchCancel')}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : isPendingRoomInvite ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRoomInviteJoin(item);
                          }}
                          disabled={pending}
                          className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                        >
                          {t('lobby.inboxRoomInviteJoin')}
                        </button>
                      ) : (
                        <div className="shrink-0 px-2 py-1 rounded-md text-[11px] font-semibold bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {resolveItemStatusLabel(item)}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="w-1/2 h-full overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch] p-4 inbox-no-scrollbar">
              {activeItem ? (
                <div className="h-full flex flex-col">
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-blue-500 bg-blue-50 dark:bg-blue-500/10">
                      <UserPlus className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="text-[15px] font-bold text-gray-900 dark:text-zinc-100 truncate">
                          {String(activeItem.sender?.displayName || '').trim() || t('profile.fallbackDisplayName')}
                        </div>
                        {!isItemRead(activeItem) ? <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" /> : null}
                      </div>
                      {String(activeItem.sender?.email || '').trim() ? (
                        <div className="text-[12px] text-gray-500 dark:text-zinc-400 mt-0.5 truncate">
                          {String(activeItem.sender?.email || '').trim()}
                        </div>
                      ) : null}
                      <div className="mt-2 inline-flex px-2 py-1 rounded-md text-[11px] font-semibold bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {resolveItemStatusLabel(activeItem)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 text-[13px] leading-6 text-gray-800 dark:text-zinc-200 whitespace-pre-wrap break-words">
                    {String(activeItem.message || '').trim() || String(activeItem.sender?.email || '').trim()}
                  </div>

                  <div className="mt-4 pt-2 border-t border-gray-100 dark:border-zinc-800 text-[11px] text-gray-400 dark:text-zinc-500 flex items-center justify-between">
                    <span>{toRelativeMinutes(activeItem.createdAt)}</span>
                    <span>{toDateTime(activeItem.createdAt)}</span>
                  </div>

                  {String(activeItem.kind || '') === 'invite' && String(activeItem.status || '') === 'pending' ? (
                    <div className="mt-auto grid grid-cols-2 gap-2 pt-4">
                      <button
                        type="button"
                        onClick={() => handleInviteAction(activeItem.id, 'accept')}
                        disabled={Boolean(inFlightIds[activeItem.id])}
                        className="h-10 rounded-xl border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-[13px] font-semibold transition-colors disabled:opacity-60"
                      >
                        {t('lobby.inboxActionAccept')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInviteAction(activeItem.id, 'reject')}
                        disabled={Boolean(inFlightIds[activeItem.id])}
                        className="h-10 rounded-xl border border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 text-[13px] font-semibold transition-colors disabled:opacity-60"
                      >
                        {t('lobby.inboxActionReject')}
                      </button>
                    </div>
                  ) : String(activeItem.kind || '') === 'room_invite' && String(activeItem.status || '') === 'pending' ? (
                    <div className="mt-auto pt-4">
                      <button
                        type="button"
                        onClick={() => handleRoomInviteJoin(activeItem)}
                        disabled={Boolean(inFlightIds[toItemKey(activeItem)])}
                        className="h-11 w-full rounded-xl bg-blue-600 text-[13px] font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                      >
                        {t('lobby.inboxRoomInviteJoin')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-6">
                  <div className="w-14 h-14 rounded-2xl bg-gray-100 dark:bg-zinc-800/80 text-gray-400 dark:text-zinc-500 flex items-center justify-center mb-3">
                    <MailOpen className="w-7 h-7" />
                  </div>
                  <div className="text-[14px] font-semibold text-gray-700 dark:text-zinc-200">{t('lobby.inboxDemoTitle')}</div>
                  <div className="text-[12px] text-gray-500 dark:text-zinc-400 mt-1">{t('lobby.inboxDemoEmptyDesc')}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
