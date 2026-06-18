import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  Cloud,
  Copy,
  Link as LinkIcon,
  Moon,
  MinusCircle,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Sun,
  Trash2,
  Users,
  FileVideo,
} from 'lucide-react';
import { t } from '../../i18n';
import { prefetchContactsCache } from '../../lib/quickContactsCache';
import { MEDIA_CHANGED_EVENT, ROOM_REALTIME_EVENT } from '../../lib/realtimeMediaBus';
import { PROFILE_UPDATED_EVENT } from '../../lib/realtimeProfileBus';
import { buildRoomClientHeaders } from '../../lib/roomClientId';
import {
  PRESENCE_CHANGED_EVENT,
  getPresenceOnlineUserIds,
  normalizePresenceOnlineUserIds,
  normalizePresenceUserId,
} from '../../lib/realtimePresenceBus';
import {
  readGpuVideoRenderingPreference,
  subscribeGpuVideoRenderingPreference,
} from '../../lib/videoRenderingPreferences';
import { ChatDanmakuLayer } from './ChatDanmaku';
import { useChatDanmakuItems } from './ChatDanmakuItems';
import { ChatPanel } from './ChatPanel';
import { pickInitialPlaybackSource } from './playerQuality';
import { RoomPlayer } from './RoomPlayer';
import { RoomActivityLog } from './RoomActivityLog';
import { usePlayerInteractions } from './usePlayerInteractions';
import { useRoomPlaybackController } from './useRoomPlaybackController';

const MODAL_CLOSE_MS = 340;

function formatMediaBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const mb = value / (1024 * 1024);
  if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatMediaDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const total = Math.floor(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeMediaIdentityPart(value) {
  return String(value || '').trim();
}

function buildCloudMediaKey(item) {
  const hash = normalizeMediaIdentityPart(
    item?.contentHash
      || item?.hash
      || item?.sha256
      || item?.fileHash
      || item?.sourceHash
      || item?.originalHash,
  );
  if (hash) return `hash:${hash}`;
  const id = normalizeMediaIdentityPart(item?.id);
  return id ? `cloud:${id}` : '';
}

function buildDirectMediaKey(source) {
  const value = normalizeMediaIdentityPart(source);
  if (!value) return '';
  try {
    const parsed = new URL(value, window.location.href);
    return `url:${parsed.href}`;
  } catch {
    return `url:${value}`;
  }
}

function buildDirectMediaId(source) {
  const value = String(source || '').trim();
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `direct:${hash.toString(36)}`;
}

function getDirectSourceFromMediaKey(mediaKey) {
  const value = String(mediaKey || '').trim();
  return value.startsWith('url:') ? value.slice(4) : '';
}

function mapCloudMediaItem(item) {
  const playbackUrl = String(item?.playbackUrl || '').trim();
  return {
    id: String(item?.id || ''),
    title: String(item?.title || '').trim() || t('room.untitledMedia'),
    durationSec: Number(item?.durationSec || item?.duration || 0) || 0,
    duration: formatMediaDuration(item?.durationSec),
    size: formatMediaBytes(item?.totalSizeBytes || item?.originalSizeBytes),
    originalSizeBytes: Number(item?.originalSizeBytes || 0) || 0,
    totalSizeBytes: Number(item?.totalSizeBytes || 0) || 0,
    thumbnailUrl: item?.thumbnailUrl || '',
    originalPlaybackUrl: String(item?.originalPlaybackUrl || '').trim(),
    masterPlaybackUrl: String(item?.masterPlaybackUrl || '').trim(),
    playbackUrl,
    playbackStatus: item?.playbackStatus || 'not_ready',
    transcodeStatus: item?.transcodeStatus || 'none',
    uploadStatus: item?.uploadStatus || 'waiting',
    contentHash: item?.contentHash || item?.hash || item?.sha256 || item?.fileHash || item?.sourceHash || item?.originalHash || '',
    playable: Boolean(playbackUrl),
    browserPlayable: Boolean(item?.browserPlayable),
    sourceHeight: Number(item?.height || item?.sourceHeight || 0) || null,
    renditions: Array.isArray(item?.renditions) ? item.renditions : [],
  };
}

function buildRoomPlaybackSources(item) {
  const sources = {};
  if (item?.originalPlaybackUrl) {
    sources.playerQualityOriginal = item.originalPlaybackUrl;
  }
  for (const rendition of Array.isArray(item?.renditions) ? item.renditions : []) {
    if (rendition?.status !== 'ready' || !rendition?.playlistUrl) continue;
    const height = Number(rendition.height || 0);
    if (height === 1080) sources.playerQuality1080p = rendition.playlistUrl;
    if (height === 720) sources.playerQuality720p = rendition.playlistUrl;
    if (height === 480) sources.playerQuality480p = rendition.playlistUrl;
  }
  if (item?.masterPlaybackUrl) {
    sources.playerQualityAuto = item.masterPlaybackUrl;
  } else if (item?.playbackUrl) {
    sources.playerQualityAuto = item.playbackUrl;
  }
  return sources;
}

function getRoomQualityOptions(item) {
  const sourceHeight = Math.max(0, Number(item?.sourceHeight || 0));
  const renditions = Array.isArray(item?.renditions) ? item.renditions : [];
  const byHeight = new Map(renditions.map((rendition) => [Number(rendition.height || 0), rendition]));
  const options = [];

  if (sourceHeight > 0 && item?.browserPlayable) {
    options.push({
      key: 'playerQualityOriginal',
      label: t('room.playerQualityOriginal'),
    });
  }

  [
    [1080, 'playerQuality1080p'],
    [720, 'playerQuality720p'],
    [480, 'playerQuality480p'],
  ].forEach(([height, key]) => {
    if (sourceHeight > 0 && sourceHeight < height) return;
    const rendition = byHeight.get(height);
    if (rendition?.status !== 'ready') return;
    options.push({ key, label: t(`room.${key}`) });
  });

  return options;
}

function getMemberId(member, fallback) {
  return String(
    member?.id
      || member?.userId
      || member?.uid
      || member?.email
      || member?.name
      || fallback,
  );
}

function normalizeRoomMembers(room, user) {
  const rawMembers = [
    room?.members,
    room?.onlineUsers,
    room?.participants,
    room?.users,
  ].find((items) => Array.isArray(items) && items.length);
  const currentUserId = getMemberId(user, 'current-user');
  const currentUser = {
    id: currentUserId,
    name: user?.name || user?.email || t('room.memberFallbackName'),
    avatar: user?.avatarUrl || user?.avatar || '',
    isHost: Boolean(room?.isHost),
  };
  const members = [];
  const seen = new Set();

  const pushMember = (member, fallbackIndex) => {
    const id = getMemberId(member, fallbackIndex);
    if (!id || seen.has(id)) return;
    seen.add(id);
    members.push({
      id,
      name: member?.name || member?.displayName || member?.nickname || member?.email || t('room.memberFallbackName'),
      avatar: member?.avatar || member?.avatarUrl || member?.photoURL || '',
      isHost: Boolean(member?.isHost || member?.role === 'host' || member?.id === room?.hostId || id === room?.hostId),
    });
  };

  if (rawMembers) {
    rawMembers.forEach(pushMember);
  }

  if (!seen.has(currentUserId)) {
    members.unshift(currentUser);
  } else {
    const currentIndex = members.findIndex((member) => member.id === currentUserId);
    if (currentIndex >= 0) {
      members[currentIndex] = {
        ...members[currentIndex],
        name: currentUser.name || members[currentIndex].name,
        avatar: currentUser.avatar || members[currentIndex].avatar,
        isHost: members[currentIndex].isHost || currentUser.isHost,
      };
    }
  }

  return members;
}

function parseLogPayload(payloadJson) {
  if (!payloadJson || typeof payloadJson !== 'string') return {};
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isOpaqueUserId(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

function buildMemberNameLookup(room) {
  const members = Array.isArray(room?.members) ? room.members : [];
  const lookup = new Map();
  members.forEach((member) => {
    const id = String(member?.id || member?.userId || '').trim();
    const name = String(member?.name || member?.displayName || member?.nickname || member?.email || '').trim();
    if (id && name && !isOpaqueUserId(name)) {
      lookup.set(id, name);
    }
  });
  return lookup;
}

function resolveActivityActorName(log, memberNameLookup) {
  const explicitName = String(log?.actorName || log?.actorDisplayName || log?.actorUserName || '').trim();
  if (explicitName && !isOpaqueUserId(explicitName)) return explicitName;
  const actorUserId = String(log?.actorUserId || '').trim();
  const memberName = actorUserId ? String(memberNameLookup.get(actorUserId) || '').trim() : '';
  if (memberName && !isOpaqueUserId(memberName)) return memberName;
  return t('room.memberFallbackName');
}

function formatActivityLogText(log, roomId, memberNameLookup = new Map()) {
  const kind = String(log?.kind || '').trim();
  const payload = parseLogPayload(log?.payloadJson);
  const actorName = resolveActivityActorName(log, memberNameLookup);
  if (kind === 'room.created') return t('room.created', { id: payload.hash || roomId });
  if (kind === 'room.reconnected' || kind === 'room.host.reconnected') return t('room.reconnectingHostMessage');
  if (kind === 'room.host.disconnected') return t('room.hostDisconnectedTitle');
  if (kind === 'media.changed') return t('room.sourceMounted', { title: payload.mediaTitle || payload.mediaId || t('room.untitledMedia') });
  if (kind === 'playback.play') return t('room.userPressedPlay', { name: actorName });
  if (kind === 'playback.pause') return t('room.userPaused', { name: actorName });
  if (kind === 'playback.seek') return t('room.userSeeked', { name: actorName, time: Math.round(Number(payload.timeSec || 0)) });
  if (kind === 'member.joined') return t('room.memberJoinedLog', { name: actorName });
  if (kind === 'member.left') return t('room.memberLeftLog', { name: actorName });
  if (kind.startsWith('room.dismissed')) return t('room.dismissRoom');
  return kind || t('room.info');
}

function normalizeSnapshotActivityLogs(room) {
  const logs = Array.isArray(room?.snapshot?.activityLogs) ? room.snapshot.activityLogs : [];
  const memberNameLookup = buildMemberNameLookup(room);
  return logs.map((log, index) => ({
    id: log?.id || `activity:${room?.id || 'room'}:${index}`,
    type: 'system',
    kind: String(log?.kind || 'room'),
    createdAt: Number(log?.createdAt || 0) > 0 ? Number(log.createdAt) * 1000 : Date.now(),
    text: formatActivityLogText(log, room?.id, memberNameLookup),
    serverBacked: true,
  }));
}

function normalizeSnapshotChatMessages(room) {
  const messages = Array.isArray(room?.snapshot?.messages) ? room.snapshot.messages : [];
  return messages.map((message, index) => normalizeRoomMessage({
    ...message,
    id: message?.id || `chat:${room?.id || 'room'}:${index}`,
  })).filter(Boolean);
}

function normalizeRoomMessage(message) {
  if (!message) return null;
  return {
    id: message?.id || `chat:${Date.now()}:${Math.random()}`,
    type: 'chat',
    kind: message?.kind || 'chat',
    createdAt: Number(message?.createdAt || 0) > 0 ? Number(message.createdAt) * 1000 : Date.now(),
    user: message?.senderName || t('room.memberFallbackName'),
    userId: message?.senderUserId || '',
    avatar: message?.senderAvatarUrl || '',
    text: message?.body || '',
    videoTime: Number.isFinite(Number(message?.videoTimeSec)) ? Number(message.videoTimeSec) : null,
    mediaKey: message?.mediaKey || '',
    mediaId: message?.mediaId || '',
    serverBacked: true,
  };
}

function normalizeSnapshotMessages(room) {
  const snapshotMessages = [
    ...normalizeSnapshotActivityLogs(room),
    ...normalizeSnapshotChatMessages(room),
  ].sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));

  if (snapshotMessages.length > 0) return snapshotMessages;

  return [{
    id: `fallback-room-created:${room?.id || 'room'}`,
    type: 'system',
    kind: 'room.created',
    createdAt: Date.now(),
    text: t('room.created', { id: room?.id || '' }),
  }];
}

function mergeMessageLists(previousMessages, nextMessages) {
  const byId = new Map();
  const hasServerBackedActivity = nextMessages.some((message) => message?.serverBacked && message?.type !== 'chat');
  const previous = hasServerBackedActivity
    ? previousMessages.filter((message) => !String(message?.id || '').startsWith('fallback-room-created:'))
    : previousMessages;
  [...previous, ...nextMessages].forEach((message) => {
    if (!message?.id) return;
    byId.set(message.id, { ...byId.get(message.id), ...message });
  });
  return Array.from(byId.values())
    .sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

export default function WatchRoom({ user, room, onLeave, onDismiss, isDark, toggleTheme }) {
  const [messages, setMessages] = useState(() => normalizeSnapshotMessages(room));
  const [chatInput, setChatInput] = useState('');
  const [danmakuInput, setDanmakuInput] = useState('');
  const [currentMediaKey, setCurrentMediaKey] = useState('');
  const [syncStatus] = useState('connected');
  const [sourceTab, setSourceTab] = useState('library');
  const [sourceInput, setSourceInput] = useState('');
  const [cloudMediaItems, setCloudMediaItems] = useState([]);
  const [cloudMediaStatus, setCloudMediaStatus] = useState('idle');
  const [cloudMediaError, setCloudMediaError] = useState('');
  const [selectedMediaId, setSelectedMediaId] = useState('');
  const [mobileTab, setMobileTab] = useState('room');
  const [mobileTabDragOffset, setMobileTabDragOffset] = useState(0);
  const [mobileTabViewportWidth, setMobileTabViewportWidth] = useState(0);
  const [isMobileTabDragging, setIsMobileTabDragging] = useState(false);
  const [isMobileTabSettling, setIsMobileTabSettling] = useState(false);
  const [gpuVideoRenderingEnabled, setGpuVideoRenderingEnabled] = useState(() => readGpuVideoRenderingPreference());
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [copyState, setCopyState] = useState('idle');
  const [playerBrightness, setPlayerBrightness] = useState(1);
  const [showDanmaku, setShowDanmaku] = useState(true);
  const [isDanmakuAnimating, setIsDanmakuAnimating] = useState(false);
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [topBarMenuOpen, setTopBarMenuOpen] = useState(false);
  const [playerMenuOpen, setPlayerMenuOpen] = useState(null);
  const [roomMembers, setRoomMembers] = useState(() => normalizeRoomMembers(room, user));
  const [roomPanelSection, setRoomPanelSection] = useState('none');
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const [dismissConfirmClosing, setDismissConfirmClosing] = useState(false);
  const [roomActionError, setRoomActionError] = useState('');
  const [roomActionLoading, setRoomActionLoading] = useState(false);
  const [quickContacts, setQuickContacts] = useState([]);
  const [inviteContactsLoading, setInviteContactsLoading] = useState(false);
  const [onlineUserIdSet, setOnlineUserIdSet] = useState(() => new Set(getPresenceOnlineUserIds()));

  const chatEndRef = useRef(null);
  const copyResetTimerRef = useRef(null);
  const dismissConfirmCloseTimerRef = useRef(null);
  const hydratedRoomIdRef = useRef(room?.id || '');
  const mobileTabTouchRef = useRef(null);
  const mobileTabSettleTimerRef = useRef(null);
  const mobileTabSettleFrameRef = useRef(null);
  const mobileTabSwipePreventClickRef = useRef(false);
  const mobileTabSwipeClickGuardRef = useRef({ x: 0, y: 0, expiresAt: 0 });
  const mobileTabSwipeClickGuardTimerRef = useRef(null);
  const lastAppliedRoomPlaybackRevisionRef = useRef(0);
  const lastMountedRoomMediaKeyRef = useRef('');
  const lastRoomNoticeRef = useRef({ key: '', at: 0 });
  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, { id: Date.now() + Math.random(), createdAt: Date.now(), ...msg }]);
  }, []);

  const addRoomNotice = useCallback((key, text) => {
    const nextText = String(text || '').trim();
    if (!nextText) return;
    const now = Date.now();
    if (lastRoomNoticeRef.current.key === key && now - lastRoomNoticeRef.current.at < 2500) return;
    lastRoomNoticeRef.current = { key, at: now };
    addMessage({ type: 'system', kind: 'notice', text: nextText });
  }, [addMessage]);

  const visibleChatMessages = useMemo(() => messages.filter((msg) => (
    msg.type === 'chat' || msg.kind === 'notice'
  )), [messages]);
  const roomActivityLogs = useMemo(() => messages.filter((msg) => msg.type !== 'chat' && msg.kind !== 'notice'), [messages]);
  const chatCount = useMemo(() => visibleChatMessages.length, [visibleChatMessages]);
  const selectedMediaItem = useMemo(
    () => cloudMediaItems.find((item) => item.id === selectedMediaId) || null,
    [cloudMediaItems, selectedMediaId],
  );
  const availableQualityOptions = useMemo(
    () => (selectedMediaItem
      ? [{ key: 'playerQualityAuto', label: t('room.playerQualityAuto') }, ...getRoomQualityOptions(selectedMediaItem)]
      : [{ key: 'playerQualityAuto', label: t('room.playerQualityAuto') }]),
    [selectedMediaItem],
  );
  const isCurrentUserHostForPlayback = useMemo(() => {
    const currentUserId = getMemberId(user, 'current-user');
    return Boolean(room?.isHost || roomMembers.some((member) => member.id === currentUserId && member.isHost));
  }, [room?.isHost, roomMembers, user]);
  const canBroadcastPlayback = room.hostOnlyControl === false || isCurrentUserHostForPlayback;
  const playback = useRoomPlaybackController({
    selectedMediaItem,
    availableQualityOptions,
    addMessage,
    userName: user.name,
    canBroadcastPlayback,
    onPlaybackEvent: (action, detail = {}) => {
      if (!room?.id || !hasMountedMediaSource || !canBroadcastPlayback) return;
      const body = {
        action,
        currentTimeSec: Number.isFinite(Number(detail.currentTimeSec)) ? Number(detail.currentTimeSec) : currentTime,
      };
      if (action === 'rate') {
        body.playbackRate = Number.isFinite(Number(detail.playbackRate)) ? Number(detail.playbackRate) : speed;
      }
      fetch(`/api/rooms/${encodeURIComponent(room.id)}/playback`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          ...buildRoomClientHeaders(),
        },
        body: JSON.stringify(body),
      }).catch(() => {
        addMessage({ type: 'system', kind: 'notice', text: t('room.syncAbnormal') });
      });
    },
  });
  const {
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
    qualitySwitchState,
    qualitySwitchToastVisible,
    qualitySwitchPreservePlayState,
    progressPercent,
    getActiveVideoElement,
    applyExternalPlaybackState,
    mountPlaybackSource,
    resetPlaybackSource,
    setSpeed,
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
  } = playback;
  const effectiveMediaKey = currentMediaKey
    || lastMountedRoomMediaKeyRef.current
    || (currentVideoSrc ? buildDirectMediaKey(currentVideoSrc) : '');
  const effectiveMediaId = selectedMediaId || (currentVideoSrc ? buildDirectMediaId(currentVideoSrc) : '');
  const activeDanmakuItems = useChatDanmakuItems({
    messages,
    currentMediaKey: effectiveMediaKey,
    currentMediaId: effectiveMediaId,
    currentTime,
    showDanmaku,
  });
  const danmakuLayer = showDanmaku && activeDanmakuItems.length > 0 ? (
    <ChatDanmakuLayer
      items={activeDanmakuItems}
      currentTime={currentTime}
      isPlaying={isPlaying}
    />
  ) : null;

  const hasMountedMediaSource = Boolean(effectiveMediaKey || currentVideoSrc);
  const canEditChat = room.allowChat !== false;
  const canSubmitChat = canEditChat;
  const applyExternalPlaybackStateWithRetry = useCallback((roomPlayback, attempt = 0) => {
    return Promise.resolve(applyExternalPlaybackState(roomPlayback)).then((applied) => {
      if (applied || attempt >= 20) return applied;
      return new Promise((resolve) => {
        window.setTimeout(() => {
          resolve(applyExternalPlaybackStateWithRetry(roomPlayback, attempt + 1));
        }, 250);
      });
    });
  }, [applyExternalPlaybackState]);
  const mobileTabProgress = useMemo(() => {
    const width = Math.max(1, mobileTabViewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 1));
    const baseProgress = mobileTab === 'chat' ? 1 : 0;
    return baseProgress - (mobileTabDragOffset / width);
  }, [mobileTab, mobileTabDragOffset, mobileTabViewportWidth]);

  const onlineUsers = roomMembers;
  const onlineFriends = useMemo(() => quickContacts.filter((contact) => {
    const normalizedId = normalizePresenceUserId(contact.id);
    return normalizedId && onlineUserIdSet.has(normalizedId);
  }), [onlineUserIdSet, quickContacts]);
  const isCurrentUserHost = useMemo(() => {
    const currentUserId = getMemberId(user, 'current-user');
    return Boolean(room?.isHost || roomMembers.some((member) => member.id === currentUserId && member.isHost));
  }, [room?.isHost, roomMembers, user]);
  const roomStatus = String(room?.status || 'open');
  const hostDisconnectedForViewer = roomStatus === 'host_disconnected' && !isCurrentUserHost;
  const playerControlLocked = hostDisconnectedForViewer || (room.hostOnlyControl !== false && !isCurrentUserHost);

  const runHostOnlyAction = useCallback((action) => {
    if (playerControlLocked) {
      addRoomNotice(
        hostDisconnectedForViewer ? 'host-disconnected-control' : 'host-only-control',
        hostDisconnectedForViewer ? t('room.hostDisconnectedMessage') : t('room.hostOnlyControlNotice'),
      );
      return undefined;
    }
    return action();
  }, [addRoomNotice, hostDisconnectedForViewer, playerControlLocked]);

  useEffect(() => {
    if (roomStatus === 'host_disconnected') {
      applyExternalPlaybackStateWithRetry({ currentTimeSec: 0, paused: true, playbackRate: 1 });
      addRoomNotice('host-disconnected', t('room.hostDisconnectedMessage'));
    }
  }, [addRoomNotice, applyExternalPlaybackStateWithRetry, roomStatus]);

  useEffect(() => {
    setRoomMembers(normalizeRoomMembers(room, user));
  }, [room?.hostId, room?.id, room?.members, room?.status, user]);

  useEffect(() => {
    const nextRoomId = room?.id || '';
    const nextMessages = normalizeSnapshotMessages(room);
    setMessages((previousMessages) => {
      if (hydratedRoomIdRef.current !== nextRoomId) {
        hydratedRoomIdRef.current = nextRoomId;
        return nextMessages;
      }
      return mergeMessageLists(previousMessages, nextMessages);
    });
  }, [room]);

  const heartbeatRoomId = room?.id || '';
  const heartbeatRoomStatus = room?.status;
  const heartbeatRoomHostId = room?.hostId;
  const heartbeatRoomMembers = room?.members;

  useEffect(() => {
    if (!heartbeatRoomId) return undefined;
    let alive = true;
    const sendHeartbeat = async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(heartbeatRoomId)}/heartbeat`, {
          method: 'POST',
          credentials: 'include',
          headers: buildRoomClientHeaders(),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok === false) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        const snapshot = payload?.data;
        if (alive && snapshot && (Array.isArray(snapshot.members) || snapshot.room)) {
          const snapshotHostId = snapshot.room?.hostUserId || heartbeatRoomHostId;
          const snapshotMembers = Array.isArray(snapshot.members)
            ? snapshot.members.map((member) => ({
              id: member.userId || member.id,
              userId: member.userId || '',
              name: member.displayName || member.name || t('room.memberFallbackName'),
              displayName: member.displayName || member.name || '',
              avatar: member.avatarUrl || member.avatar || '',
              avatarUrl: member.avatarUrl || member.avatar || '',
              role: member.role || 'member',
              isHost: member.role === 'host' || member.userId === snapshotHostId,
            }))
            : heartbeatRoomMembers;
          setRoomMembers(normalizeRoomMembers({
            status: snapshot.room?.status || heartbeatRoomStatus,
            hostId: snapshotHostId,
            isHost: String(snapshotHostId || '') === String(user?.id || ''),
            members: snapshotMembers,
          }, user));
        }
      } catch {
        if (alive) {
          setRoomActionError(t('room.heartbeatFailed'));
        }
      }
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 25000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [heartbeatRoomHostId, heartbeatRoomId, heartbeatRoomMembers, heartbeatRoomStatus, user]);

  const leaveRoom = useCallback(async () => {
    if (roomActionLoading) return;
    setRoomActionLoading(true);
    setRoomActionError('');
    try {
      resetPlaybackSource();
      await onLeave?.();
    } catch (error) {
      setRoomActionError(error?.message || t('room.leaveFailed'));
    } finally {
      setRoomActionLoading(false);
    }
  }, [onLeave, resetPlaybackSource, roomActionLoading]);

  const openDismissConfirm = useCallback(() => {
    if (dismissConfirmCloseTimerRef.current) {
      window.clearTimeout(dismissConfirmCloseTimerRef.current);
      dismissConfirmCloseTimerRef.current = null;
    }
    setDismissConfirmClosing(false);
    setDismissConfirmOpen(true);
  }, []);

  const closeDismissConfirm = useCallback(() => {
    if (!dismissConfirmOpen || dismissConfirmClosing) return;
    setDismissConfirmClosing(true);
    dismissConfirmCloseTimerRef.current = window.setTimeout(() => {
      dismissConfirmCloseTimerRef.current = null;
      setDismissConfirmOpen(false);
      setDismissConfirmClosing(false);
    }, MODAL_CLOSE_MS);
  }, [dismissConfirmClosing, dismissConfirmOpen]);

  const dismissRoom = useCallback(async () => {
    if (roomActionLoading) return;
    setRoomActionLoading(true);
    setRoomActionError('');
    try {
      resetPlaybackSource();
      await onDismiss?.();
    } catch (error) {
      setRoomActionError(error?.message || t('room.dismissFailed'));
      setRoomActionLoading(false);
    }
  }, [onDismiss, resetPlaybackSource, roomActionLoading]);

  useEffect(() => () => {
    if (dismissConfirmCloseTimerRef.current) {
      window.clearTimeout(dismissConfirmCloseTimerRef.current);
      dismissConfirmCloseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onPresenceChanged = (event) => {
      setOnlineUserIdSet(new Set(normalizePresenceOnlineUserIds(event?.detail?.onlineUserIds || [])));
    };
    window.addEventListener(PRESENCE_CHANGED_EVENT, onPresenceChanged);
    return () => {
      window.removeEventListener(PRESENCE_CHANGED_EVENT, onPresenceChanged);
    };
  }, []);

  useEffect(() => {
    const onProfileUpdated = (event) => {
      const profile = event?.detail || {};
      const profileUserId = normalizePresenceUserId(profile.userId || profile.id);
      if (!profileUserId) return;
      setRoomMembers((prev) => prev.map((member) => {
        const memberId = normalizePresenceUserId(member.id || member.userId);
        if (memberId !== profileUserId) return member;
        return {
          ...member,
          name: profile.displayName || profile.name || member.name,
          avatar: profile.avatarUrl || member.avatar || '',
          avatarUrl: profile.avatarUrl || member.avatarUrl || '',
        };
      }));
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, onProfileUpdated);
    return () => window.removeEventListener(PROFILE_UPDATED_EVENT, onProfileUpdated);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleChatMessages]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => subscribeGpuVideoRenderingPreference(setGpuVideoRenderingEnabled), []);

  const loadCloudMediaItems = useCallback(async ({ signal } = {}) => {
    setCloudMediaStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    setCloudMediaError('');
    try {
      const response = await fetch('/api/media?limit=200', {
        credentials: 'include',
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      const items = Array.isArray(payload?.items) ? payload.items.map(mapCloudMediaItem).filter((item) => item.id) : [];
      setCloudMediaItems(items);
      setCloudMediaStatus('ready');
      setSelectedMediaId((prev) => (prev && items.some((item) => item.id === prev) ? prev : ''));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setCloudMediaStatus('error');
      setCloudMediaError(error?.message || t('room.cloudLibraryLoadFailed'));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadCloudMediaItems({ signal: controller.signal });
    return () => controller.abort();
  }, [loadCloudMediaItems]);

  useEffect(() => {
    const handleMediaChanged = () => {
      loadCloudMediaItems();
    };
    window.addEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
    return () => window.removeEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
  }, [loadCloudMediaItems]);

  useEffect(() => () => {
    if (mobileTabSettleTimerRef.current) {
      window.clearTimeout(mobileTabSettleTimerRef.current);
    }
    if (mobileTabSettleFrameRef.current) {
      window.cancelAnimationFrame(mobileTabSettleFrameRef.current);
    }
    if (mobileTabSwipeClickGuardTimerRef.current) {
      window.clearTimeout(mobileTabSwipeClickGuardTimerRef.current);
    }
  }, []);

  const {
    playerChromeVisible,
    transientFeedbacks,
    continuousFeedback,
    topFeedback,
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
  } = usePlayerInteractions({
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
  });

  useEffect(() => {
    revealPlayerChrome();
  }, [currentVideoSrc, revealPlayerChrome]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const setMediaAction = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers expose Media Session but do not support every action.
      }
    };

    setMediaAction('play', () => runHostOnlyAction(() => {
      if (getActiveVideoElement()?.paused) togglePlay();
    }));
    setMediaAction('pause', () => runHostOnlyAction(() => {
      if (!getActiveVideoElement()?.paused) togglePlay();
    }));
    setMediaAction('seekbackward', () => runHostOnlyAction(() => seekBy(-10)));
    setMediaAction('seekforward', () => runHostOnlyAction(() => seekBy(10)));
    setMediaAction('seekto', (details) => {
      runHostOnlyAction(() => {
        if (typeof details.seekTime === 'number') handleSeek(details.seekTime);
      });
    });

    return () => {
      ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach((action) => {
        setMediaAction(action, null);
      });
    };
  }, [getActiveVideoElement, handleSeek, runHostOnlyAction, seekBy, togglePlay]);

  const copyRoomLink = async () => {
    const text = `Room ID: ${room.id}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const tempInput = document.createElement('input');
      tempInput.value = text;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
    }
    addMessage({ type: 'system', kind: 'room', text: t('room.roomCopied') });
    setCopyState('success');
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState('idle');
      copyResetTimerRef.current = null;
    }, 1800);
  };

  const removeRoomMember = useCallback((memberId) => {
    if (!isCurrentUserHost) return;
    const target = roomMembers.find((member) => member.id === memberId);
    if (!target || target.isHost) return;
    setRoomMembers((prev) => prev.filter((member) => member.id !== memberId));
    addMessage({ type: 'system', kind: 'room', text: t('room.memberRemoved', { name: target.name }) });
  }, [addMessage, isCurrentUserHost, roomMembers]);

  const clearRoomMembers = useCallback(() => {
    if (!isCurrentUserHost) return;
    const hosts = roomMembers.filter((member) => member.isHost);
    if (hosts.length === roomMembers.length) return;
    setRoomMembers(hosts.length ? hosts : roomMembers.slice(0, 1));
    addMessage({ type: 'system', kind: 'room', text: t('room.membersCleared') });
  }, [addMessage, isCurrentUserHost, roomMembers]);

  const toggleInviteFriends = useCallback(async () => {
    if (roomPanelSection === 'friends') {
      setRoomPanelSection('none');
      return;
    }
    setRoomPanelSection('friends');
    setInviteContactsLoading(true);
    const contacts = await prefetchContactsCache({ limit: 200 });
    setQuickContacts(Array.isArray(contacts) ? contacts : []);
    setInviteContactsLoading(false);
  }, [roomPanelSection]);

  const sendRoomInvite = useCallback(async (contact) => {
    if (!contact?.id) return;
    const roomTitle = String(room?.title || '').trim() || t('room.defaultRoomTitle');
    const maxMembers = Number.isFinite(Number(room?.maxMembers)) ? Number(room.maxMembers) : 8;
    try {
      const response = await fetch('/api/room-invites', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          receiverUserId: contact.id,
          roomHash: room.id,
          roomTitle,
          memberCount: roomMembers.length,
          maxMembers,
          message: t('room.inviteMessageReceived', {
            name: user.name || t('room.memberFallbackName'),
            title: roomTitle,
            id: room.id,
            count: roomMembers.length,
            max: maxMembers,
          }),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      addMessage({
        type: 'system',
        kind: 'room',
        text: t('room.inviteMessageSent', {
          name: contact.name || t('room.memberFallbackName'),
          title: roomTitle,
          id: room.id,
          count: roomMembers.length,
          max: maxMembers,
        }),
      });
    } catch (error) {
      addMessage({
        type: 'system',
        kind: 'notice',
        text: error?.message || t('room.inviteMessageFailed'),
      });
    }
  }, [addMessage, room, roomMembers.length, user.name]);

  const pushChatMessage = async (text) => {
    if (!canSubmitChat) return false;
    const nextText = String(text || '').trim();
    if (!nextText) return false;
    const activeVideo = getActiveVideoElement();
    const hasMediaForMessage = Boolean(effectiveMediaKey || currentVideoSrc);
    const videoTime = hasMediaForMessage && Number.isFinite(activeVideo?.currentTime) ? activeVideo.currentTime : null;
    const mediaKey = hasMediaForMessage ? effectiveMediaKey : '';
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          ...buildRoomClientHeaders(),
        },
        body: JSON.stringify({
          body: nextText,
          mediaId: hasMediaForMessage ? selectedMediaId || buildDirectMediaId(currentVideoSrc) : '',
          mediaKey,
          videoTimeSec: videoTime,
          kind: 'chat',
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      const savedMessage = normalizeRoomMessage(payload?.data || payload?.message);
      if (savedMessage) {
        setMessages((prev) => mergeMessageLists(prev, [savedMessage]));
      }
    } catch (error) {
      addMessage({
        type: 'chat',
        user: user.name,
        text: nextText,
        videoTime,
        mediaKey,
        userId: user.id || user.email || user.name,
        avatar: user.avatarUrl || '',
      });
      addMessage({ type: 'system', kind: 'notice', text: error?.message || t('room.syncAbnormal') });
    }
    return true;
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!await pushChatMessage(chatInput)) return;
    setChatInput('');
  };

  const sendDanmakuMessage = async (e) => {
    e.preventDefault();
    if (!await pushChatMessage(danmakuInput)) return false;
    setDanmakuInput('');
    return true;
  };

  const handleCastDirectSource = async () => {
    if (playerControlLocked) {
      addRoomNotice(
        hostDisconnectedForViewer ? 'host-disconnected-control' : 'host-only-control',
        hostDisconnectedForViewer ? t('room.hostDisconnectedMessage') : t('room.hostOnlyControlNotice'),
      );
      return;
    }
    const source = sourceInput.trim();
    if (!source) return;
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      addMessage({ type: 'system', kind: 'error', text: t('room.sourceUnsupported') });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      addMessage({ type: 'system', kind: 'error', text: t('room.sourceUnsupported') });
      return;
    }

    const nextSource = parsed.href;
    const nextMediaKey = buildDirectMediaKey(nextSource);
    const nextMediaId = buildDirectMediaId(nextSource);
    lastMountedRoomMediaKeyRef.current = nextMediaKey;
    setCurrentMediaKey(nextMediaKey);
    setSelectedMediaId('');
    mountPlaybackSource({
      source: nextSource,
      sources: { playerQualityAuto: nextSource },
      qualityKey: 'playerQualityAuto',
      durationSec: 0,
    });
    try {
      await fetch(`/api/rooms/${encodeURIComponent(room.id)}/media`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          ...buildRoomClientHeaders(),
        },
        body: JSON.stringify({
          mediaId: nextMediaId,
          mediaKey: nextMediaKey,
          mediaTitle: parsed.hostname,
          durationSec: 0,
          sourceType: 'direct_url',
        }),
      });
    } catch {
      addMessage({ type: 'system', kind: 'notice', text: t('room.syncAbnormal') });
    }
    setPlayerMenuOpen(null);
    setShowLinkInput(false);
    setSourceTab('direct');
    addMessage({ type: 'system', kind: 'source', text: t('room.directSourceMounted', { source: parsed.hostname }) });
  };

  const mountLibraryItem = async (item) => {
    if (playerControlLocked) {
      addRoomNotice(
        hostDisconnectedForViewer ? 'host-disconnected-control' : 'host-only-control',
        hostDisconnectedForViewer ? t('room.hostDisconnectedMessage') : t('room.hostOnlyControlNotice'),
      );
      return;
    }
    if (!item?.id) return;
    if (!item.playable) {
      addMessage({ type: 'system', kind: 'error', text: t('room.mediaNotReady') });
      return;
    }

    setSelectedMediaId(item.id);

    try {
      const response = await fetch(`/api/media/${encodeURIComponent(item.id)}/playback`, { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false || !payload?.media?.playbackUrl) {
        throw new Error(payload?.error || t('room.mediaNotReady'));
      }

      const baseRenditionsByHeight = new Map(
        (Array.isArray(item.renditions) ? item.renditions : [])
          .map((rendition) => [Number(rendition.height || 0), rendition]),
      );
      const payloadRenditions = Array.isArray(payload?.media?.sources?.renditions) ? payload.media.sources.renditions : item.renditions;
      const nextRenditions = (Array.isArray(payloadRenditions) ? payloadRenditions : []).map((rendition) => {
        const height = Number(rendition.height || 0);
        const baseRendition = baseRenditionsByHeight.get(height) || {};
        return {
          ...baseRendition,
          ...rendition,
          sizeBytes: Number(rendition.sizeBytes || baseRendition.sizeBytes || 0) || 0,
        };
      });
      const nextMediaForPlayback = {
        ...item,
        playbackUrl: payload.media.playbackUrl || item.playbackUrl,
        originalPlaybackUrl: payload?.media?.sources?.originalPlaybackUrl || item.originalPlaybackUrl,
        masterPlaybackUrl: payload?.media?.sources?.masterPlaybackUrl || item.masterPlaybackUrl,
        browserPlayable: item.browserPlayable || Boolean(payload?.media?.sources?.originalPlaybackUrl),
        sourceHeight: item.sourceHeight || payload?.media?.height || null,
        durationSec: Number(item.durationSec || payload?.media?.durationSec || 0) || 0,
        originalSizeBytes: Number(item.originalSizeBytes || payload?.media?.originalSizeBytes || 0) || 0,
        renditions: nextRenditions,
      };
      const nextSources = buildRoomPlaybackSources(nextMediaForPlayback);
      const initialPlayback = pickInitialPlaybackSource(nextMediaForPlayback, nextSources);
      const nextSource = initialPlayback.source || payload.media.playbackUrl;
      const nextMediaKey = buildCloudMediaKey({
        ...item,
        ...payload.media,
        contentHash: payload?.media?.contentHash
          || payload?.media?.hash
          || payload?.media?.sha256
          || payload?.media?.fileHash
          || item.contentHash,
      });
      lastMountedRoomMediaKeyRef.current = nextMediaKey;
      setCurrentMediaKey(nextMediaKey);
      setSourceInput('');
      mountPlaybackSource({
        source: nextSource,
        sources: nextSources,
        qualityKey: initialPlayback.key || 'playerQualityAuto',
        durationSec: Number(item.durationSec || payload?.media?.durationSec || 0) || 0,
        mediaItem: nextMediaForPlayback,
      });
      try {
        await fetch(`/api/rooms/${encodeURIComponent(room.id)}/media`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...buildRoomClientHeaders(),
          },
          body: JSON.stringify({
            mediaId: item.id,
            mediaKey: nextMediaKey,
            mediaTitle: payload.media.title || item.title,
            durationSec: Number(item.durationSec || payload?.media?.durationSec || 0) || 0,
            sourceType: 'cloud_media',
          }),
        });
      } catch {
        addMessage({ type: 'system', kind: 'notice', text: t('room.syncAbnormal') });
      }
      addMessage({ type: 'system', kind: 'source', text: t('room.sourceMounted', { title: payload.media.title || item.title }) });
    } catch (error) {
      addMessage({ type: 'system', kind: 'error', text: error?.message || t('room.mediaNotReady') });
    }
  };

  const applyRoomPlaybackSource = useCallback(async (roomPlayback, { applyState = true } = {}) => {
    if (!roomPlayback?.mediaId && !roomPlayback?.mediaKey) return false;
    const mediaKey = String(roomPlayback.mediaKey || '').trim();
    const sourceType = String(roomPlayback.sourceType || '').trim();

    if (sourceType === 'direct_url' || mediaKey.startsWith('url:')) {
      const source = getDirectSourceFromMediaKey(mediaKey);
      if (!source) return false;
      if (lastMountedRoomMediaKeyRef.current !== mediaKey || currentVideoSrc !== source) {
        lastMountedRoomMediaKeyRef.current = mediaKey;
        setCurrentMediaKey(mediaKey);
        setSelectedMediaId('');
        setSourceTab('direct');
        mountPlaybackSource({
          source,
          sources: { playerQualityAuto: source },
          qualityKey: 'playerQualityAuto',
          durationSec: Number(roomPlayback.durationSec || 0) || 0,
        });
      }
      if (applyState) {
        return applyExternalPlaybackStateWithRetry(roomPlayback);
      }
      return true;
    }

    const mediaId = String(roomPlayback.mediaId || '').trim();
    if (!mediaId) return false;
    if (
      applyState
      && mediaKey
      && lastMountedRoomMediaKeyRef.current === mediaKey
      && currentVideoSrc
    ) {
      return applyExternalPlaybackStateWithRetry(roomPlayback);
    }
    setSelectedMediaId(mediaId);
    const item = cloudMediaItems.find((candidate) => candidate.id === mediaId) || {
      id: mediaId,
      title: roomPlayback.mediaTitle || t('room.untitledMedia'),
      playable: true,
      contentHash: mediaKey.startsWith('hash:') ? mediaKey.slice(5) : '',
      durationSec: Number(roomPlayback.durationSec || 0) || 0,
      renditions: [],
    };

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/media/playback`, { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false || !payload?.media?.playbackUrl) {
        throw new Error(payload?.error || t('room.mediaNotReady'));
      }

      const nextMediaForPlayback = {
        ...item,
        playbackUrl: payload.media.playbackUrl || item.playbackUrl,
        originalPlaybackUrl: payload?.media?.sources?.originalPlaybackUrl || item.originalPlaybackUrl,
        masterPlaybackUrl: payload?.media?.sources?.masterPlaybackUrl || item.masterPlaybackUrl,
        browserPlayable: item.browserPlayable || Boolean(payload?.media?.sources?.originalPlaybackUrl),
        sourceHeight: item.sourceHeight || payload?.media?.height || null,
        durationSec: Number(roomPlayback.durationSec || item.durationSec || payload?.media?.durationSec || 0) || 0,
        renditions: Array.isArray(payload?.media?.sources?.renditions) ? payload.media.sources.renditions : item.renditions,
      };
      const nextSources = buildRoomPlaybackSources(nextMediaForPlayback);
      const initialPlayback = pickInitialPlaybackSource(nextMediaForPlayback, nextSources);
      const nextSource = initialPlayback.source || payload.media.playbackUrl;
      const nextMediaKey = mediaKey || buildCloudMediaKey({
        ...item,
        ...payload.media,
        contentHash: payload?.media?.contentHash
          || payload?.media?.hash
          || payload?.media?.sha256
          || payload?.media?.fileHash
          || item.contentHash,
      });

      if (lastMountedRoomMediaKeyRef.current !== nextMediaKey || currentVideoSrc !== nextSource) {
        lastMountedRoomMediaKeyRef.current = nextMediaKey;
        setCurrentMediaKey(nextMediaKey);
        setSourceTab('library');
        mountPlaybackSource({
          source: nextSource,
          sources: nextSources,
          qualityKey: initialPlayback.key || 'playerQualityAuto',
          durationSec: Number(roomPlayback.durationSec || item.durationSec || payload?.media?.durationSec || 0) || 0,
          mediaItem: nextMediaForPlayback,
        });
      }
      if (applyState) {
        return applyExternalPlaybackStateWithRetry(roomPlayback);
      }
      return true;
    } catch (error) {
      addMessage({ type: 'system', kind: 'error', text: error?.message || t('room.mediaNotReady') });
      return false;
    }
  }, [addMessage, applyExternalPlaybackStateWithRetry, cloudMediaItems, currentVideoSrc, mountPlaybackSource, room.id]);

  useEffect(() => {
    const snapshotPlayback = room?.snapshot?.playback;
    if (!snapshotPlayback?.mediaId && !snapshotPlayback?.mediaKey) return;
    const revision = Number(snapshotPlayback.revision || 0) || 0;
    if (revision > 0 && revision <= lastAppliedRoomPlaybackRevisionRef.current) return;
    Promise.resolve(applyRoomPlaybackSource(snapshotPlayback)).then((applied) => {
      if (applied && revision > 0) {
        lastAppliedRoomPlaybackRevisionRef.current = Math.max(lastAppliedRoomPlaybackRevisionRef.current, revision);
      }
    });
  }, [applyRoomPlaybackSource, room?.snapshot?.playback]);

  useEffect(() => {
    if (!room?.id) return undefined;
    const roomId = String(room.id || '').toUpperCase();
    const handleRoomRealtime = (event) => {
      const detail = event?.detail || {};
      const payload = detail.payload || {};
      const eventRoomHash = String(payload.roomHash || '').toUpperCase();
      if (eventRoomHash && eventRoomHash !== roomId) return;

      if (detail.type === 'room.message.created') {
        const nextMessage = normalizeRoomMessage(payload.message);
        if (nextMessage) {
          setMessages((prev) => mergeMessageLists(prev, [nextMessage]));
        }
        return;
      }

      if (detail.type === 'room.host.disconnected') {
        applyExternalPlaybackStateWithRetry({ currentTimeSec: 0, paused: true, playbackRate: 1 });
        addRoomNotice('host-disconnected', t('room.hostDisconnectedMessage'));
        return;
      }

      if (detail.type === 'room.host.reconnected') {
        addRoomNotice('host-reconnected', t('room.reconnectingHostMessage'));
        return;
      }

      if (detail.type === 'room.media.changed') {
        const nextPlayback = payload.playback || payload;
        applyRoomPlaybackSource(nextPlayback);
        return;
      }

      if (detail.type === 'room.playback.updated') {
        const nextPlayback = payload.playback || payload;
        const revision = Number(nextPlayback?.revision || payload.revision || 0) || 0;
        if (revision > 0 && revision <= lastAppliedRoomPlaybackRevisionRef.current) return;
        Promise.resolve(applyRoomPlaybackSource(nextPlayback)).then((applied) => {
          if (applied && revision > 0) {
            lastAppliedRoomPlaybackRevisionRef.current = Math.max(lastAppliedRoomPlaybackRevisionRef.current, revision);
          }
        });
      }
    };
    window.addEventListener(ROOM_REALTIME_EVENT, handleRoomRealtime);
    return () => window.removeEventListener(ROOM_REALTIME_EVENT, handleRoomRealtime);
  }, [addRoomNotice, applyExternalPlaybackStateWithRetry, applyRoomPlaybackSource, room?.id]);

  const isMobileTabSwipeTarget = (target) => {
    if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 767px)').matches) return false;
    return !target?.closest?.('input, textarea, select, [contenteditable="true"], [data-swipe-ignore="true"]');
  };
  const clearMobileTabSettleTimer = () => {
    if (mobileTabSettleTimerRef.current) {
      window.clearTimeout(mobileTabSettleTimerRef.current);
      mobileTabSettleTimerRef.current = null;
    }
    if (mobileTabSettleFrameRef.current) {
      window.cancelAnimationFrame(mobileTabSettleFrameRef.current);
      mobileTabSettleFrameRef.current = null;
    }
  };
  const clearMobileTabSwipeClickGuard = () => {
    mobileTabSwipePreventClickRef.current = false;
    mobileTabSwipeClickGuardRef.current = { x: 0, y: 0, expiresAt: 0 };
    if (mobileTabSwipeClickGuardTimerRef.current) {
      window.clearTimeout(mobileTabSwipeClickGuardTimerRef.current);
      mobileTabSwipeClickGuardTimerRef.current = null;
    }
  };
  const armMobileTabSwipeClickGuard = (touch) => {
    clearMobileTabSwipeClickGuard();
    mobileTabSwipePreventClickRef.current = true;
    mobileTabSwipeClickGuardRef.current = {
      x: touch?.clientX ?? 0,
      y: touch?.clientY ?? 0,
      expiresAt: Date.now() + 450,
    };
    mobileTabSwipeClickGuardTimerRef.current = window.setTimeout(() => {
      clearMobileTabSwipeClickGuard();
    }, 450);
  };
  const settleMobileTabSwipe = (targetTab, targetOffset = 0) => {
    clearMobileTabSettleTimer();
    setIsMobileTabDragging(false);
    setIsMobileTabSettling(true);
    mobileTabSettleFrameRef.current = window.requestAnimationFrame(() => {
      mobileTabSettleFrameRef.current = null;
      setMobileTabDragOffset(targetOffset);
      mobileTabSettleTimerRef.current = window.setTimeout(() => {
        setMobileTab(targetTab);
        setMobileTabDragOffset(0);
        setIsMobileTabSettling(false);
        mobileTabSettleTimerRef.current = null;
      }, 320);
    });
  };
  const handleMobileTabTouchStart = (event) => {
    if (!isMobileTabSwipeTarget(event.target) || event.touches.length !== 1) return;
    clearMobileTabSettleTimer();
    const touch = event.touches[0];
    const width = event.currentTarget.clientWidth || window.innerWidth || 1;
    setMobileTabViewportWidth(width);
    mobileTabTouchRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
      lastX: touch.clientX,
      lastY: touch.clientY,
      lastTime: Date.now(),
      width,
      dragging: false,
    };
    setIsMobileTabSettling(false);
    setIsMobileTabDragging(false);
    setMobileTabDragOffset(0);
  };
  const handleMobileTabTouchMove = (event) => {
    const start = mobileTabTouchRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start.lastX = touch.clientX;
    start.lastY = touch.clientY;
    start.lastTime = Date.now();
    if (!start.dragging) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.1) return;
      start.dragging = true;
      setIsMobileTabDragging(true);
    }
    if (event.cancelable) event.preventDefault();
    const edgeResistance = 0.28;
    const resistedDx = mobileTab === 'room'
      ? (dx < 0 ? dx : dx * edgeResistance)
      : (dx > 0 ? dx : dx * edgeResistance);
    const limit = Math.max(60, start.width);
    setMobileTabDragOffset(Math.max(-limit, Math.min(limit, resistedDx)));
  };
  const handleMobileTabTouchEnd = (event) => {
    const start = mobileTabTouchRef.current;
    mobileTabTouchRef.current = null;
    const touch = event.changedTouches[0];
    if (!start?.dragging) {
      setIsMobileTabDragging(false);
      setIsMobileTabSettling(false);
      setMobileTabDragOffset(0);
      return;
    }
    if (!start || !touch) {
      settleMobileTabSwipe(mobileTab);
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsedMs = Math.max(1, Date.now() - (start.time || Date.now()));
    const recentElapsedMs = Math.max(1, Date.now() - (start.lastTime || Date.now()));
    const totalVelocity = Math.abs(dx) / elapsedMs;
    const recentVelocity = Math.abs(touch.clientX - (start.lastX ?? touch.clientX)) / recentElapsedMs;
    const horizontalIntent = Math.abs(dx) > Math.abs(dy) * 1.1;
    const distanceCommit = Math.abs(dx) >= start.width * 0.5;
    const impulseCommit = Math.abs(dx) >= Math.max(44, start.width * 0.14) && (totalVelocity >= 0.42 || recentVelocity >= 0.55);
    const intentCommit = Math.abs(dx) >= Math.max(72, start.width * 0.22) && Math.abs(dx) > Math.abs(dy) * 1.6;
    if (!horizontalIntent || (!distanceCommit && !impulseCommit && !intentCommit)) {
      settleMobileTabSwipe(mobileTab);
      return;
    }
    const targetTab = dx < 0 ? 'chat' : 'room';
    if (targetTab !== mobileTab) {
      armMobileTabSwipeClickGuard(touch);
    }
    const targetOffset = targetTab === mobileTab
      ? 0
      : (targetTab === 'chat' ? -start.width : start.width);
    settleMobileTabSwipe(targetTab, targetOffset);
  };
  const handleMobileTabTouchCancel = () => {
    const start = mobileTabTouchRef.current;
    mobileTabTouchRef.current = null;
    if (start?.dragging) {
      settleMobileTabSwipe(mobileTab);
      return;
    }
    setIsMobileTabDragging(false);
    setIsMobileTabSettling(false);
    setMobileTabDragOffset(0);
  };
  const handleMobileTabClickCapture = (event) => {
    if (!mobileTabSwipePreventClickRef.current) return;
    const guard = mobileTabSwipeClickGuardRef.current;
    const isExpired = Date.now() > guard.expiresAt;
    const isSyntheticSwipeClick = !isExpired
      && Math.abs(event.clientX - guard.x) <= 28
      && Math.abs(event.clientY - guard.y) <= 28;
    clearMobileTabSwipeClickGuard();
    if (!isSyntheticSwipeClick) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const roomPanelClassName = 'flex flex-1 flex-col p-4 md:px-0 md:pt-8 md:pb-16 w-full';
  const desktopAsideClassName = `hidden md:flex transition-all duration-300 ease-out bg-white dark:bg-zinc-900 border-l border-slate-200/60 dark:border-zinc-800/60 flex-col shrink-0 z-20 shadow-[-4px_0_24px_rgb(0,0,0,0.02)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.05)] ${isChatOpen ? 'w-[400px] translate-x-0 opacity-100' : 'w-0 translate-x-full border-l-0 opacity-0 overflow-hidden'}`;
  const mobileTabTransform = gpuVideoRenderingEnabled
    ? `translate3d(calc(${mobileTab === 'chat' ? '-50%' : '0%'} + ${mobileTabDragOffset}px), 0, 0)`
    : `translateX(calc(${mobileTab === 'chat' ? '-50%' : '0%'} + ${mobileTabDragOffset}px))`;

  return (
    <div className="h-dvh md:h-screen bg-[#f4f6f8] dark:bg-[#09090b] text-slate-800 dark:text-zinc-100 font-sans overflow-hidden flex flex-col selection:bg-blue-100 dark:selection:bg-blue-500/30 transition-colors duration-300">
      {renderTopBar({
        room,
        user,
        isDark,
        syncStatus,
        copyState,
        onLeave: leaveRoom,
        onDismissRequest: openDismissConfirm,
        toggleTheme,
        copyRoomLink,
        isChatOpen,
        setIsChatOpen,
        topBarMenuOpen,
        setTopBarMenuOpen,
        onlineUsers,
        isCurrentUserHost,
        roomActionLoading,
        gpuVideoRenderingEnabled,
      })}

      <main className="flex-1 min-h-0 flex overflow-hidden relative">
        <section className="flex-1 min-h-0 overflow-hidden md:overflow-y-auto no-scrollbar scroll-smooth relative flex flex-col">
          <RoomPlayer
            playerShellRef={playerShellRef}
            primaryVideoRef={primaryVideoRef}
            secondaryVideoRef={secondaryVideoRef}
            primaryVideoSrc={primaryVideoSrc}
            secondaryVideoSrc={secondaryVideoSrc}
            activeVideoSlot={activeVideoSlot}
            currentTime={currentTime}
            duration={duration}
            progressPercent={progressPercent}
            speed={speed}
            volume={volume}
            isPlaying={isPlaying}
            displayIsPlaying={qualitySwitchPreservePlayState ?? isPlaying}
            isPlayerFullscreen={isPlayerFullscreen}
            isPlayerBuffering={isPlayerBuffering}
            gpuVideoRenderingEnabled={gpuVideoRenderingEnabled}
            playerChromeVisible={playerChromeVisible}
            playerBrightness={playerBrightness}
            transientFeedbacks={transientFeedbacks}
            continuousFeedback={continuousFeedback}
            topFeedback={topFeedback}
            danmakuLayer={danmakuLayer}
            showDanmaku={showDanmaku}
            isDanmakuAnimating={isDanmakuAnimating}
            showEmojiPanel={showEmojiPanel}
            playerQualityKey={playerQualityKey}
            availableQualityOptions={availableQualityOptions}
            playerMenuOpen={playerMenuOpen}
            togglePlay={() => runHostOnlyAction(togglePlay)}
            handleSpeedChange={(value) => runHostOnlyAction(() => handleSpeedChange(value))}
            handleQualityChange={handleQualityChange}
            toggleMute={toggleMute}
            handleFullscreen={handleFullscreen}
            handleDesktopPlayerSurfaceClick={(event) => runHostOnlyAction(() => handleDesktopPlayerSurfaceClick(event))}
            handleMobilePlayerSurfacePointerDown={handleMobilePlayerSurfacePointerDown}
            handleMobilePlayerSurfacePointerMove={handleMobilePlayerSurfacePointerMove}
            handleMobilePlayerSurfacePointerUp={handleMobilePlayerSurfacePointerUp}
            handleMobilePlayerSurfacePointerCancel={handleMobilePlayerSurfacePointerCancel}
            handleMobilePlayerChromePointerDown={handleMobilePlayerChromePointerDown}
            handleMobilePlayerChromePointerMove={handleMobilePlayerChromePointerMove}
            handleMobilePlayerChromePointerUp={handleMobilePlayerChromePointerUp}
            handleMobilePlayerChromePointerCancel={handleMobilePlayerChromePointerCancel}
            handlePlayerProgressInput={(event) => runHostOnlyAction(() => handlePlayerProgressInput(event))}
            scheduleProgressSeekChromeHide={scheduleProgressSeekChromeHide}
            handlePlayerVolumeInput={handlePlayerVolumeInput}
            handlePlayerBrightnessInput={handlePlayerBrightnessInput}
            keepPlayerChromeVisible={keepPlayerChromeVisible}
            revealPlayerChrome={revealPlayerChrome}
            handleDesktopPlayerShellActivity={handleDesktopPlayerShellActivity}
            handleDesktopPlayerShellMouseLeave={handleDesktopPlayerShellMouseLeave}
            handleDesktopPlayerShellBlur={handleDesktopPlayerShellBlur}
            handleDesktopPlayerControlMouseEnter={handleDesktopPlayerControlMouseEnter}
            handleDesktopPlayerControlMouseLeave={handleDesktopPlayerControlMouseLeave}
            setShowEmojiPanel={setShowEmojiPanel}
            setPlayerMenuOpen={setPlayerMenuOpen}
            handleDanmakuToggle={handleDanmakuToggle}
            danmakuInput={danmakuInput}
            setDanmakuInput={setDanmakuInput}
            sendDanmakuMessage={sendDanmakuMessage}
            hidePlayerChrome={hidePlayerChrome}
            canSendChat={canEditChat}
            canSubmitChat={canSubmitChat}
            qualitySwitchState={qualitySwitchState}
            qualitySwitchToastVisible={qualitySwitchToastVisible}
            handleVideoPlay={handleVideoPlay}
            handleVideoPause={handleVideoPause}
            handleVideoTimeUpdate={handleVideoTimeUpdate}
            handleVideoLoadedMetadata={handleVideoLoadedMetadata}
            handleVideoSeeked={handleVideoSeeked}
            handleVideoEnded={handleVideoEnded}
            handleVideoBufferStart={handleVideoBufferStart}
            handleVideoBufferEnd={handleVideoBufferEnd}
            handleVideoError={handleVideoError}
          />
          {roomActionError ? (
            <div className="absolute left-1/2 top-4 z-50 max-w-[min(92%,460px)] -translate-x-1/2 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-sm font-bold text-red-600 shadow-lg dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {roomActionError}
            </div>
          ) : null}

          <div
            className="flex flex-1 min-h-0 flex-col overflow-hidden touch-pan-y md:block md:flex-none md:overflow-visible"
            onTouchStart={handleMobileTabTouchStart}
            onTouchMove={handleMobileTabTouchMove}
            onTouchEnd={handleMobileTabTouchEnd}
            onTouchCancel={handleMobileTabTouchCancel}
            onClickCapture={handleMobileTabClickCapture}
          >
            <div className="md:hidden w-full bg-white dark:bg-zinc-900 border-b border-slate-200/70 dark:border-zinc-800/60 z-30">
              <div className="relative flex h-12 items-center">
                <button
                  type="button"
                  onClick={() => setMobileTab('room')}
                  className={`relative flex h-full flex-1 items-center justify-center text-[15px] font-bold transition-colors ${mobileTab === 'room' ? 'text-sky-500' : 'text-slate-500 dark:text-zinc-400'}`}
                >
                  {t('room.roomLabel')}
                </button>
                <button
                  type="button"
                  onClick={() => setMobileTab('chat')}
                  className={`relative flex h-full flex-1 items-center justify-center gap-1.5 text-[15px] font-bold transition-colors ${mobileTab === 'chat' ? 'text-sky-500' : 'text-slate-500 dark:text-zinc-400'}`}
                >
                  {t('room.info')}
                  <span className={`min-w-5 rounded-full px-1.5 py-0.5 text-[11px] leading-none ${mobileTab === 'chat' ? 'bg-sky-100 text-sky-500 dark:bg-sky-500/15' : 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>{chatCount}</span>
                </button>
                <span
                  className={`absolute bottom-0 h-0.5 w-7 -translate-x-1/2 rounded-full bg-sky-500 ${isMobileTabDragging ? '' : 'transition-[left] duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)]'}`}
                  style={{ left: `${25 + mobileTabProgress * 50}%` }}
                />
              </div>
            </div>

            <div className="hidden md:flex w-full max-w-[1120px] mx-auto">
              <div className={roomPanelClassName}>
                {renderRoomPanelConfigured({
                  room,
                  sourceTab,
                  setSourceTab,
                  showLinkInput,
                  setShowLinkInput,
                  sourceInput,
                  setSourceInput,
                  handleCastDirectSource,
                  cloudMediaItems,
                  cloudMediaStatus,
                  cloudMediaError,
                  selectedMediaId,
                  mountLibraryItem,
                  onlineUsers,
                  roomPanelSection,
                  setRoomPanelSection,
                  isCurrentUserHost,
                  removeRoomMember,
                  clearRoomMembers,
                  toggleInviteFriends,
                  sendRoomInvite,
                  onlineFriends,
                  inviteContactsLoading,
                  activityLogs: roomActivityLogs,
                })}
              </div>
            </div>

            <div className="md:hidden flex-1 min-h-0 w-full overflow-hidden">
              <div
                className={`flex h-full min-h-0 w-[200%] ${gpuVideoRenderingEnabled ? 'will-change-transform' : ''} ${isMobileTabDragging ? '' : 'transition-transform duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)]'} ${isMobileTabSettling ? 'pointer-events-none' : ''}`}
                style={{ transform: mobileTabTransform }}
              >
                <div className="w-1/2 min-h-0 shrink-0 overflow-y-auto no-scrollbar">
                  <div className={roomPanelClassName}>
                    {renderRoomPanelConfigured({
                      room,
                      sourceTab,
                      setSourceTab,
                      showLinkInput,
                      setShowLinkInput,
                      sourceInput,
                      setSourceInput,
                      handleCastDirectSource,
                      cloudMediaItems,
                      cloudMediaStatus,
                      cloudMediaError,
                      selectedMediaId,
                      mountLibraryItem,
                      onlineUsers,
                      roomPanelSection,
                      setRoomPanelSection,
                      isCurrentUserHost,
                      removeRoomMember,
                      clearRoomMembers,
                      toggleInviteFriends,
                      sendRoomInvite,
                      onlineFriends,
                      inviteContactsLoading,
                      activityLogs: roomActivityLogs,
                    })}
                  </div>
                </div>

                <div className="flex h-full min-h-0 w-1/2 shrink-0 flex-col bg-white dark:bg-zinc-900">
                  <ChatPanel
                    isMobile
                    messages={visibleChatMessages}
                    user={user}
                    roomNotice={room.notice}
                    canSendChat={canEditChat}
                    canSubmitChat={canSubmitChat}
                    chatInput={chatInput}
                    setChatInput={setChatInput}
                    sendMessage={sendMessage}
                    chatEndRef={chatEndRef}
                    onlineCount={onlineUsers.length}
                    isDark={isDark}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className={desktopAsideClassName}>
          <div className="w-[400px] h-full flex flex-col relative">
            <ChatPanel
              messages={visibleChatMessages}
              user={user}
              roomNotice={room.notice}
              canSendChat={canEditChat}
              canSubmitChat={canSubmitChat}
              chatInput={chatInput}
              setChatInput={setChatInput}
              sendMessage={sendMessage}
              chatEndRef={chatEndRef}
              onlineCount={onlineUsers.length}
              isDark={isDark}
            />
          </div>
        </aside>
      </main>
      {dismissConfirmOpen ? (
        <div className={`modal-overlay ${dismissConfirmClosing ? 'closing' : ''}`} onClick={closeDismissConfirm}>
          <div
            className={`auth-card modal-content modal-content--compact ${dismissConfirmClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none p-0 text-center sm:rounded-[24px]`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-sheet-handle" />
            <div className="modal-body">
              <div className="modal-icon-badge is-error">
                <div className="modal-icon-core">
                  <Trash2 className="modal-icon-glyph h-8 w-8" />
                </div>
              </div>
              <h3 className="modal-heading">{t('room.confirmDismissRoomTitle')}</h3>
              <p className="modal-copy">{t('room.confirmDismissRoomMessage', { id: room.id })}</p>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn modal-btn-secondary"
                onClick={closeDismissConfirm}
                disabled={roomActionLoading}
              >
                {t('lobby.roomSetupCancel')}
              </button>
              <button
                type="button"
                className="modal-btn modal-btn-danger disabled:opacity-60 disabled:cursor-not-allowed"
                onClick={dismissRoom}
                disabled={roomActionLoading}
              >
                {roomActionLoading ? t('auth.pleaseWait') : t('room.confirmDismissRoomAction')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function renderTopBar({
  room,
  user,
  isDark,
  syncStatus,
  copyState,
  onLeave,
  onDismissRequest,
  toggleTheme,
  copyRoomLink,
  isChatOpen,
  setIsChatOpen,
  topBarMenuOpen,
  setTopBarMenuOpen,
  onlineUsers,
  isCurrentUserHost,
  roomActionLoading,
  gpuVideoRenderingEnabled,
}) {
  const currentUserId = getMemberId(user, 'current-user');
  const currentUser = onlineUsers.find((member) => getMemberId(member, '') === currentUserId) || {
    id: currentUserId,
    name: user.name || user.email || t('room.memberFallbackName'),
    avatar: user.avatarUrl || user.avatar || '',
  };
  const currentUserInitial = String(currentUser?.name || user.name || '?').trim().slice(0, 1).toUpperCase();
  const syncConnected = syncStatus === 'connected';
  const syncDotClassName = syncConnected ? 'bg-emerald-400' : 'bg-rose-500';
  const syncTextClassName = syncConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const syncPillClassName = syncConnected
    ? 'border-emerald-100 bg-emerald-50 text-emerald-600 shadow-[0_3px_14px_rgba(16,185,129,0.14)] dark:border-emerald-500/15 dark:bg-emerald-500/10 dark:text-emerald-400'
    : 'border-rose-100 bg-rose-50 text-rose-600 shadow-[0_3px_14px_rgba(244,63,94,0.14)] dark:border-rose-500/15 dark:bg-rose-500/10 dark:text-rose-400';
  const syncLabel = syncConnected ? t('room.syncNormal') : t('room.syncAbnormal');
  const gpuMotionClassName = gpuVideoRenderingEnabled ? 'transform-gpu will-change-[transform,opacity]' : '';
  const roomCodeButton = (
    <button
      type="button"
      onClick={copyRoomLink}
      className="group flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-slate-800 shadow-[0_2px_10px_rgba(15,23,42,0.08)] transition active:scale-[0.98] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 md:h-10 md:px-4"
    >
      <span className="hidden text-[13px] font-semibold text-slate-500 dark:text-zinc-400 sm:inline">{t('room.roomLabel')}</span>
      <span className="text-[17px] font-black tracking-wider md:text-[15px] md:font-extrabold">{room.id}</span>
      <span className="text-slate-400 transition-colors group-hover:text-slate-600 dark:text-zinc-500 dark:group-hover:text-zinc-300">
        {copyState === 'success' ? <Check className="h-4 w-4 text-emerald-500 md:h-3.5 md:w-3.5" /> : <Copy className="h-4 w-4 md:h-3.5 md:w-3.5" />}
      </span>
    </button>
  );
  const avatar = (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100 shadow-sm dark:border-zinc-800 dark:bg-zinc-800 md:h-10 md:w-10">
      {currentUser?.avatar ? (
        <img src={currentUser.avatar} alt={currentUser.name || user.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[14px] font-bold text-slate-600 dark:text-zinc-300">{currentUserInitial}</div>
      )}
    </div>
  );
  const iconButtonClassName = 'flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-600 shadow-[0_2px_10px_rgba(15,23,42,0.08)] transition hover:text-slate-900 active:scale-95 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 md:h-10 md:w-10';
  const desktopIconButtonClassName = 'flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 active:scale-95 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';

  return (
    <header className="relative z-50 shrink-0 border-b border-slate-200 bg-[#f7f8fb] text-slate-800 transition-colors duration-300 dark:border-zinc-800 dark:bg-[#101114] dark:text-zinc-100">
      <div className="flex h-[52px] items-center justify-between px-2 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onLeave}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-600 transition active:scale-95 dark:text-zinc-300"
            aria-label={t('room.leave')}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          {roomCodeButton}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {avatar}
          <button
            type="button"
            onClick={() => setTopBarMenuOpen((prev) => !prev)}
            className={iconButtonClassName}
            aria-label="More"
            aria-expanded={topBarMenuOpen}
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        </div>

        <div
          className={`absolute right-2 top-[48px] w-[206px] origin-top-right overflow-hidden rounded-[16px] border border-slate-100 bg-white shadow-[0_12px_30px_rgba(15,23,42,0.14)] transition-all duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-900 ${gpuMotionClassName} ${topBarMenuOpen ? 'pointer-events-auto translate-y-0 scale-100 opacity-100' : 'pointer-events-none -translate-y-1 scale-95 opacity-0'}`}
          aria-hidden={!topBarMenuOpen}
        >
            <div className="flex h-12 w-full items-center gap-3 px-4 text-[15px] font-semibold">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${syncDotClassName}`} />
              <span className={syncTextClassName}>{syncLabel}</span>
            </div>
            <div className="mx-4 h-px bg-slate-100 dark:bg-zinc-800" />
            {isCurrentUserHost ? (
              <>
                <button
                  type="button"
                  className="flex h-12 w-full items-center gap-3 px-4 text-[15px] font-semibold text-red-600 transition hover:bg-red-50 active:bg-red-100 disabled:opacity-60 dark:text-red-300 dark:hover:bg-red-500/10"
                  onClick={() => {
                    setTopBarMenuOpen(false);
                    onDismissRequest?.();
                  }}
                  disabled={roomActionLoading}
                >
                  <Trash2 className="h-5 w-5" />
                  <span>{t('room.dismissRoom')}</span>
                </button>
              </>
            ) : null}
            <div className="mx-4 h-px bg-slate-100 dark:bg-zinc-800" />
            <button
              type="button"
              className="flex h-12 w-full items-center gap-3 px-4 text-[15px] font-semibold text-slate-700 transition hover:bg-slate-50 active:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onClick={() => {
                toggleTheme();
                setTopBarMenuOpen(false);
              }}
            >
              {isDark ? <Sun className="h-5 w-5 text-slate-500 dark:text-zinc-400" /> : <Moon className="h-5 w-5 text-slate-500 dark:text-zinc-400" />}
              <span>{isDark ? t('room.lightAppearance') : t('room.darkAppearance')}</span>
            </button>
          </div>
      </div>

      <div className="hidden h-[68px] items-center justify-between px-8 md:flex">
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={onLeave}
            disabled={roomActionLoading}
            className="group flex items-center gap-1.5 text-[14px] font-bold text-slate-500 transition hover:text-slate-900 active:scale-95 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <ChevronLeft className="h-5 w-5 transition-transform group-hover:-translate-x-0.5" />
            <span>{t('room.leave')}</span>
          </button>
          <div className="h-7 w-px bg-slate-200 dark:bg-zinc-800" />
          {roomCodeButton}
        </div>

        <div className="flex items-center gap-4">
          <button type="button" onClick={toggleTheme} className={desktopIconButtonClassName} aria-label={isDark ? 'Light mode' : 'Dark mode'}>
            {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <div className={`flex h-10 items-center gap-2 rounded-full border px-4 text-[14px] font-black ${syncPillClassName}`}>
            <span className={`h-2 w-2 rounded-full ${syncDotClassName}`} />
            {syncLabel}
          </div>
          {avatar}
          {isCurrentUserHost ? (
            <button
              type="button"
              onClick={onDismissRequest}
              disabled={roomActionLoading}
              className="flex h-10 items-center gap-2 rounded-full bg-red-50 px-4 text-[13px] font-black text-red-600 transition hover:bg-red-100 active:scale-95 disabled:opacity-60 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15"
              aria-label={t('room.dismissRoom')}
              title={t('room.dismissRoom')}
            >
              <Trash2 className="h-4 w-4" />
              <span>{t('room.dismissRoom')}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setIsChatOpen((prev) => !prev)}
            className={`flex h-10 w-10 items-center justify-center rounded-full transition active:scale-95 ${isChatOpen ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10' : 'bg-slate-100 text-slate-500 hover:text-slate-900 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'}`}
            aria-label="Toggle chat"
          >
            {isChatOpen ? <PanelRightClose className="h-5 w-5" /> : <PanelRightOpen className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </header>
  );
}


function renderRoomPanelConfigured({
  room,
  sourceTab,
  setSourceTab,
  showLinkInput,
  setShowLinkInput,
  sourceInput,
  setSourceInput,
  handleCastDirectSource,
  cloudMediaItems,
  cloudMediaStatus,
  cloudMediaError,
  selectedMediaId,
  mountLibraryItem,
  onlineUsers,
  roomPanelSection,
  setRoomPanelSection,
  isCurrentUserHost,
  removeRoomMember,
  clearRoomMembers,
  toggleInviteFriends,
  sendRoomInvite,
  onlineFriends,
  inviteContactsLoading,
  activityLogs,
}) {
  const roomTitle = String(room?.title || '').trim() || t('room.defaultRoomTitle');
  const hostMember = onlineUsers.find((member) => member.isHost) || null;
  const hostDisplayName = hostMember?.name || t('room.hostDisconnectedTitle');
  const membersExpanded = roomPanelSection === 'members';
  const friendsExpanded = roomPanelSection === 'friends';

  return (
    <>
      <div className="w-full max-w-[1120px] mx-auto grid grid-cols-1 gap-6 md:gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] items-start mt-2 md:mt-0">
        <div className="w-full min-w-0 flex flex-col gap-5">
          <div className="px-1">
            <h1 className="text-[20px] md:text-[22px] font-extrabold text-slate-800 dark:text-zinc-100 tracking-tight leading-snug">
              {roomTitle}
            </h1>
            <p className="text-[13px] md:text-[14px] font-medium text-slate-500 dark:text-zinc-400 mt-2">
              {t('room.realtimeSync')} · {t('room.onlineCount', { count: onlineUsers.length })}
            </p>
          </div>

          <div className="relative overflow-hidden rounded-[20px] border border-slate-100 bg-white p-5 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div className="relative shrink-0">
                  <div className="h-12 w-12 overflow-hidden rounded-full border border-slate-100 bg-indigo-50 dark:border-zinc-800 dark:bg-zinc-800">
                    {hostMember?.avatar ? (
                      <img src={hostMember.avatar} alt={hostDisplayName} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[16px] font-black text-slate-600 dark:text-zinc-300">
                        {String(hostDisplayName || '?').trim().slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>
                  {hostMember ? (
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                      {t('room.hostTag')}
                    </span>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="text-[18px] font-black leading-tight text-slate-800 dark:text-zinc-100">
                    {t('room.onlineCount', { count: onlineUsers.length })}
                  </div>
                  <div className="mt-1 truncate text-[14px] font-medium text-slate-500 dark:text-zinc-400">
                    {room.hostOnlyControl ? t('room.roomConfigHostOnlyControl') : t('room.roomConfigFreeControl')}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={toggleInviteFriends}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm shadow-emerald-200/70 transition-all duration-300 hover:scale-105 hover:bg-emerald-600 active:scale-95 dark:shadow-emerald-950/40 ${friendsExpanded ? 'rotate-45' : ''}`}
                aria-label={t('room.inviteFriend')}
                title={t('room.inviteFriend')}
              >
                <Plus className="h-5 w-5" strokeWidth={2.5} />
              </button>
            </div>

            <div className={`grid transition-[grid-template-rows,opacity,margin] duration-500 [transition-timing-function:cubic-bezier(0.25,1,0.5,1)] ${friendsExpanded ? 'mb-4 grid-rows-[1fr] opacity-100' : 'mb-0 grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                  <div className="mb-2 flex items-center gap-1.5 text-[12px] font-black text-emerald-600 dark:text-emerald-300">
                    <Users className="h-3.5 w-3.5" />
                    {t('room.inviteFriend')}
                  </div>
                  <div className="flex max-h-[160px] flex-col gap-1.5 overflow-y-auto pr-1 no-scrollbar">
                    {inviteContactsLoading ? (
                      <div className="rounded-lg bg-white/70 px-3 py-2 text-[12px] font-semibold text-emerald-600 dark:bg-zinc-900/60 dark:text-emerald-300">
                        {t('room.inviteFriendsLoading')}
                      </div>
                    ) : onlineFriends.length > 0 ? onlineFriends.map((friend) => (
                      <div key={friend.id} className="flex items-center justify-between rounded-lg border border-transparent p-2 transition hover:border-emerald-100 hover:bg-white dark:hover:border-emerald-500/20 dark:hover:bg-zinc-900/50">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full bg-slate-100 dark:bg-zinc-800">
                            {friend.avatarUrl ? (
                              <img src={friend.avatarUrl} alt={friend.name} className="h-full w-full object-cover" />
                            ) : (
                              <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${friend.bg || 'from-emerald-400 to-teal-500'} text-[12px] font-bold text-white`}>
                                {friend.initial || String(friend.name || '?').slice(0, 1).toUpperCase()}
                              </div>
                            )}
                            <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-zinc-900" />
                          </div>
                          <span className="truncate text-[13px] font-semibold text-slate-700 dark:text-zinc-200">{friend.name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => sendRoomInvite(friend)}
                          className="rounded-full bg-emerald-100 px-3 py-1 text-[12px] font-bold text-emerald-600 transition hover:bg-emerald-200 active:scale-95 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25"
                        >
                          {t('room.inviteFriendAction')}
                        </button>
                      </div>
                    )) : (
                      <div className="rounded-lg bg-white/70 px-3 py-3 text-center text-[12px] font-semibold text-slate-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                        {t('room.noOnlineFriends')}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setRoomPanelSection((prev) => (prev === 'members' ? 'none' : 'members'))}
              className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-bold transition-all active:scale-95 ${membersExpanded ? 'bg-slate-800 text-white shadow-md dark:bg-zinc-100 dark:text-zinc-950' : 'border border-slate-200/50 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:text-zinc-200 dark:hover:bg-zinc-700/80'}`}
              aria-expanded={membersExpanded}
            >
              <Users className="w-4 h-4" />
              {membersExpanded ? t('room.collapseMembers') : t('room.viewMembers')}
            </button>

            <div className={`grid transition-[grid-template-rows,opacity,margin] duration-500 [transition-timing-function:cubic-bezier(0.25,1,0.5,1)] ${membersExpanded ? 'mt-3 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto pr-2 no-scrollbar">
                    {onlineUsers.map((member) => (
                      <div key={member.id} className="group flex items-center justify-between rounded-xl p-2 transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800/70">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100 dark:border-zinc-700 dark:bg-zinc-800">
                            {member.avatar ? (
                              <img src={member.avatar} alt={member.name} className="h-full w-full object-cover" />
                          ) : (
                              <div className="flex h-full w-full items-center justify-center text-[12px] font-bold text-slate-600 dark:text-zinc-300">
                                {String(member.name || '?').trim().slice(0, 1).toUpperCase()}
                              </div>
                          )}
                          </div>
                          <div className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-slate-800 dark:text-zinc-100">
                              <span className="truncate">{member.name}</span>
                            {member.isHost ? (
                                <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">
                                {t('room.hostTag')}
                              </span>
                            ) : null}
                            </span>
                          </div>
                        </div>
                        {isCurrentUserHost && !member.isHost ? (
                          <button
                            type="button"
                            onClick={() => removeRoomMember(member.id)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-1.5 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 active:scale-95 dark:text-zinc-600 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                            aria-label={t('room.removeMember', { name: member.name })}
                          >
                            <MinusCircle className="h-[18px] w-[18px]" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                </div>
                {isCurrentUserHost && onlineUsers.length > 1 ? (
                  <div className="mt-2 border-t border-slate-100 pb-1 pt-3 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={clearRoomMembers}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-red-50 px-3 py-2 text-[13px] font-semibold text-red-500 transition hover:bg-red-100 active:scale-[0.99] dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15"
                  >
                      <Trash2 className="h-[15px] w-[15px]" />
                    {t('room.clearMembers')}
                  </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <RoomActivityLog logs={activityLogs} />
        </div>

        <div className="w-full min-w-0 flex flex-col">
          <div className="mb-3 flex flex-col gap-3 px-1 md:flex-row md:items-center md:justify-between">
            <h3 className="hidden text-[20px] font-extrabold leading-tight text-slate-800 dark:text-zinc-100 md:block md:text-[18px]">{t('room.tabCloudLibrary')}</h3>
            <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:items-center">
              <button
                onClick={() => { setShowLinkInput((prev) => !prev); setSourceTab('direct'); }}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-center text-[14px] font-bold leading-tight transition-all active:scale-95 md:min-h-0 md:rounded-xl md:py-1.5 md:text-[13px] ${sourceTab === 'direct' ? 'bg-indigo-500 text-white shadow-sm' : 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-500/20'}`}
              >
                <LinkIcon className="h-4 w-4 shrink-0 md:h-3.5 md:w-3.5" />
                <span>{t('room.tabDirectCast')}</span>
              </button>
              <button
                onClick={() => { setSourceTab('library'); setShowLinkInput(false); }}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-center text-[14px] font-bold leading-tight transition-all active:scale-95 md:min-h-0 md:rounded-xl md:py-1.5 md:text-[13px] ${sourceTab === 'library' ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20'}`}
              >
                <Cloud className="h-4 w-4 shrink-0 md:h-3.5 md:w-3.5" />
                <span>{t('room.tabCloudLibrary')}</span>
              </button>
            </div>
          </div>

          <div className={`overflow-hidden transition-all duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${showLinkInput ? 'max-h-[100px] opacity-100 mb-3' : 'max-h-0 opacity-0 mb-0'}`}>
            <div className="bg-white dark:bg-zinc-900 rounded-[16px] p-2 flex items-center gap-2 shadow-sm border border-indigo-100 dark:border-indigo-500/30">
              <div className="flex-1 min-w-0 flex items-center bg-slate-50 dark:bg-zinc-800/80 rounded-xl px-3 py-2 border border-transparent focus-within:border-indigo-300 focus-within:bg-white dark:focus-within:bg-zinc-900 transition-all">
                <input
                  type="text"
                  value={sourceInput}
                  onChange={(e) => setSourceInput(e.target.value)}
                  className="w-full bg-transparent outline-none text-[13px] font-medium text-slate-800 dark:text-zinc-100 placeholder-slate-400"
                  placeholder={t('room.directUrlPlaceholder')}
                />
              </div>
              <button
                onClick={handleCastDirectSource}
                className="h-[38px] px-4 bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-bold rounded-xl shadow-sm active:scale-95 transition-all whitespace-nowrap"
              >
                {t('room.cast')}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3 mt-1">
            {cloudMediaStatus === 'loading' ? (
              <div className="bg-white dark:bg-zinc-900 rounded-[20px] p-5 border border-slate-100 dark:border-zinc-800 text-[13px] font-semibold text-slate-500 dark:text-zinc-400">
                {t('room.cloudLibraryLoading')}
              </div>
            ) : null}

            {cloudMediaStatus === 'error' ? (
              <div className="bg-white dark:bg-zinc-900 rounded-[20px] p-5 border border-red-100 dark:border-red-500/30 text-[13px] font-semibold text-red-500 dark:text-red-400">
                {cloudMediaError || t('room.cloudLibraryLoadFailed')}
              </div>
            ) : null}

            {cloudMediaStatus === 'ready' && cloudMediaItems.length === 0 ? (
              <div className="bg-white dark:bg-zinc-900 rounded-[20px] p-5 border border-slate-100 dark:border-zinc-800 text-[13px] font-semibold text-slate-500 dark:text-zinc-400">
                {t('room.cloudLibraryEmpty')}
              </div>
            ) : null}

            {cloudMediaItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => mountLibraryItem(item)}
                disabled={!item.playable}
                className={`bg-white dark:bg-zinc-900 rounded-[20px] p-3 md:p-4 flex items-center gap-4 border transition-all text-left ${item.id === selectedMediaId ? 'border-blue-400 dark:border-blue-500/50 ring-2 ring-blue-100 dark:ring-blue-500/20 shadow-sm' : 'border-slate-100 dark:border-zinc-800 hover:border-slate-200 dark:hover:border-zinc-700'} ${item.playable ? 'active:scale-[0.995]' : 'opacity-70 cursor-not-allowed'}`}
              >
                <div className={`w-12 h-12 md:w-14 md:h-14 rounded-[14px] md:rounded-2xl flex items-center justify-center shrink-0 overflow-hidden ${item.id === selectedMediaId ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/20 dark:text-blue-400' : 'bg-slate-50/80 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500'}`}>
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <FileVideo className="w-5 h-5 md:w-6 md:h-6" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className={`text-[14px] md:text-[15px] font-bold truncate ${item.id === selectedMediaId ? 'text-blue-600 dark:text-blue-400' : 'text-slate-800 dark:text-zinc-100'}`}>
                    {item.title}
                  </h3>
                  <p className="text-[12px] md:text-[13px] font-medium text-slate-500 dark:text-zinc-500 mt-1">
                    {item.size} · {item.playable ? t('room.duration', { time: item.duration }) : t('room.mediaNotReady')}
                  </p>
                </div>

                <span className="w-10 h-10 md:w-11 md:h-11 rounded-full flex items-center justify-center shrink-0 transition-colors bg-slate-50/80 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500">
                  <Play className="w-4 h-4 md:w-5 md:h-5 fill-current ml-0.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}


