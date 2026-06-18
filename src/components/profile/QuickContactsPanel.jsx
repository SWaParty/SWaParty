import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  X,
  Check,
  Search as SearchIcon,
  RotateCcw,
  UserPlus,
  History,
  Clock,
  Film,
  Trash2,
} from 'lucide-react';
import { useCallback } from 'react';
import { t } from '../../i18n';
import {
  CONTACTS_CHANGED_EVENT,
  CONTACTS_RUNTIME_UPDATED_EVENT,
  getCachedContacts,
  getCachedInviteHistory,
  hasCachedContacts,
  hasCachedInviteHistory,
  isCachedContactsFresh,
  isCachedInviteHistoryFresh,
  mapQuickContactUser,
  prefetchContactsCache,
  publishContactsChanged,
  setCachedContacts,
  setCachedInviteHistory,
} from '../../lib/quickContactsCache';
import {
  INVITES_CHANGED_EVENT,
  publishInboxChanged,
} from '../../lib/inboxRuntimeCache';
import {
  PRESENCE_CHANGED_EVENT,
  getPresenceOnlineUserIds,
  normalizePresenceOnlineUserIds,
  normalizePresenceUserId,
} from '../../lib/realtimePresenceBus';

const REMOTE_CONTACT_REMOVED_EVENT = 'swaparty-contact-removed-by-peer';
const CONTACT_RELATION_NOTICE_EVENT = 'swaparty-contact-relation-notice';
const REMOTE_DELETE_EXIT_MS = 1500;
const INVITE_HISTORY_HIDDEN_IDS_KEY = 'swaparty.invite_history.hidden_ids';
const INVITE_HISTORY_HIDDEN_IDS_MAX = 400;

function readHiddenInviteHistoryIds() {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(INVITE_HISTORY_HIDDEN_IDS_KEY);
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function persistHiddenInviteHistoryIds(idSet) {
  if (typeof window === 'undefined') return;
  try {
    const compact = Array.from(idSet).slice(-INVITE_HISTORY_HIDDEN_IDS_MAX);
    window.localStorage.setItem(INVITE_HISTORY_HIDDEN_IDS_KEY, JSON.stringify(compact));
  } catch {
    // ignore persistence failures
  }
}

function formatCooldownDuration(seconds) {
  const totalSeconds = Math.max(1, Math.ceil(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}

function Card({ children, allowOverflow = false }) {
  return (
    <div className={`bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl rounded-[24px] sm:rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.03)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100/80 dark:border-zinc-800/80 ${allowOverflow ? 'relative z-40 overflow-visible' : 'relative z-0 overflow-hidden'} mb-8 sm:mb-10 transition-shadow duration-500 hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] dark:hover:shadow-[0_8px_30px_rgb(0,0,0,0.3)]`}>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

export default function QuickContactsPanel({ activeRoom = null, currentUser = null }) {
  const INVITE_HISTORY_MAX = 30;

  const [openPanel, setOpenPanel] = useState('none');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [inviteStatus, setInviteStatus] = useState('idle');
  const [, setInviteCooldownMap] = useState({});
  const [invitingContactId, setInvitingContactId] = useState('');

  const [contacts, setContacts] = useState(() => (hasCachedContacts() ? getCachedContacts() : []));
  const [expandedContactId, setExpandedContactId] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deletingContactId, setDeletingContactId] = useState('');
  const [remoteDeletingIds, setRemoteDeletingIds] = useState(() => new Set());

  const [inviteHistory, setInviteHistory] = useState(() => (hasCachedInviteHistory() ? getCachedInviteHistory() : []));
  const [inviteHistoryLoading, setInviteHistoryLoading] = useState(false);
  const [isClearingInviteHistory, setIsClearingInviteHistory] = useState(false);
  const [onlineUserIdSet, setOnlineUserIdSet] = useState(() => new Set(getPresenceOnlineUserIds()));
  const hiddenInviteHistoryIdsRef = useRef(readHiddenInviteHistoryIds());
  const hasLoadedInviteHistoryRef = useRef(hasCachedInviteHistory());
  const remoteDeleteTimersRef = useRef(new Map());

  const isSearchResultVisible = searchQuery.trim() !== '' && (searchResult !== null || isSearching);

  const loadContacts = async ({ force = false } = {}) => {
    const next = await prefetchContactsCache({ force, limit: 200 });
    setContacts(next);
  };

  const applyContactsMutation = useCallback((mutator) => {
    setContacts((prev) => {
      const next = mutator(prev);
      setCachedContacts(next);
      return next;
    });
  }, []);

  const removeContactAfterAnimation = useCallback((contactId) => {
    if (!contactId) return;
    const timersMap = remoteDeleteTimersRef.current;
    if (timersMap.has(contactId)) return;
    const timer = setTimeout(() => {
      applyContactsMutation((prev) => prev.filter((item) => item.id !== contactId));
      setExpandedContactId((prev) => (prev === contactId ? null : prev));
      setDeleteConfirmId((prev) => (prev === contactId ? null : prev));
      setRemoteDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      });
      timersMap.delete(contactId);
      publishContactsChanged({ reason: 'contact.removed.remote' });
      publishInboxChanged({ reason: 'contact.removed.remote' });
    }, REMOTE_DELETE_EXIT_MS);

    timersMap.set(contactId, timer);
  }, [applyContactsMutation]);

  const loadInviteHistory = async ({ silent = false } = {}) => {
    const showLoading = !silent && !hasLoadedInviteHistoryRef.current;
    if (showLoading) setInviteHistoryLoading(true);
    try {
      const resp = await fetch(`/api/contacts/invites/outgoing?limit=${INVITE_HISTORY_MAX}`, { credentials: 'include' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !Array.isArray(data.items)) {
        hasLoadedInviteHistoryRef.current = hasCachedInviteHistory() || hasLoadedInviteHistoryRef.current;
        return;
      }
      const allStatuses = data.items
        .map((item) => {
          const userCard = mapQuickContactUser(item.receiver || {});
          return {
            id: item.id,
            status: String(item.status || 'pending').trim() || 'pending',
            name: userCard.name,
            email: userCard.email,
            initial: userCard.initial,
            avatarUrl: userCard.avatarUrl,
            bg: userCard.bg,
          };
        })
        .filter((item) => !hiddenInviteHistoryIdsRef.current.has(String(item.id || '').trim()))
        .slice(0, INVITE_HISTORY_MAX);
      setInviteHistory(allStatuses);
      setCachedInviteHistory(allStatuses);
      hasLoadedInviteHistoryRef.current = true;
    } catch {
      hasLoadedInviteHistoryRef.current = hasCachedInviteHistory() || hasLoadedInviteHistoryRef.current;
    } finally {
      if (showLoading) setInviteHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (searchQuery.trim() === '') {
      const timer = setTimeout(() => {
        setSearchResult(null);
        setInviteStatus('idle');
        setIsSearching(false);
      }, 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [searchQuery]);

  useEffect(() => {
    const onRemoteRemoved = (event) => {
      const detail = event?.detail || {};
      const contactUserId = String(detail.contactUserId || detail.userId || detail.id || '').trim();
      if (!contactUserId) return;

      const cached = getCachedContacts();
      const target = cached.find((item) => String(item?.id) === contactUserId);
      if (!target) return;

      setRemoteDeletingIds((prev) => {
        if (prev.has(contactUserId)) return prev;
        const next = new Set(prev);
        next.add(contactUserId);
        return next;
      });
      removeContactAfterAnimation(contactUserId);
    };

    window.addEventListener(REMOTE_CONTACT_REMOVED_EVENT, onRemoteRemoved);
    return () => {
      window.removeEventListener(REMOTE_CONTACT_REMOVED_EVENT, onRemoteRemoved);
    };
  }, [removeContactAfterAnimation]);

  useEffect(() => {
    const contactsCacheFresh = isCachedContactsFresh();
    if (contactsCacheFresh) {
      setContacts(getCachedContacts());
    } else {
      loadContacts({ force: false });
    }

    const onContactsChanged = () => {
      loadContacts({ force: true });
    };
    const onContactsRuntimeUpdated = (event) => {
      const nextContacts = Array.isArray(event?.detail?.contacts)
        ? event.detail.contacts
        : getCachedContacts();
      setContacts(nextContacts);
    };
    const onInvitesChanged = () => {
      if (openPanel !== 'history') return;
      loadInviteHistory({ silent: true });
    };
    window.addEventListener(CONTACTS_CHANGED_EVENT, onContactsChanged);
    window.addEventListener(CONTACTS_RUNTIME_UPDATED_EVENT, onContactsRuntimeUpdated);
    window.addEventListener(INVITES_CHANGED_EVENT, onInvitesChanged);
    return () => {
      window.removeEventListener(CONTACTS_CHANGED_EVENT, onContactsChanged);
      window.removeEventListener(CONTACTS_RUNTIME_UPDATED_EVENT, onContactsRuntimeUpdated);
      window.removeEventListener(INVITES_CHANGED_EVENT, onInvitesChanged);
    };
  }, [openPanel]);

  useEffect(() => {
    if (openPanel === 'history') {
      const historyCacheFresh = isCachedInviteHistoryFresh();
      if (historyCacheFresh) {
        setInviteHistory(getCachedInviteHistory());
        setInviteHistoryLoading(false);
        hasLoadedInviteHistoryRef.current = true;
        loadInviteHistory({ silent: true });
      } else {
        loadInviteHistory({ silent: hasCachedInviteHistory() || hasLoadedInviteHistoryRef.current });
      }
    }
  }, [openPanel]);

  useEffect(() => {
    const remoteDeleteTimers = remoteDeleteTimersRef.current;
    return () => {
      for (const timer of remoteDeleteTimers.values()) clearTimeout(timer);
      remoteDeleteTimers.clear();
    };
  }, [removeContactAfterAnimation]);

  useEffect(() => {
    setOnlineUserIdSet(new Set(getPresenceOnlineUserIds()));
    const onPresenceChanged = (event) => {
      const onlineUserIds = normalizePresenceOnlineUserIds(event?.detail?.onlineUserIds || []);
      setOnlineUserIdSet(new Set(onlineUserIds));
    };
    window.addEventListener(PRESENCE_CHANGED_EVENT, onPresenceChanged);
    return () => {
      window.removeEventListener(PRESENCE_CHANGED_EVENT, onPresenceChanged);
    };
  }, []);

  const showInviteCooldownNotice = (content) => {
    window.dispatchEvent(new CustomEvent(CONTACT_RELATION_NOTICE_EVENT, {
      detail: {
        title: t('profile.quickContactsInviteCooldownTitle'),
        content,
      },
    }));
  };

  const togglePanel = (panelName) => {
    if (openPanel === panelName) {
      setOpenPanel('none');
      if (panelName === 'invite') {
        setTimeout(() => {
          setSearchQuery('');
          setSearchResult(null);
          setInviteStatus('idle');
        }, 500);
      }
      return;
    }
    setOpenPanel(panelName);
    if (openPanel === 'invite') {
      setTimeout(() => {
        setSearchQuery('');
        setSearchResult(null);
        setInviteStatus('idle');
      }, 500);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setInviteStatus('idle');
    try {
      const q = searchQuery.trim();
      const resp = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`, {
        credentials: 'include',
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        setSearchResult('not_found');
        return;
      }
      if (data.reason === 'self_search') {
        setSearchResult('self_search');
        return;
      }
      if (!data.user) {
        setSearchResult('not_found');
        return;
      }
      setSearchResult(mapQuickContactUser(data.user));
    } catch {
      setSearchResult('not_found');
    } finally {
      setIsSearching(false);
    }
  };

  const sendWatchInviteToUser = async (targetUser) => {
    if (!targetUser || typeof targetUser !== 'object') {
      return false;
    }

    const receiverUserId = String(targetUser.id || '').trim();
    if (!receiverUserId) {
      return false;
    }

    const activeRoomHash = String(activeRoom?.id || activeRoom?.hash || '').trim().toUpperCase();
    const hasActiveRoom = Boolean(activeRoomHash && (activeRoom?.status === 'open' || activeRoom?.status === 'host_disconnected'));
    const roomTitle = String(activeRoom?.title || '').trim() || t('room.defaultRoomTitle');
    const members = Array.isArray(activeRoom?.members) ? activeRoom.members : [];
    const memberCount = Math.max(1, members.length || 1);
    const maxMembers = Math.max(memberCount, Number(activeRoom?.maxMembers || 8) || 8);
    const senderName = String(currentUser?.name || currentUser?.displayName || '').trim() || t('profile.fallbackDisplayName');

    const resp = await fetch(hasActiveRoom ? '/api/room-invites' : '/api/watch-requests', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hasActiveRoom ? {
        receiverUserId,
        roomHash: activeRoomHash,
        roomTitle,
        memberCount,
        maxMembers,
        message: t('room.inviteMessageReceived', {
          name: senderName,
          title: roomTitle,
          id: activeRoomHash,
          count: memberCount,
          max: maxMembers,
        }),
      } : {
        receiverUserId,
        message: t('profile.watchRequestMessage', { name: senderName }),
      }),
    });
    const data = await resp.json().catch(() => null);
    if (resp.ok && data?.ok) {
      const expiresAtSec = Number(data?.invite?.expiresAt || 0);
      if (Number.isFinite(expiresAtSec) && expiresAtSec > 0) {
        setInviteCooldownMap((prev) => ({
          ...prev,
          [receiverUserId]: expiresAtSec * 1000,
        }));
      }
      publishInboxChanged({ reason: hasActiveRoom ? 'room_invite.sent' : 'watch_request.sent' });
      return true;
    }
    if (resp.status === 409) {
      const retryAfterSecRaw = Number(data?.retryAfterSec || 0);
      const retryAfterSec = Number.isFinite(retryAfterSecRaw) ? Math.max(1, Math.ceil(retryAfterSecRaw)) : 86400;
      if (String(data?.code || '').trim() === 'invite_cooldown') {
        setInviteCooldownMap((prev) => ({
          ...prev,
          [receiverUserId]: Date.now() + retryAfterSec * 1000,
        }));
        showInviteCooldownNotice(t('profile.quickContactsInviteCooldownContent', { duration: formatCooldownDuration(retryAfterSec) }));
      }
    }
    return false;
  };

  const sendContactInviteToUser = async (targetUser) => {
    if (!targetUser || typeof targetUser !== 'object') {
      return false;
    }

    const receiverUserId = String(targetUser.id || '').trim();
    if (!receiverUserId) {
      return false;
    }

    const resp = await fetch('/api/contacts/invites', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverUserId }),
    });
    const data = await resp.json().catch(() => null);
    if (resp.ok && data?.ok) {
      const expiresAtSec = Number(data?.invite?.expiresAt || 0);
      if (Number.isFinite(expiresAtSec) && expiresAtSec > 0) {
        setInviteCooldownMap((prev) => ({
          ...prev,
          [receiverUserId]: expiresAtSec * 1000,
        }));
      }
      await loadInviteHistory({ silent: true });
      publishInboxChanged({ reason: 'invite.sent' });
      return true;
    }

    if (resp.status === 409) {
      const retryAfterSecRaw = Number(data?.retryAfterSec || 0);
      const retryAfterSec = Number.isFinite(retryAfterSecRaw) ? Math.max(1, Math.ceil(retryAfterSecRaw)) : 86400;
      if (String(data?.code || '').trim() === 'invite_cooldown') {
        setInviteCooldownMap((prev) => ({
          ...prev,
          [receiverUserId]: Date.now() + retryAfterSec * 1000,
        }));
        showInviteCooldownNotice(t('profile.quickContactsInviteCooldownContent', { duration: formatCooldownDuration(retryAfterSec) }));
      }
    }
    return false;
  };

  const handleSendInvite = async () => {
    if (!searchResult || typeof searchResult !== 'object' || inviteStatus === 'sending') {
      return;
    }

    setInviteStatus('sending');
    try {
      const sent = await sendContactInviteToUser(searchResult);
      if (sent) {
        setInviteStatus('sent');
        return;
      }
      setInviteStatus('idle');
    } catch {
      setInviteStatus('idle');
    }
  };

  const handleContactRoomInvite = async (contact) => {
    const contactId = String(contact?.id || '').trim();
    if (!contactId || invitingContactId) return;
    setInvitingContactId(contactId);
    try {
      await sendWatchInviteToUser(contact);
    } finally {
      setInvitingContactId('');
    }
  };

  const toggleContactExpand = (id) => {
    if (remoteDeletingIds.has(id)) return;
    if (expandedContactId === id) {
      setExpandedContactId(null);
      return;
    }
    setExpandedContactId(id);
    setDeleteConfirmId(null);
  };

  const confirmDeleteContact = async (contactUserId, confirm = false) => {
    if (!confirm) {
      setDeleteConfirmId(contactUserId);
      return;
    }

    if (!contactUserId || deletingContactId) return;
    setDeletingContactId(contactUserId);
    try {
      const resp = await fetch(`/api/contacts/${encodeURIComponent(contactUserId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data?.ok) {
        const contactName = String(contacts.find((item) => item.id === contactUserId)?.name || '').trim();
        applyContactsMutation((prev) => prev.filter((item) => item.id !== contactUserId));
        setExpandedContactId(null);
        setDeleteConfirmId(null);
        publishContactsChanged({ reason: 'contact.removed.local' });
        publishInboxChanged({ reason: 'contact.removed.local' });
        window.dispatchEvent(new CustomEvent(CONTACT_RELATION_NOTICE_EVENT, {
          detail: {
            role: 'actor',
            name: contactName || t('profile.fallbackDisplayName'),
          },
        }));
      }
    } finally {
      setDeletingContactId('');
    }
  };

  const clearInviteHistory = async () => {
    if (isClearingInviteHistory || !inviteHistory.length) return;

    const clearableIds = inviteHistory
      .filter((item) => String(item?.status || '').trim() !== 'pending')
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean);

    if (!clearableIds.length) return;

    setIsClearingInviteHistory(true);
    const nextHidden = new Set(hiddenInviteHistoryIdsRef.current);
    clearableIds.forEach((id) => nextHidden.add(id));
    hiddenInviteHistoryIdsRef.current = nextHidden;
    persistHiddenInviteHistoryIds(nextHidden);

    setInviteHistory((prev) => {
      const next = prev.filter((item) => !nextHidden.has(String(item?.id || '').trim()));
      setCachedInviteHistory(next);
      return next;
    });

    try {
      await loadInviteHistory({ silent: true });
      publishInboxChanged({ reason: 'invite_history.cleared' });
    } finally {
      setIsClearingInviteHistory(false);
    }
  };

  const canClearInviteHistory = useMemo(() => {
    return inviteHistory.some((item) => String(item?.status || '').trim() !== 'pending');
  }, [inviteHistory]);

  const inviteBtnLabel = useMemo(() => {
    if (inviteStatus === 'sending') return t('auth.pleaseWait');
    if (inviteStatus === 'sent') return t('profile.quickContactsInviteSent');
    return t('profile.quickContactsSendInvite');
  }, [inviteStatus]);

  const resolveInviteHistoryStatus = (statusRaw) => {
    const status = String(statusRaw || '').trim();
    if (status === 'accepted') {
      return {
        label: t('profile.inviteHistoryAccepted'),
        icon: Check,
        className: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-500/30',
      };
    }
    if (status === 'rejected') {
      return {
        label: t('profile.inviteHistoryRejected'),
        icon: X,
        className: 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-300 border-rose-200/60 dark:border-rose-500/30',
      };
    }
    if (status === 'canceled') {
      return {
        label: t('profile.inviteHistoryCanceled'),
        icon: X,
        className: 'bg-slate-100 dark:bg-zinc-700/50 text-slate-600 dark:text-zinc-300 border-slate-200/70 dark:border-zinc-600/70',
      };
    }
    return {
      label: t('profile.inviteHistoryPending'),
      icon: Clock,
      className: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-200/60 dark:border-amber-500/30',
    };
  };

  const isContactOnline = (contactUserId) => {
    const normalizedId = normalizePresenceUserId(contactUserId);
    if (!normalizedId) return false;
    return onlineUserIdSet.has(normalizedId);
  };

  return (
    <div className="panel-animate">
      <div className="flex items-end justify-between mb-8 px-2">
        <h1 className="hidden md:block text-[26px] md:text-[32px] font-extrabold text-slate-800 dark:text-zinc-100 tracking-tight">
          {t('profile.sectionQuickContacts')}
        </h1>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => togglePanel('history')}
            className={`text-[13px] sm:text-[14px] font-semibold flex items-center gap-1.5 px-4 sm:px-5 py-2.5 rounded-full transition-all duration-300 active:scale-95 shadow-sm border ${
              openPanel === 'history'
                ? 'bg-slate-800 text-white border-slate-800 hover:bg-slate-700 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 hover:border-slate-300 dark:hover:border-zinc-600'
            }`}
          >
            <History className="w-4 h-4" />
            <span>{t('profile.quickContactsHistoryAction')}</span>
          </button>
          <button
            type="button"
            onClick={() => togglePanel('invite')}
            className={`text-[13px] sm:text-[14px] font-semibold flex items-center gap-1.5 px-4 sm:px-5 py-2.5 rounded-full transition-all duration-300 active:scale-95 shadow-sm border ${
              openPanel === 'invite'
                ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-700'
                : 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/20 hover:bg-blue-50 dark:hover:bg-blue-500/20 border-transparent'
            }`}
          >
            <UserPlus className="w-4 h-4" />
            {openPanel === 'invite' ? t('profile.searchCancel') : t('profile.invite')}
          </button>
        </div>
      </div>

      <div className={`grid transition-all duration-500 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${openPanel === 'invite' ? 'grid-rows-[1fr] opacity-100 mb-8' : 'grid-rows-[0fr] opacity-0 mb-0'}`}>
        <div className="overflow-hidden">
          <div className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl border border-blue-100/80 dark:border-blue-500/20 rounded-[28px] p-5 sm:p-6 shadow-[0_12px_40px_rgb(47,101,255,0.06)] transform-gpu">
            <div className="flex flex-col gap-4">
              <div className="text-[14px] font-bold text-slate-700 dark:text-zinc-200 ml-1">{t('profile.quickContactsSearchTitle')}</div>
              <div className="flex gap-2 sm:gap-3">
                <div className="flex-1 flex items-center bg-slate-100/80 dark:bg-zinc-800/80 rounded-2xl border border-slate-200/90 dark:border-zinc-700 transition-all duration-300 focus-within:bg-white dark:focus-within:bg-zinc-900 focus-within:border-blue-500/60 focus-within:ring-2 focus-within:ring-blue-500/20">
                  <div className="pl-3 sm:pl-4 pr-2 text-slate-400 dark:text-zinc-500">
                    <SearchIcon className="w-[16px] sm:w-[18px] h-[16px] sm:h-[18px]" />
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && handleSearch()}
                    placeholder={t('profile.quickContactsSearchPlaceholder')}
                    className="flex-1 w-full bg-transparent py-3 sm:py-3.5 pr-3 sm:pr-4 text-[14px] sm:text-[15px] text-slate-800 dark:text-zinc-100 outline-none placeholder-slate-400 dark:placeholder:text-zinc-500"
                  />
                  {searchQuery ? (
                    <button type="button" onClick={() => setSearchQuery('')} className="pr-3 text-slate-300 dark:text-zinc-600 hover:text-slate-500 dark:hover:text-zinc-400 transition-colors">
                      <X className="w-[18px] h-[18px]" />
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={handleSearch}
                  disabled={!searchQuery.trim() || isSearching}
                  className="h-[48px] sm:h-[52px] px-5 sm:px-6 bg-blue-600 text-white rounded-2xl text-[14px] sm:text-[15px] font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center min-w-[70px] sm:min-w-[90px] shadow-sm active:scale-[0.97]"
                >
                  {isSearching ? <RotateCcw className="w-5 h-5 animate-spin" /> : t('profile.quickContactsSearchAction')}
                </button>
              </div>

              <div className={`grid transition-all duration-500 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${isSearchResultVisible ? 'grid-rows-[1fr] opacity-100 mt-2' : 'grid-rows-[0fr] opacity-0 mt-0'}`}>
                <div className="overflow-hidden min-h-0">
                  <div className={`transition-all duration-400 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] transform origin-top ${isSearching ? 'opacity-60 scale-[0.98] blur-[1px] pointer-events-none' : 'opacity-100 scale-100 blur-0'}`}>
                    {isSearching && !searchResult ? (
                      <div className="bg-slate-50 dark:bg-zinc-900 border border-slate-100 dark:border-zinc-700 rounded-2xl p-4 flex items-center justify-center h-[82px]">
                        <RotateCcw className="w-5 h-5 animate-spin text-slate-400 dark:text-zinc-500" />
                      </div>
                    ) : searchResult === 'self_search' ? (
                      <div className="min-h-[82px] bg-amber-50/70 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 rounded-2xl p-4 flex items-center justify-center text-center text-[13px] sm:text-[14px] text-amber-700 dark:text-amber-300 font-medium">
                        {t('profile.quickContactsSearchSelf')}
                      </div>
                    ) : searchResult === 'not_found' ? (
                      <div className="min-h-[82px] bg-rose-50/50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20 rounded-2xl p-4 flex items-center justify-center text-center text-[13px] sm:text-[14px] text-rose-600 dark:text-rose-300 font-medium">
                        {t('profile.quickContactsSearchNotFound')}
                      </div>
                    ) : searchResult && typeof searchResult === 'object' ? (
                      <div className="min-h-[82px] bg-slate-50 dark:bg-zinc-900 border border-slate-100 dark:border-zinc-700 rounded-2xl p-4 flex items-center justify-between gap-3 group hover:bg-white dark:hover:bg-zinc-800 transition-colors duration-300">
                        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                          {searchResult.avatarUrl ? (
                            <img src={searchResult.avatarUrl} alt={searchResult.name} className="w-10 sm:w-12 h-10 sm:h-12 rounded-[14px] object-cover shadow-sm" />
                          ) : (
                            <div className={`w-10 sm:w-12 h-10 sm:h-12 rounded-[14px] bg-gradient-to-br ${searchResult.bg} text-white flex items-center justify-center font-bold text-lg sm:text-xl shadow-sm`}>
                              {searchResult.initial}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-[14px] sm:text-[15px] font-bold text-slate-800 dark:text-zinc-100 truncate">{searchResult.name}</div>
                            <div className="text-[12px] sm:text-[13px] text-slate-500 dark:text-zinc-400 font-medium mt-0.5 truncate">{searchResult.email}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleSendInvite}
                          disabled={inviteStatus === 'sending'}
                          className={`px-4 sm:px-5 py-2 sm:py-2.5 rounded-xl text-[13px] sm:text-[14px] font-bold transition-all duration-300 flex items-center gap-1.5 shrink-0 ${
                            inviteStatus === 'sent'
                              ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30 shadow-none cursor-default'
                              : 'bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-700 hover:border-slate-300 dark:hover:border-zinc-600 shadow-sm active:scale-95'
                          }`}
                        >
                          {inviteStatus === 'sent' ? <Check className="w-[16px] sm:w-[18px] h-[16px] sm:h-[18px]" /> : null}
                          {inviteBtnLabel}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`grid transition-all duration-500 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${openPanel === 'history' ? 'grid-rows-[1fr] opacity-100 mb-8' : 'grid-rows-[0fr] opacity-0 mb-0'}`}>
        <div className="overflow-hidden">
          <div className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl border border-slate-200/80 dark:border-zinc-700/80 rounded-[28px] p-5 sm:p-6 shadow-[0_12px_40px_rgb(0,0,0,0.04)] transform-gpu">
            <div className="flex items-center justify-between mb-5 ml-1 gap-2">
              <div className="text-[14px] font-bold text-slate-700 dark:text-zinc-200">{t('profile.inviteHistoryTitle')}</div>
              <div className="flex items-center gap-3">
                <div className="text-[12px] font-medium text-slate-400 dark:text-zinc-500">{t('profile.inviteHistoryLimit', { max: INVITE_HISTORY_MAX })}</div>
                <button
                  type="button"
                  onClick={clearInviteHistory}
                  disabled={!canClearInviteHistory || isClearingInviteHistory}
                  className="h-8 sm:h-7 px-3.5 sm:px-3 rounded-full text-[12px] font-semibold border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isClearingInviteHistory ? t('auth.pleaseWait') : t('profile.inviteHistoryClearAll')}
                </button>
              </div>
            </div>

            {inviteHistoryLoading ? (
              <div className="min-h-[132px] rounded-2xl border border-slate-100/80 dark:border-zinc-700/80 bg-slate-50/50 dark:bg-zinc-900/50 flex items-center justify-center">
                <RotateCcw className="w-5 h-5 animate-spin text-slate-400 dark:text-zinc-500" />
              </div>
            ) : inviteHistory.length > 0 ? (
              <div className="flex flex-col gap-3">
                {inviteHistory.map((inv) => (
                  <div key={inv.id} className="bg-slate-50/50 dark:bg-zinc-900 border border-slate-100/80 dark:border-zinc-700/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3.5 min-w-0">
                      {inv.avatarUrl ? (
                        <img src={inv.avatarUrl} alt={inv.name} className="w-10 h-10 rounded-[12px] object-cover shadow-sm" />
                      ) : (
                        <div className={`w-10 h-10 rounded-[12px] bg-gradient-to-br ${inv.bg} text-white flex items-center justify-center font-bold text-lg shadow-sm opacity-90`}>
                          {inv.initial}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-[14px] font-bold text-slate-800 dark:text-zinc-100 truncate">{inv.name}</div>
                        <div className="text-[12px] text-slate-500 dark:text-zinc-400 font-medium mt-0.5 truncate">{inv.email}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:justify-end self-start sm:self-auto ml-[54px] sm:ml-0">
                      {(() => {
                        const statusMeta = resolveInviteHistoryStatus(inv.status);
                        const StatusIcon = statusMeta.icon;
                        return (
                          <span className={`flex items-center gap-1.5 px-3 py-1 border rounded-lg text-[12px] font-bold ${statusMeta.className}`}>
                            <StatusIcon className="w-3.5 h-3.5" /> {statusMeta.label}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="min-h-[132px] rounded-2xl border border-slate-100/80 dark:border-zinc-700/80 bg-slate-50/50 dark:bg-zinc-900/50 flex flex-col items-center justify-center text-center px-4">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="w-8 h-8 text-slate-300 dark:text-zinc-600 mb-2" fill="none">
                  <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M7.5 10h9M7.5 14h5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="17.2" cy="13.9" r="1.3" fill="currentColor" />
                </svg>
                <div className="text-[13px] sm:text-[14px] font-medium text-slate-500 dark:text-zinc-400">{t('profile.inviteHistoryEmpty')}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Card>
        {contacts.length === 0 ? (
          <div className="px-5 sm:px-6 py-10">
            <div className="min-h-[132px] rounded-2xl border border-slate-100/80 dark:border-zinc-700/80 bg-slate-50/50 dark:bg-zinc-900/50 flex flex-col items-center justify-center text-center px-4">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="w-8 h-8 text-slate-300 dark:text-zinc-600 mb-2" fill="none">
                <path d="M16.8 18.2c0-2.2-2.1-3.9-4.8-3.9s-4.8 1.7-4.8 3.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="12" cy="8.2" r="3.2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M19.3 9.7h3.2M20.9 8.1v3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <div className="text-[13px] sm:text-[14px] font-medium text-slate-500 dark:text-zinc-400">{t('profile.quickContactsEmpty')}</div>
            </div>
          </div>
        ) : contacts.map((c) => {
          const isExpanded = expandedContactId === c.id;
          const isDeleting = deletingContactId === c.id;
          const isRemoteDeleting = remoteDeletingIds.has(c.id);
          const isAnyDeleting = isRemoteDeleting;
          const rowClass = isRemoteDeleting
            ? 'opacity-40 grayscale scale-[0.98] bg-slate-50/50 dark:bg-zinc-800/40 pointer-events-none duration-500'
            : `${isExpanded ? 'bg-slate-50/50 dark:bg-zinc-800/40' : 'hover:bg-slate-50/80 dark:hover:bg-zinc-800/30'} duration-300`;
          return (
            <div key={c.id} className={`flex flex-col border-b border-slate-100/60 dark:border-zinc-800/60 last:border-0 transition-all ease-in-out origin-top ${rowClass}`}>
              <div onClick={() => toggleContactExpand(c.id)} className={`flex items-center justify-between px-5 sm:px-6 py-4 sm:py-5 cursor-pointer group ${isAnyDeleting ? 'pointer-events-none' : ''}`}>
                <div className="flex items-center gap-4 sm:gap-5 min-w-0">
                  <span className="relative inline-flex shrink-0">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={c.name} className={`w-10 sm:w-12 h-10 sm:h-12 rounded-[14px] sm:rounded-[16px] object-cover shadow-sm transition-all duration-500 ease-out ${isExpanded ? 'scale-105 shadow-md' : 'group-hover:scale-110 group-hover:-rotate-6'}`} />
                    ) : (
                      <div className={`w-10 sm:w-12 h-10 sm:h-12 rounded-[14px] sm:rounded-[16px] bg-gradient-to-br ${c.bg} text-white flex items-center justify-center font-bold text-lg sm:text-xl shadow-sm transition-all duration-500 ease-out ${isExpanded ? 'scale-105 shadow-md' : 'group-hover:scale-110 group-hover:-rotate-6'}`}>
                        {c.initial}
                      </div>
                    )}
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-zinc-900 transition-colors ${
                        isContactOnline(c.id) ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-zinc-600'
                      }`}
                      aria-hidden="true"
                    />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <p className={`text-[15px] sm:text-[16px] font-semibold transition-colors duration-300 line-clamp-1 ${isRemoteDeleting ? 'text-slate-500 dark:text-zinc-400 line-through' : isExpanded ? 'text-blue-600 dark:text-blue-400' : 'text-slate-800 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`}>
                      {c.name}
                    </p>
                    <p className="text-[12px] sm:text-[13px] text-slate-500 dark:text-zinc-400 font-medium mt-0.5 line-clamp-1">{c.email}</p>
                  </div>
                </div>
                {isRemoteDeleting ? (
                  <span className="text-[12px] font-bold text-rose-500 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 px-2 py-1 rounded-md">
                    {t('profile.quickContactsPeerRemoved')}
                  </span>
                ) : (
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors duration-300 ${isExpanded ? 'bg-blue-100 dark:bg-blue-500/20' : 'group-hover:bg-blue-50 dark:group-hover:bg-zinc-700/60'}`}>
                    <ChevronRight className={`w-5 h-5 transition-all duration-500 ${isExpanded ? 'text-blue-600 dark:text-blue-400 rotate-90' : 'text-slate-300 dark:text-zinc-600 group-hover:text-blue-500 dark:group-hover:text-blue-400 group-hover:translate-x-0.5'}`} />
                  </div>
                )}
              </div>

              <div className={`grid transition-all duration-500 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                <div className="overflow-hidden">
                  <div className="px-5 sm:px-6 pb-5 sm:pb-6 pt-0 sm:pt-1">
                    <div className="bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 rounded-[20px] p-3 sm:p-4 shadow-sm flex flex-col gap-4">
                      <div className="flex gap-2 h-[52px] sm:h-[48px]">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleContactRoomInvite(c);
                          }}
                          disabled={Boolean(invitingContactId)}
                          className={`flex-1 flex items-center justify-center gap-2 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 rounded-xl text-[13px] sm:text-[14px] font-bold transition-all duration-300 overflow-hidden active:scale-[0.98] ${deleteConfirmId === c.id ? 'opacity-70' : ''}`}
                        >
                          {invitingContactId === c.id ? <RotateCcw className="w-[18px] h-[18px] shrink-0 animate-spin" /> : <Film className="w-[18px] h-[18px] shrink-0" />}
                          <span className="whitespace-nowrap">{invitingContactId === c.id ? t('auth.pleaseWait') : t('profile.quickContactsWatchInvite')}</span>
                        </button>

                        <div
                          onClick={() => !deleteConfirmId && !isDeleting && confirmDeleteContact(c.id)}
                          className={`relative flex items-center w-[164px] min-w-[164px] sm:w-[172px] sm:min-w-[172px] rounded-xl border transition-all duration-300 overflow-hidden ${deleteConfirmId === c.id ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-100 dark:border-rose-500/30' : 'bg-rose-50 dark:bg-rose-500/10 border-transparent hover:bg-rose-100 dark:hover:bg-rose-500/20 cursor-pointer active:scale-[0.98]'}`}
                        >
                          <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${deleteConfirmId === c.id ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                            {isDeleting ? <RotateCcw className="w-[18px] h-[18px] text-rose-500 dark:text-rose-300 animate-spin" /> : <Trash2 className="w-[18px] h-[18px] text-rose-500 dark:text-rose-300 shrink-0" />}
                          </div>

                          <div className={`absolute inset-0 flex items-center justify-between pl-3 pr-1.5 transition-opacity duration-200 ${deleteConfirmId === c.id ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                            <span className="text-[12px] sm:text-[13px] text-rose-600 dark:text-rose-300 font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-2">
                              {t('profile.deleteConfirmAction')}?
                            </span>
                            <div className="flex gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); confirmDeleteContact(c.id, true); }}
                                disabled={isDeleting}
                                className="w-9 h-9 sm:w-8 sm:h-8 flex items-center justify-center bg-rose-500 text-white rounded-lg shadow-sm hover:bg-rose-600 active:scale-95 transition-all disabled:opacity-60"
                              >
                                <Check className="w-[16px] h-[16px]" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(null); }}
                                disabled={isDeleting}
                                className="w-9 h-9 sm:w-8 sm:h-8 flex items-center justify-center bg-white dark:bg-zinc-900 text-slate-400 dark:text-zinc-500 rounded-lg shadow-sm border border-slate-200 dark:border-zinc-700 hover:text-slate-600 dark:hover:text-zinc-300 active:scale-95 transition-all disabled:opacity-60"
                              >
                                <X className="w-[16px] h-[16px]" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </Card>

    </div>
  );
}

