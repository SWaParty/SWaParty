import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Cloud,
  CloudUpload,
  Edit,
  Film,
  FileVideo,
  FolderPlus,
  HardDrive,
  Info,
  MonitorPlay,
  MoreVertical,
  Play,
  Plus,
  Settings2,
  Star,
  Trash2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LOCALE_CHANGED_EVENT, t } from '../../i18n';
import { MEDIA_CHANGED_EVENT } from '../../lib/realtimeMediaBus';
import { useFlipGridAnimation } from './useFlipGridAnimation';

const MODAL_CLOSE_MS = 340;
const DEFAULT_CONTENT_SPACING_PX = 16;
const EMPTY_INDICATOR_STYLE = { left: 0, width: 0, opacity: 0 };
const MEDIA_TASK_DONE_HOLD_MS = 1200;
const MEDIA_TASK_EXIT_MS = 280;
const MEDIA_ERROR_HOLD_MS = 2500;
const MEDIA_ERROR_EXIT_MS = 360;
const MEDIA_TASK_ACTIVE_POLL_MS = 3000;
const MEDIA_TASK_IDLE_POLL_MS = 3000;
const COMPACT_MODAL_CONTENT_CLASS = 'auth-card modal-content modal-content--compact w-full rounded-t-[32px] rounded-b-none sm:rounded-[28px]';
const UNIFIED_CATEGORY_MODAL_CONTENT_CLASS = 'auth-card modal-content modal-content--form w-full max-w-full rounded-t-[32px] rounded-b-none sm:rounded-[32px] overflow-hidden p-0 text-left flex flex-col relative';
const CARD_MENU_ITEM_CLASS = 'w-full px-3 py-2 text-left text-[14px] font-semibold text-slate-800 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-between';
const CARD_MENU_DANGER_ITEM_CLASS = 'w-full px-3 py-2 text-left text-[14px] font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center justify-between';
const CARD_MENU_ICON_CLASS = 'text-slate-400 dark:text-zinc-500';
const TAB_SCROLL_ARROW_BUTTON_CLASS = 'w-7 h-7 rounded-full bg-white dark:bg-zinc-800 border border-slate-200/80 dark:border-zinc-700/80 text-slate-700 dark:text-zinc-200 flex items-center justify-center shadow-[0_5px_14px_rgba(15,23,42,0.12)] dark:shadow-[0_6px_16px_rgba(0,0,0,0.38)] hover:bg-slate-50 dark:hover:bg-zinc-700 transition-[background-color,box-shadow,transform] active:scale-90';
function getCategoryPresetOptions() {
  const options = t('mediaPanel.categoryPresetOptions');
  if (!Array.isArray(options)) return [];
  return options.filter((item) => typeof item === 'string' && item.trim());
}

function toggleSetEntry(previousSet, value) {
  const next = new Set(previousSet);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function removeIdsFromSet(previousSet, ids) {
  const next = new Set(previousSet);
  ids.forEach((id) => next.delete(id));
  return next;
}

function parseMediaSizeToMb(sizeText) {
  const match = String(sizeText || '')
    .trim()
    .match(/^([\d.]+)\s*(KB|MB|GB|TB)$/i);
  if (!match) return 0;

  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(value) || value < 0) return 0;

  if (unit === 'KB') return value / 1024;
  if (unit === 'MB') return value;
  if (unit === 'GB') return value * 1024;
  if (unit === 'TB') return value * 1024 * 1024;
  return 0;
}

function formatMediaBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const mb = value / (1024 * 1024);
  if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatMediaDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return '00:00';
  const total = Math.floor(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatMediaDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString().split('T')[0];
  return new Date(value * 1000).toISOString().split('T')[0];
}

function isBrowserPlayableMime(mimeType) {
  return ['video/mp4', 'video/webm'].includes(String(mimeType || '').trim().toLowerCase().split(';')[0]);
}

function getExpectedRenditionJobs({ processingMode, sourceHeight }) {
  const height = Number(sourceHeight || 0);
  const jobs = [];
  if (!height || height >= 480) jobs.push('base_480p');
  if (processingMode === 'full_quality') {
    if (height >= 720) jobs.push('enhance_720p');
    if (height >= 1080) jobs.push('enhance_1080p');
  }
  return jobs;
}

function getMediaTaskExecutionProgress(task) {
  const progressByJob = task?.progressByJob || {};
  const probeProgress = Math.max(0, Math.min(100, Number(progressByJob.probe || 0)));
  const thumbnailProgress = Math.max(0, Math.min(100, Number(progressByJob.thumbnail || 0)));
  const preparationProgress = ((probeProgress + thumbnailProgress) / 2) * 0.1;

  const jobs = getExpectedRenditionJobs(task || {});
  if (!jobs.length) return preparationProgress;

  const renditionProgress = jobs.reduce((sum, jobType) => {
    const value = Math.max(0, Math.min(100, Number(progressByJob[jobType] || 0)));
    return sum + value;
  }, 0) / jobs.length;
  return Math.max(0, Math.min(100, preparationProgress + (renditionProgress * 0.9)));
}

function mapRemoteMediaItem(item) {
  return {
    id: String(item?.id || ''),
    title: String(item?.title || '').trim() || 'Untitled video',
    thumbnail: item?.thumbnailUrl || '',
    duration: formatMediaDuration(item?.durationSec),
    size: formatMediaBytes(item?.totalSizeBytes || item?.originalSizeBytes),
    date: formatMediaDate(item?.createdAt),
    category: String(item?.category || '').trim(),
    starred: Boolean(item?.starred),
    starredAt: item?.starredAt || null,
    playbackStatus: item?.playbackStatus || 'not_ready',
    transcodeStatus: item?.transcodeStatus || 'none',
    uploadStatus: item?.uploadStatus || 'uploaded',
    playbackUrl: item?.playbackUrl || '',
    processingMode: item?.processingMode || null,
    sourceHeight: item?.height || null,
    browserPlayable: Boolean(item?.browserPlayable),
    renditions: Array.isArray(item?.renditions) ? item.renditions : [],
  };
}

function mapTaskSnapshot(task) {
  if (!task?.mediaId) return null;
  return {
    mediaId: String(task.mediaId || '').trim(),
    title: String(task.title || '').trim() || 'Untitled video',
    phase: String(task.phase || 'processing').trim() || 'processing',
    uploadProgress: Math.max(0, Math.min(100, Number(task.uploadProgress ?? 100))),
    progressByJob: task?.progressByJob && typeof task.progressByJob === 'object' ? task.progressByJob : {},
    processingMode: task?.processingMode || null,
    sourceHeight: task?.sourceHeight || null,
    browserPlayable: Boolean(task?.browserPlayable),
    uploadPartsUploaded: Number(task?.uploadPartsUploaded || 0),
    uploadPartsTotal: Number(task?.uploadPartsTotal || 0),
    uploadedPartNumbers: Array.isArray(task?.uploadedPartNumbers) ? task.uploadedPartNumbers : [],
    uploadBytesReceived: Number(task?.uploadBytesReceived || 0),
    uploadBytesTotal: Number(task?.uploadBytesTotal || 0),
    uploadSessionStatus: task?.uploadSessionStatus || null,
    uploadUpdatedAt: task?.uploadUpdatedAt || null,
  };
}

function getMediaQualityOptions(video) {
  const sourceHeight = Math.max(0, Number(video?.sourceHeight || 0));
  const renditions = Array.isArray(video?.renditions) ? video.renditions : [];
  const byHeight = new Map(renditions.map((rendition) => [Number(rendition.height || 0), rendition]));
  const options = [];

  if (sourceHeight > 0 && video?.browserPlayable) {
    options.push({
      key: 'original',
      label: t('mediaPanel.qualityOriginal', { quality: `${sourceHeight}p` }),
      status: 'ready',
      canRequest: false,
    });
  }

  [480, 720, 1080].forEach((height) => {
    if (sourceHeight > 0 && sourceHeight < height) return;
    const rendition = byHeight.get(height);
    const status = rendition?.status || 'missing';
    options.push({
      key: `rendition-${height}`,
      height,
      label: `${height}p`,
      status,
      canRequest: status !== 'ready' && status !== 'queued' && status !== 'processing',
    });
  });

  return options;
}

function readVideoMetadata(file) {
  return new Promise((resolve) => {
    if (!(file instanceof File)) {
      resolve({ durationSec: null, width: null, height: null });
      return;
    }

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    };
    const finish = (metadata) => {
      cleanup();
      resolve(metadata);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      finish({
        durationSec: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };
    video.onerror = () => finish({ durationSec: null, width: null, height: null });
    video.src = url;
  });
}

function uploadMediaPartWithProgress({
  url,
  method = 'PUT',
  headers = {},
  blob,
  onProgress,
  withCredentials = false,
  expectJson = false,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = withCredentials;
    Object.entries(headers || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) xhr.setRequestHeader(key, String(value));
    });
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!expectJson) {
          resolve({
            ok: true,
            etag: xhr.getResponseHeader('etag') || xhr.getResponseHeader('ETag') || '',
          });
          return;
        }
        const payload = (() => {
          try {
            return xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch {
            return {};
          }
        })();
        if (payload?.ok) {
          resolve(payload);
          return;
        }
        reject(new Error(payload?.error || 'media_upload_failed'));
        return;
      }
      const responseText = String(xhr.responseText || '').slice(0, 500);
      const codeMatch = responseText.match(/<Code>([^<]+)<\/Code>/i);
      const r2Code = codeMatch?.[1] ? `_${codeMatch[1]}` : '';
      reject(new Error(`media_upload_failed_${xhr.status || 'network'}${r2Code}`));
    };
    xhr.onerror = () => reject(new Error('media_upload_failed_network'));
    xhr.onabort = () => reject(new Error('media_upload_aborted'));
    xhr.send(blob);
  });
}

async function uploadMediaMultipartFileWithProgress({
  file,
  upload,
  uploadedPartNumbers = [],
  onProgress,
}) {
  const partSizeBytes = Math.max(1, Number(upload?.partSizeBytes || 0));
  const partsTotal = Math.max(1, Number(upload?.partsTotal || 0));
  const maxConcurrency = Math.max(1, Number(upload?.maxConcurrency || 1));
  const confirmPartUrlTemplate = String(upload?.confirmPartUrlTemplate || '');
  const signedPartUrls = upload?.signedPartUrls && typeof upload.signedPartUrls === 'object'
    ? upload.signedPartUrls
    : null;

  if (!partSizeBytes || !partsTotal || !confirmPartUrlTemplate || !signedPartUrls) {
    throw new Error('media_upload_init_failed');
  }

  const loadedByPart = new Map();
  const uploadedPartSet = new Set(
    (uploadedPartNumbers || [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  for (let partNumber = 1; partNumber <= partsTotal; partNumber += 1) {
    if (!uploadedPartSet.has(partNumber)) continue;
    const start = (partNumber - 1) * partSizeBytes;
    const end = Math.min(file.size, start + partSizeBytes);
    loadedByPart.set(partNumber, Math.max(0, end - start));
  }
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    const totalLoaded = Array.from(loadedByPart.values()).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    onProgress(Math.round((Math.min(totalLoaded, file.size) / Math.max(file.size, 1)) * 100));
  };

  let nextPartNumber = 1;

  const uploadSinglePart = async (partNumber, attempt = 0) => {
    const start = (partNumber - 1) * partSizeBytes;
    const end = Math.min(file.size, start + partSizeBytes);
    const blob = file.slice(start, end);
    loadedByPart.set(partNumber, 0);
    reportProgress();

    try {
      const uploadResult = await uploadMediaPartWithProgress({
        url: String(signedPartUrls[String(partNumber)] || ''),
        method: 'PUT',
        blob,
        withCredentials: false,
        expectJson: false,
        onProgress: (progress) => {
          loadedByPart.set(partNumber, Math.round((progress / 100) * blob.size));
          reportProgress();
        },
      });
      const etag = String(uploadResult?.etag || '').trim();
      if (!etag) {
        throw new Error('media_upload_missing_etag_cors');
      }
      const confirmResp = await fetch(confirmPartUrlTemplate.replace('{partNumber}', String(partNumber)), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          etag,
          sizeBytes: blob.size,
        }),
      });
      const confirmPayload = await confirmResp.json().catch(() => ({}));
      if (!confirmResp.ok || !confirmPayload?.ok) {
        throw new Error(confirmPayload?.error || 'media_upload_failed');
      }
      loadedByPart.set(partNumber, blob.size);
      reportProgress();
    } catch (error) {
      if (attempt < 2) {
        loadedByPart.set(partNumber, 0);
        reportProgress();
        await uploadSinglePart(partNumber, attempt + 1);
        return;
      }
      throw error;
    }
  };

  const worker = async () => {
    while (nextPartNumber <= partsTotal) {
      const partNumber = nextPartNumber;
      nextPartNumber += 1;
      if (uploadedPartSet.has(partNumber)) continue;
      await uploadSinglePart(partNumber);
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, partsTotal) }, () => worker()));
}

function getProcessingQualities(mode, metadata) {
  const height = Math.max(0, Math.floor(Number(metadata?.height || 0)));
  if (mode !== 'full_quality') {
    return height > 0 && height < 480 ? `${height}p` : '480p';
  }

  const qualities = [];
  qualities.push(height > 0 && height < 480 ? `${height}p` : '480p');
  if (height >= 720) qualities.push('720p');
  if (height >= 1080) qualities.push('1080p');
  return qualities.join(' / ');
}

function getOriginalResolution(metadata) {
  const height = Math.max(0, Math.floor(Number(metadata?.height || 0)));
  return height > 0 ? `${height}p` : '-';
}

function getMobileBottomTabHeight() {
  const mobileBottomTab = document.querySelector('[data-mobile-bottom-tab="true"]');
  const tabRect = mobileBottomTab?.getBoundingClientRect();
  return tabRect && tabRect.width > 0 && tabRect.height > 0 ? tabRect.height : 0;
}

function getMediaUploadErrorMessage(error) {
  const message = String(error?.message || '');
  if (message === 'active_media_task_exists') {
    return t('mediaPanel.uploadErrorActiveTaskExists');
  }
  return t('mediaPanel.uploadErrorGeneric');
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

const MediaCard = memo(function MediaCard({
  video,
  isSelectMode,
  isSelected,
  isDeleting,
  isDropdownOpen,
  onCardClick,
  onToggleDropdown,
  onToggleStar,
  onOpenRenameEditor,
  onInitiateDelete,
  onRequestRendition,
}) {
  const [menuPanel, setMenuPanel] = useState('actions');
  const qualityOptions = useMemo(() => getMediaQualityOptions(video), [video]);

  return (
    <article
      data-id={video.id}
      onClick={() => onCardClick(video.id)}
      className={`group relative self-start z-0 rounded-[20px] overflow-visible bg-white dark:bg-zinc-900 border transition-[border-color,box-shadow,opacity,transform] duration-300 isolation-isolate ${isSelectMode ? 'cursor-pointer hover:shadow-[0_6px_18px_rgb(0,0,0,0.045)] dark:hover:shadow-[0_8px_22px_rgb(0,0,0,0.22)]' : 'hover:shadow-[0_6px_18px_rgb(0,0,0,0.055)] dark:hover:shadow-[0_8px_22px_rgb(0,0,0,0.28)]'} ${isSelected
        ? 'border-blue-500 ring-2 ring-blue-500 ring-offset-2 ring-offset-[#F8FAFC] dark:ring-offset-zinc-950 scale-[0.98]'
        : 'border-slate-100 dark:border-zinc-800'
        } ${isDropdownOpen ? 'z-[50]' : ''} ${isDeleting ? 'scale-[0.8] opacity-0 pointer-events-none' : 'scale-100 opacity-100'}`}
    >
      <div
        className="relative overflow-hidden rounded-t-[20px] bg-slate-100 dark:bg-zinc-800"
        style={{ aspectRatio: '16 / 9' }}
      >
        {video.thumbnail ? (
          <img
            src={video.thumbnail}
            alt={video.title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500">
            <Film size={34} strokeWidth={1.8} />
          </div>
        )}
        {!isSelectMode && video.starred ? (
          <div className="absolute top-3 right-3 z-10 bg-white/90 dark:bg-zinc-900/90 p-1.5 rounded-full shadow-sm">
            <Star size={16} className="text-orange-500 fill-orange-500" />
          </div>
        ) : null}
        {isSelectMode ? (
          <div className="absolute top-3 left-3 z-10 transition-transform duration-200">
            {isSelected ? (
              <div className="bg-white rounded-full">
                <CheckCircle2 size={26} className="text-blue-600" strokeWidth={2.5} />
              </div>
            ) : (
              <Circle size={26} className="text-white opacity-90" strokeWidth={2} />
            )}
          </div>
        ) : null}
        <span className="absolute bottom-2.5 right-2.5 bg-black/70 text-white text-[11px] font-bold px-2 py-1 rounded-md tracking-wide border border-white/10">{video.duration}</span>
      </div>

      <div
        className="relative flex flex-col"
        style={{
          paddingLeft: '14px',
          paddingRight: '14px',
          paddingTop: '12px',
          paddingBottom: '10px',
          minHeight: '96px',
        }}
      >
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <h3 className={`text-[16px] font-bold tracking-tight text-slate-800 dark:text-zinc-100 line-clamp-1 pr-4 transition-colors ${!isSelectMode ? 'cursor-pointer hover:text-blue-600 dark:hover:text-blue-400' : ''}`}>{video.title}</h3>
          {!isSelectMode ? (
            <div className="relative z-30">
              <button
                type="button"
                onClick={(event) => {
                  setMenuPanel('actions');
                  onToggleDropdown(video.id, event);
                }}
                className={`p-1.5 -mr-1.5 -mt-1.5 rounded-full transition-all active:scale-90 ${isDropdownOpen
                  ? 'bg-slate-200 dark:bg-zinc-700 text-slate-900 dark:text-zinc-100'
                  : 'text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-zinc-100'
                  }`}
              >
                <MoreVertical size={18} strokeWidth={2.5} />
              </button>
              <div
                className={`absolute right-0 bottom-[calc(100%+8px)] w-[210px] h-[200px] rounded-[16px] border border-slate-200/90 dark:border-zinc-700/90 bg-white dark:bg-zinc-900 shadow-[0_12px_34px_rgba(15,23,42,0.14)] dark:shadow-[0_12px_34px_rgba(0,0,0,0.42)] origin-bottom-right transition-all duration-200 overflow-hidden ${isDropdownOpen ? 'opacity-100 scale-100 pointer-events-auto translate-y-0' : 'opacity-0 scale-95 pointer-events-none translate-y-2'}`}
              >
                <div className={`h-full grid grid-rows-4 transition-all duration-200 ${menuPanel === 'actions' ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-4 absolute inset-x-0 top-0 pointer-events-none'}`}>
                  <button
                    type="button"
                    onClick={(event) => onToggleStar(video.id, event)}
                    className={CARD_MENU_ITEM_CLASS}
                  >
                    <span>{video.starred ? t('mediaPanel.unstarVideo') : t('mediaPanel.starVideo')}</span>
                    <Star size={16} className={video.starred ? 'text-orange-500 fill-orange-500' : CARD_MENU_ICON_CLASS} />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuPanel('quality');
                    }}
                    className={CARD_MENU_ITEM_CLASS}
                  >
                    <span>{t('mediaPanel.qualityMenu')}</span>
                    <MonitorPlay size={16} className={CARD_MENU_ICON_CLASS} />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => onOpenRenameEditor(video, event)}
                    className={CARD_MENU_ITEM_CLASS}
                  >
                    <span>{t('mediaPanel.renameVideo')}</span>
                    <Edit size={16} className={CARD_MENU_ICON_CLASS} />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => onInitiateDelete(video.id, event)}
                    className={CARD_MENU_DANGER_ITEM_CLASS}
                  >
                    <span>{t('lobby.deleteVideo')}</span>
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className={`h-full flex flex-col transition-all duration-200 ${menuPanel === 'quality' ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4 absolute inset-0 pointer-events-none'}`}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuPanel('actions');
                    }}
                    className="w-full h-10 px-3 text-left text-[13px] font-bold text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    <ChevronLeft size={15} />
                    <span>{t('mediaPanel.qualityMenu')}</span>
                  </button>
                  <div className="mx-3 h-px bg-slate-100 dark:bg-zinc-800 shrink-0" />
                  {qualityOptions.length > 0 ? (
                    <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar py-1">
                      {qualityOptions.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          disabled={!option.canRequest}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (option.canRequest) onRequestRendition(video, option.height, event);
                          }}
                          className={`w-full h-9 px-3 text-left text-[14px] font-semibold transition-colors flex items-center justify-between ${option.canRequest ? 'text-slate-800 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800' : 'text-slate-400 dark:text-zinc-500 cursor-default'}`}
                        >
                          <span>{option.label}</span>
                          <span className={`text-[11px] font-bold ${option.status === 'ready' ? 'text-emerald-500' : (option.status === 'queued' || option.status === 'processing' ? 'text-blue-500' : 'text-slate-400 dark:text-zinc-500')}`}>
                            {option.status === 'ready'
                              ? t('mediaPanel.qualityReady')
                              : (option.status === 'queued' || option.status === 'processing' ? t('mediaPanel.qualityProcessing') : t('mediaPanel.qualityGenerate'))}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 px-3 text-[13px] font-semibold text-slate-400 dark:text-zinc-500 flex items-center justify-center">
                      {t('mediaPanel.qualityUnavailable')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3.5 text-[12px] mb-2 font-semibold text-slate-500 dark:text-zinc-400">
          <span className="flex items-center gap-1.5"><HardDrive size={14} strokeWidth={2.5} /> {video.size}</span>
          <span className="flex items-center gap-1.5"><CalendarDays size={14} strokeWidth={2.5} /> {video.date}</span>
        </div>

        <div className="flex min-h-[24px] flex-wrap content-start gap-1.5 mt-1.5">
          {video.category ? (
            <span className="px-2 py-0.5 rounded-[6px] text-[11px] font-bold bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200/50 dark:border-zinc-700/50">
              {video.category}
            </span>
          ) : null}
          {video.playbackStatus && video.playbackStatus !== 'mp4_ready' ? (
            <span className="px-2 py-0.5 rounded-[6px] text-[11px] font-bold bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-300 border border-amber-100 dark:border-amber-500/20">
              {video.uploadStatus === 'uploading' ? t('media.processing') : video.playbackStatus}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}, (prev, next) => {
  return prev.video === next.video
    && prev.isSelectMode === next.isSelectMode
    && prev.isSelected === next.isSelected
    && prev.isDeleting === next.isDeleting
    && prev.isDropdownOpen === next.isDropdownOpen
    && prev.onCardClick === next.onCardClick
    && prev.onToggleDropdown === next.onToggleDropdown
    && prev.onToggleStar === next.onToggleStar
    && prev.onOpenRenameEditor === next.onOpenRenameEditor
    && prev.onInitiateDelete === next.onInitiateDelete
    && prev.onRequestRendition === next.onRequestRendition;
});

const EmptyMediaState = memo(function EmptyMediaState({ minHeight }) {
  return (
    <div
      className="sm:col-span-2 lg:col-span-3 flex flex-col items-center justify-center text-slate-500 dark:text-zinc-500"
      style={{ minHeight: `${minHeight}px` }}
    >
      <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-slate-100 dark:bg-zinc-800 mb-3 sm:mb-4 flex items-center justify-center">
        <Film size={26} />
      </div>
      <p className="text-[15px] font-medium text-center">{t('mediaPanel.noVideosInCategory')}</p>
    </div>
  );
});

const MediaLibraryPanel = memo(function MediaLibraryPanel() {
  const tabsRef = useRef(null);
  const manageCategoryPickerRef = useRef(null);
  const uploadInputRef = useRef(null);
  const mediaListRequestRef = useRef(0);
  const uploadIntentRef = useRef('new');
  const mediaTaskRef = useRef(null);
  const mediaTaskExitTimerRef = useRef(null);

  const [mediaList, setMediaList] = useState([]);
  const [isMediaLoading, setIsMediaLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [mediaErrorText, setMediaErrorText] = useState('');
  const [isMediaErrorVisible, setIsMediaErrorVisible] = useState(false);
  const [mediaTask, setMediaTask] = useState(null);
  const [isMediaTaskVisible, setIsMediaTaskVisible] = useState(false);
  const [categoryItems, setCategoryItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState('__ALL__');
  const [tabDirection, setTabDirection] = useState('right');
  const [isTabContentAnimating, setIsTabContentAnimating] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showManageCategoryModal, setShowManageCategoryModal] = useState(false);
  const [isManageCategoryClosing, setIsManageCategoryClosing] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [draftCategories, setDraftCategories] = useState([]);
  const [showCategoryPresetPanel, setShowCategoryPresetPanel] = useState(false);
  const [showMoveActionSheet, setShowMoveActionSheet] = useState(false);
  const [isMoveActionSheetClosing, setIsMoveActionSheetClosing] = useState(false);
  const [deletingIds, setDeletingIds] = useState(new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState([]);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [isDeleteConfirmClosing, setIsDeleteConfirmClosing] = useState(false);
  const [pendingUploadFile, setPendingUploadFile] = useState(null);
  const [pendingUploadMetadata, setPendingUploadMetadata] = useState(null);
  const [selectedUploadProcessingMode, setSelectedUploadProcessingMode] = useState('fast_playable');
  const [showUploadProcessingModal, setShowUploadProcessingModal] = useState(false);
  const [isUploadProcessingClosing, setIsUploadProcessingClosing] = useState(false);
  const [renamingItem, setRenamingItem] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenameClosing, setIsRenameClosing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [indicatorStyle, setIndicatorStyle] = useState(EMPTY_INDICATOR_STYLE);
  const [contentBottomPaddingPx, setContentBottomPaddingPx] = useState(0);
  const [emptyStateHeightPx, setEmptyStateHeightPx] = useState(320);
  const [localeVersion, setLocaleVersion] = useState(0);
  const gridRef = useRef(null);
  const categoryPresetOptions = getCategoryPresetOptions();
  const allTabs = useMemo(() => ['__ALL__', '__STARRED__', ...categories], [categories]);

  const mediaUsedText = useMemo(() => {
    const totalMb = mediaList.reduce((sum, item) => sum + parseMediaSizeToMb(item.size), 0);
    const totalGb = totalMb / 1024;
    return totalGb >= 1 ? `${totalGb.toFixed(2)} GB` : `${Math.round(totalMb)} MB`;
  }, [mediaList]);

  const filteredMediaList = useMemo(() => {
    return mediaList.filter((item) => {
    if (activeCategory === '__ALL__') return true;
    if (activeCategory === '__STARRED__') return Boolean(item.starred);
    return item.category === activeCategory;
    });
  }, [activeCategory, mediaList]);

  const mediaTaskProgress = useMemo(() => {
    if (!mediaTask) return 0;
    if (mediaTask.phase === 'uploading') {
      const uploadProgress = Math.max(0, Math.min(100, Number(mediaTask.uploadProgress || 0)));
      return uploadProgress;
    }
    if (mediaTask.phase === 'processing') {
      return getMediaTaskExecutionProgress(mediaTask);
    }
    if (mediaTask.phase === 'done') return 100;
    return 0;
  }, [mediaTask]);

  const mediaTaskLabel = (() => {
    if (!mediaTask) return '';
    if (mediaTask.phase === 'uploading') {
      return t('mediaPanel.uploadStageUploading');
    }
    if (mediaTask.phase === 'processing') return t('mediaPanel.uploadStageProcessing');
    if (mediaTask.phase === 'done') return t('mediaPanel.uploadStageDone');
    if (mediaTask.phase === 'failed') return t('mediaPanel.uploadStageFailed');
    return '';
  })();
  const mediaTaskStatusText = mediaTask?.phase === 'uploading' || mediaTask?.phase === 'processing'
    ? `${Math.round(mediaTaskProgress)}%`
    : '';
  const hasMediaTask = Boolean(mediaTask);
  const hasMediaError = Boolean(mediaErrorText);
  const isUploadLocked = isUploading || (hasMediaTask && mediaTask?.phase !== 'failed');
  const canResumeUpload = Boolean(
    mediaTask
    && mediaTask.phase === 'uploading'
    && mediaTask.uploadStatus === 'uploading'
    && mediaTask.uploadSessionStatus === 'uploading'
    && !isUploading
    && mediaTask.mediaId
    && mediaTask.uploadBytesTotal > 0,
  );

  const closeWithAnimation = useCallback((setClosing, onCloseDone) => {
    setClosing(true);
    window.setTimeout(() => {
      onCloseDone();
      setClosing(false);
    }, MODAL_CLOSE_MS);
  }, []);

  const resetSelectionState = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  useEffect(() => {
    mediaTaskRef.current = mediaTask;
  }, [mediaTask]);

  useEffect(() => {
    return () => {
      if (mediaTaskExitTimerRef.current) {
        window.clearTimeout(mediaTaskExitTimerRef.current);
      }
    };
  }, []);

  const cancelMediaTaskExit = useCallback(() => {
    if (!mediaTaskExitTimerRef.current) return;
    window.clearTimeout(mediaTaskExitTimerRef.current);
    mediaTaskExitTimerRef.current = null;
  }, []);

  const closeMediaTaskWithAnimation = useCallback((mediaId, phase = null) => {
    cancelMediaTaskExit();
    setIsMediaTaskVisible(false);
    mediaTaskExitTimerRef.current = window.setTimeout(() => {
      setMediaTask((prev) => {
        if (!prev) return null;
        if (mediaId && prev.mediaId !== mediaId) return prev;
        if (phase && prev.phase !== phase) return prev;
        return null;
      });
      mediaTaskExitTimerRef.current = null;
    }, MEDIA_TASK_EXIT_MS);
  }, [cancelMediaTaskExit]);

  const loadMediaList = useCallback(async () => {
    const requestId = mediaListRequestRef.current + 1;
    mediaListRequestRef.current = requestId;
    setMediaErrorText('');
    try {
      const resp = await fetch('/api/media?limit=200', { credentials: 'include' });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok || !Array.isArray(payload.items)) {
        throw new Error(payload?.error || 'media_load_failed');
      }
      if (requestId !== mediaListRequestRef.current) return;
      setMediaList(payload.items.map(mapRemoteMediaItem).filter((item) => item.id));
    } catch {
      if (requestId !== mediaListRequestRef.current) return;
      setMediaErrorText('Media library failed to load.');
    } finally {
      if (requestId === mediaListRequestRef.current) {
        setIsMediaLoading(false);
      }
    }
  }, []);

  const loadActiveMediaTask = useCallback(async () => {
    try {
      const resp = await fetch('/api/media/task', { credentials: 'include' });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) return;

      const nextTask = mapTaskSnapshot(payload.task);
      if (!nextTask) {
        const currentTask = mediaTaskRef.current;
        if (currentTask && currentTask.phase !== 'uploading') {
          closeMediaTaskWithAnimation(currentTask.mediaId);
        }
        return;
      }
      cancelMediaTaskExit();
      setMediaTask((prev) => {
        if (prev?.mediaId === nextTask.mediaId && prev.phase === 'uploading' && isUploading) return prev;
        return {
          ...(prev || {}),
          ...nextTask,
        };
      });
    } catch {
      // Ignore recovery failures; live events and list polling still update the UI.
    }
  }, [cancelMediaTaskExit, closeMediaTaskWithAnimation, isUploading]);

  const loadMediaCategories = useCallback(async () => {
    setMediaErrorText('');
    try {
      const resp = await fetch('/api/media/categories', { credentials: 'include' });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok || !Array.isArray(payload.items)) {
        throw new Error(payload?.error || 'media_categories_load_failed');
      }
      const items = payload.items
        .map((item) => ({
          id: String(item?.id || ''),
          name: String(item?.name || '').trim(),
        }))
        .filter((item) => item.id && item.name);
      setCategoryItems(items);
      setCategories(items.map((item) => item.name));
    } catch {
      setMediaErrorText('Media categories failed to load.');
    }
  }, []);

  const handleUpload = () => {
    if (isUploadLocked) return;
    uploadIntentRef.current = 'new';
    uploadInputRef.current?.click();
  };

  const loadUploadSession = useCallback(async (mediaId) => {
    const resp = await fetch(`/api/media/uploads/${encodeURIComponent(mediaId)}/session`, { credentials: 'include' });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload?.ok || !payload?.session) {
      throw new Error(payload?.error || 'media_upload_session_failed');
    }
    return payload.session;
  }, []);

  const resumeUploadSelectedFile = useCallback(async ({ file, task }) => {
    if (!task?.mediaId) throw new Error('media_upload_session_failed');
    const uploadSession = await loadUploadSession(task.mediaId);
    const expectedSize = Math.max(0, Number(uploadSession.bytesTotal || task.uploadBytesTotal || 0));
    if (!expectedSize || file.size !== expectedSize) {
      throw new Error('resume_file_mismatch');
    }

    setIsUploading(true);
    setMediaErrorText('');
    setMediaTask((prev) => (prev ? {
      ...prev,
      title: file.name,
      mediaId: task.mediaId,
      phase: 'uploading',
      uploadProgress: Math.max(0, Math.min(100, Number(uploadSession.progressPercent || task.uploadProgress || 0))),
      uploadPartsUploaded: Number(uploadSession.partsUploaded || 0),
      uploadPartsTotal: Number(uploadSession.partsTotal || 0),
      uploadedPartNumbers: Array.isArray(uploadSession.uploadedPartNumbers) ? uploadSession.uploadedPartNumbers : [],
      uploadBytesReceived: Number(uploadSession.bytesUploaded || 0),
      uploadBytesTotal: expectedSize,
      uploadSessionStatus: uploadSession.status || 'uploading',
      uploadUpdatedAt: uploadSession.updatedAt || null,
    } : prev));

    try {
      await uploadMediaMultipartFileWithProgress({
        file,
        upload: {
          partSizeBytes: uploadSession.partSizeBytes,
          partsTotal: uploadSession.partsTotal,
          maxConcurrency: 4,
          confirmPartUrlTemplate: uploadSession.confirmPartUrlTemplate || `/api/media/uploads/${encodeURIComponent(task.mediaId)}/parts/{partNumber}`,
          signedPartUrls: uploadSession.signedPartUrls || {},
        },
        uploadedPartNumbers: uploadSession.uploadedPartNumbers,
        onProgress: (progress) => {
          setMediaTask((prev) => (prev ? { ...prev, uploadProgress: progress, phase: 'uploading' } : prev));
        },
      });

      setMediaTask((prev) => (prev ? { ...prev, phase: 'processing', uploadProgress: 100 } : prev));
      const completeResp = await fetch('/api/media/uploads/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaId: task.mediaId,
          mimeType: file.type || 'application/octet-stream',
          width: null,
          height: null,
          durationSec: null,
          processingMode: task.processingMode || 'fast_playable',
        }),
      });
      const completePayload = await completeResp.json().catch(() => ({}));
      if (!completeResp.ok || !completePayload?.ok) {
        throw new Error(completePayload?.error || 'media_upload_complete_failed');
      }

      await loadMediaList();
    } finally {
      setIsUploading(false);
    }
  }, [loadMediaList, loadUploadSession]);

  const uploadSelectedFile = async ({ file, metadata, processingMode }) => {
    let initializedMediaId = '';
    setIsUploading(true);
    setMediaErrorText('');
    setMediaTask({
      mediaId: '',
      title: file.name,
      phase: 'uploading',
      uploadProgress: 0,
      progressByJob: {},
      processingMode,
      sourceHeight: metadata.height,
      browserPlayable: isBrowserPlayableMime(file.type),
    });
    try {
      const category = activeCategory === '__ALL__' || activeCategory === '__STARRED__' ? '' : activeCategory;
      const initResp = await fetch('/api/media/uploads/init', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          title: file.name,
          category,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          durationSec: metadata.durationSec,
          width: metadata.width,
          height: metadata.height,
          processingMode,
        }),
      });
      const initPayload = await initResp.json().catch(() => ({}));
      if (!initResp.ok || !initPayload?.ok || !initPayload?.mediaId || !initPayload?.upload?.signedPartUrls) {
        throw new Error(initPayload?.error || 'media_upload_init_failed');
      }
      initializedMediaId = initPayload.mediaId;
      setMediaTask((prev) => ({
        ...(prev || {}),
        mediaId: initPayload.mediaId,
        title: file.name,
        phase: 'uploading',
      }));

      await uploadMediaMultipartFileWithProgress({
        file,
        upload: initPayload.upload,
        uploadedPartNumbers: [],
        onProgress: (progress) => {
          setMediaTask((prev) => (prev ? { ...prev, uploadProgress: progress, phase: 'uploading' } : prev));
        },
      });
      setMediaTask((prev) => (prev ? { ...prev, phase: 'processing', uploadProgress: 100 } : prev));

      const completeResp = await fetch('/api/media/uploads/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaId: initPayload.mediaId,
          mimeType: file.type || 'application/octet-stream',
          width: metadata.width,
          height: metadata.height,
          durationSec: metadata.durationSec,
          processingMode,
        }),
      });
      const completePayload = await completeResp.json().catch(() => ({}));
      if (!completeResp.ok || !completePayload?.ok) {
        throw new Error(completePayload?.error || 'media_upload_complete_failed');
      }

      await loadMediaList();
    } catch (err) {
      if (initializedMediaId) {
        await fetch(`/api/media/${encodeURIComponent(initializedMediaId)}`, {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => {});
      }
      setMediaTask((prev) => (prev ? {
        ...prev,
        phase: 'failed',
        uploadProgress: 0,
      } : null));
      setMediaErrorText(getMediaUploadErrorMessage(err));
      loadMediaList();
    } finally {
      setIsUploading(false);
    }
  };

  const closeUploadProcessingModal = () => {
    if (!showUploadProcessingModal || isUploadProcessingClosing) return;
    closeWithAnimation(setIsUploadProcessingClosing, () => {
      setShowUploadProcessingModal(false);
      setPendingUploadFile(null);
      setPendingUploadMetadata(null);
      setSelectedUploadProcessingMode('fast_playable');
    });
  };

  const handleUploadFileChange = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    const uploadIntent = uploadIntentRef.current;
    uploadIntentRef.current = 'new';
    if (!file) return;
    if (uploadIntent === 'resume') {
      const task = mediaTask;
      if (!task?.mediaId || task.phase !== 'uploading') return;
      try {
        await resumeUploadSelectedFile({ file, task });
      } catch (error) {
        if (String(error?.message || '') === 'resume_file_mismatch') {
          setMediaErrorText(t('mediaPanel.uploadResumeFileMismatch'));
        } else {
          setMediaErrorText(t('mediaPanel.uploadResumeFailed'));
        }
      }
      return;
    }
    if (isUploadLocked) return;

    setMediaErrorText('');
    const metadata = await readVideoMetadata(file);
    setPendingUploadFile(file);
    setPendingUploadMetadata(metadata);
    setSelectedUploadProcessingMode('fast_playable');
    setIsUploadProcessingClosing(false);
    setShowUploadProcessingModal(true);
  };

  const confirmUploadProcessing = async () => {
    if (!pendingUploadFile || !pendingUploadMetadata || isUploadLocked) return;
    const file = pendingUploadFile;
    const metadata = pendingUploadMetadata;
    const processingMode = selectedUploadProcessingMode;
    closeUploadProcessingModal();
    await uploadSelectedFile({ file, metadata, processingMode });
  };

  const handleResumeUpload = () => {
    if (!canResumeUpload) return;
    uploadIntentRef.current = 'resume';
    uploadInputRef.current?.click();
  };

  const closeDeleteConfirmModal = () => {
    if (!showDeleteConfirmModal || isDeleteConfirmClosing) return;
    closeWithAnimation(setIsDeleteConfirmClosing, () => {
      setShowDeleteConfirmModal(false);
      setPendingDeleteIds([]);
    });
  };

  const initiateDelete = useCallback((ids, event) => {
    if (event) event.stopPropagation();
    const nextIds = Array.isArray(ids) ? ids : [ids];
    if (nextIds.length === 0) return;
    setPendingDeleteIds(nextIds);
    setIsDeleteConfirmClosing(false);
    setShowDeleteConfirmModal(true);
    setActiveDropdown(null);
  }, []);

  const executeDelete = async () => {
    if (pendingDeleteIds.length === 0) {
      closeDeleteConfirmModal();
      return;
    }
    const idsToRemove = [...pendingDeleteIds];
    const idsToRemoveSet = new Set(idsToRemove);
    const removedItems = mediaList
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => idsToRemoveSet.has(item.id));
    closeDeleteConfirmModal();

    setDeletingIds((prev) => {
      const next = new Set(prev);
      idsToRemove.forEach((id) => next.add(id));
      return next;
    });
    setMediaList((prev) => prev.filter((item) => !idsToRemoveSet.has(item.id)));
    setSelectedIds((prev) => removeIdsFromSet(prev, idsToRemove));
    if (isSelectMode) resetSelectionState();

    try {
      await Promise.all(idsToRemove.map(async (id) => {
        const resp = await fetch(`/api/media/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'include',
          keepalive: true,
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok || !payload?.ok) {
          throw new Error(payload?.error || 'media_delete_failed');
        }
      }));
    } catch {
      setMediaList((prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        const next = [...prev];
        removedItems.forEach(({ item, index }) => {
          if (existingIds.has(item.id)) return;
          next.splice(Math.min(index, next.length), 0, item);
          existingIds.add(item.id);
        });
        return next;
      });
      setMediaErrorText('Media delete failed.');
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        idsToRemove.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  const toggleDropdown = useCallback((id, event) => {
    event.stopPropagation();
    setActiveDropdown((prev) => (prev === id ? null : id));
  }, []);

  const handleToggleStar = useCallback(async (id, event) => {
    if (event) event.stopPropagation();
    const item = mediaList.find((entry) => entry.id === id);
    if (!item) return;

    try {
      const resp = await fetch(`/api/media/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ starred: !item.starred }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) {
        throw new Error(payload?.error || 'media_star_failed');
      }
      await loadMediaList();
    } catch {
      setMediaErrorText('Media star update failed.');
    } finally {
      setActiveDropdown(null);
    }
  }, [loadMediaList, mediaList]);

  const handleRequestRendition = useCallback(async (item, height, event) => {
    event?.stopPropagation();
    if (!item?.id || !height) return;

    try {
      const resp = await fetch(`/api/media/${encodeURIComponent(item.id)}/renditions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ height }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) {
        throw new Error(payload?.error || 'media_rendition_failed');
      }

      setActiveDropdown(null);
      setMediaList((prev) => prev.map((media) => {
        if (media.id !== item.id) return media;
        const renditions = Array.isArray(media.renditions) ? media.renditions : [];
        const nextRendition = {
          height: Number(height),
          label: `${height}p`,
          status: payload.status || 'queued',
          sizeBytes: 0,
          playlistUrl: null,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        const exists = renditions.some((rendition) => Number(rendition.height || 0) === Number(height));
        return {
          ...media,
          processingMode: 'full_quality',
          transcodeStatus: payload.status === 'ready' ? media.transcodeStatus : 'queued',
          renditions: exists
            ? renditions.map((rendition) => (Number(rendition.height || 0) === Number(height) ? { ...rendition, ...nextRendition } : rendition))
            : [...renditions, nextRendition],
        };
      }));
      loadMediaList();
    } catch (error) {
      console.error(error);
      setMediaErrorText('Media rendition request failed.');
    }
  }, [loadMediaList]);

  const openRenameEditor = useCallback((item, event) => {
    event.stopPropagation();
    setRenamingItem(item);
    setRenameValue(item.title || '');
    setIsRenameClosing(false);
    setActiveDropdown(null);
  }, []);

  const closeRenameEditor = () => {
    if (!renamingItem || isRenameClosing) return;
    closeWithAnimation(setIsRenameClosing, () => {
      setRenamingItem(null);
      setRenameValue('');
    });
  };

  const saveRenameAndClose = async () => {
    const nextTitle = String(renameValue || '').trim();
    if (!renamingItem || !nextTitle) {
      closeRenameEditor();
      return;
    }
    try {
      const resp = await fetch(`/api/media/${encodeURIComponent(renamingItem.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: nextTitle }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) {
        throw new Error(payload?.error || 'media_rename_failed');
      }
      await loadMediaList();
      closeRenameEditor();
    } catch {
      setMediaErrorText('Media rename failed.');
    }
  };

  const handleCardClick = useCallback((id) => {
    if (!isSelectMode) return;
    setSelectedIds((prev) => toggleSetEntry(prev, id));
  }, [isSelectMode]);

  const toggleSelectMode = () => {
    setIsSelectMode((prev) => !prev);
    setSelectedIds(new Set());
    setActiveDropdown(null);
  };

  const handleCreateCategory = () => {
    const nextName = newCategoryName.trim();
    if (!nextName || draftCategories.includes(nextName)) return;
    setDraftCategories((prev) => [...prev, nextName]);
    setNewCategoryName('');
    setShowCategoryPresetPanel(false);
  };

  const handlePickPresetCategory = (categoryName) => {
    setNewCategoryName(categoryName);
    setShowCategoryPresetPanel(false);
  };

  const handleDeleteCategory = (catToDelete) => {
    setDraftCategories((prev) => prev.filter((cat) => cat !== catToDelete));
  };

  const handleMoveToCategory = async (targetCategory) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setMediaErrorText('');
    try {
      const resp = await fetch('/api/media/bulk/category', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaIds: ids, category: targetCategory }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) throw new Error(payload?.error || 'media_category_move_failed');

      await loadMediaList();
      setShowMoveActionSheet(false);
      setIsMoveActionSheetClosing(false);
      resetSelectionState();
    } catch (err) {
      setMediaErrorText(String(err?.message || 'Failed to move media items.'));
    }
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    initiateDelete(Array.from(selectedIds));
  };

  const checkScroll = () => {
    if (!tabsRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = tabsRef.current;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(Math.ceil(scrollLeft + clientWidth) < scrollWidth);
  };

  const updateIndicator = useCallback(() => {
    if (!tabsRef.current) return;
    const activeEl = tabsRef.current.querySelector('button[aria-selected="true"]');
    if (!activeEl) return;
    setIndicatorStyle({
      left: activeEl.offsetLeft,
      width: activeEl.offsetWidth,
      opacity: 1,
    });
  }, []);

  useLayoutEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      checkScroll();
      updateIndicator();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [activeCategory, categories.length, localeVersion, updateIndicator]);

  useLayoutEffect(() => {
    if (!tabsRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const activeEl = tabsRef.current.querySelector('button[aria-selected="true"]');
    if (!activeEl) return undefined;

    const resizeObserver = new ResizeObserver(() => {
      updateIndicator();
      checkScroll();
    });
    resizeObserver.observe(activeEl);
    resizeObserver.observe(tabsRef.current);
    return () => resizeObserver.disconnect();
  }, [activeCategory, categories.length, localeVersion, updateIndicator]);

  const scrollTabs = (direction) => {
    if (!tabsRef.current) return;
    const distance = direction === 'left' ? -220 : 220;
    tabsRef.current.scrollBy({ left: distance, behavior: 'smooth' });
  };

  const resetFlipHistory = useFlipGridAnimation(gridRef, filteredMediaList);

  const handleCategoryChange = useCallback((nextCategory) => {
    if (nextCategory === activeCategory) return;
    const fromIndex = allTabs.indexOf(activeCategory);
    const toIndex = allTabs.indexOf(nextCategory);
    setTabDirection(toIndex > fromIndex ? 'right' : 'left');
    setIsTabContentAnimating(true);
    setActiveCategory(nextCategory);
    resetFlipHistory();
  }, [activeCategory, allTabs, resetFlipHistory]);

  const getTabLabel = useCallback((category) => {
    if (category === '__ALL__') return t('mediaPanel.tabAll');
    if (category === '__STARRED__') return t('mediaPanel.tabStarred');
    return category;
  }, []);

  const isTabActive = useCallback((category) => activeCategory === category, [activeCategory]);
  const activeTabLabel = getTabLabel(activeCategory);

  const openMoveActionSheet = () => {
    if (selectedIds.size === 0) return;
    setIsMoveActionSheetClosing(false);
    setShowMoveActionSheet(true);
  };

  const closeMoveActionSheet = () => {
    if (!showMoveActionSheet || isMoveActionSheetClosing) return;
    closeWithAnimation(setIsMoveActionSheetClosing, () => {
      setShowMoveActionSheet(false);
    });
  };

  const openManageCategoryModal = () => {
    setIsManageCategoryClosing(false);
    setShowCategoryPresetPanel(false);
    setDraftCategories([...categories]);
    setShowManageCategoryModal(true);
  };

  const closeManageCategoryModal = () => {
    if (!showManageCategoryModal || isManageCategoryClosing) return;
    closeWithAnimation(setIsManageCategoryClosing, () => {
      setShowManageCategoryModal(false);
      setShowCategoryPresetPanel(false);
      setDraftCategories([]);
      setNewCategoryName('');
    });
  };

  const handleSaveCategoryChanges = async () => {
    const nextCategories = [...draftCategories];
    const removedCategories = categories.filter((cat) => !nextCategories.includes(cat));
    const addedCategories = nextCategories.filter((cat) => !categories.includes(cat));

    setMediaErrorText('');
    try {
      for (const name of addedCategories) {
        const resp = await fetch('/api/media/categories', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok || !payload?.ok) throw new Error(payload?.error || 'media_category_create_failed');
      }

      for (const name of removedCategories) {
        const item = categoryItems.find((category) => category.name === name);
        if (!item?.id) continue;
        const resp = await fetch(`/api/media/categories/${encodeURIComponent(item.id)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok || !payload?.ok) throw new Error(payload?.error || 'media_category_delete_failed');
      }

      await loadMediaCategories();
      await loadMediaList();
      if (removedCategories.length > 0) {
        if (removedCategories.includes(activeCategory)) {
          setActiveCategory('__ALL__');
        }
      }

      closeManageCategoryModal();
    } catch (err) {
      setMediaErrorText(String(err?.message || 'Failed to save categories.'));
    }
  };

  useEffect(() => {
    loadMediaList();
  }, [loadMediaList]);

  useEffect(() => {
    const handleMediaChanged = (event) => {
      const eventType = String(event?.detail?.type || '').trim();
      const payload = event?.detail?.payload || {};
      if (eventType === 'media.updated' && payload?.mediaId && payload.mediaId === mediaTask?.mediaId) {
        const jobType = String(payload.jobType || '').trim();
        const transcodeProgress = Number(payload.transcodeProgress);
        if (Number.isFinite(transcodeProgress)) {
          setMediaTask((prev) => (prev ? {
            ...prev,
            phase: 'processing',
            progressByJob: {
              ...(prev.progressByJob || {}),
              [jobType]: Math.max(
                Number(prev.progressByJob?.[jobType] || 0),
                Math.max(0, Math.min(100, transcodeProgress)),
              ),
            },
          } : prev));
        }
        if (payload?.reason === 'job_done') {
          setMediaTask((prev) => {
            if (!prev || !getExpectedRenditionJobs(prev).includes(jobType)) return prev;
            return {
              ...prev,
              phase: 'processing',
              progressByJob: {
                ...(prev.progressByJob || {}),
                [jobType]: 100,
              },
            };
          });
        }
        if (jobType === 'probe') {
          setMediaTask((prev) => (prev ? { ...prev, phase: 'processing' } : prev));
        }
      }
      if (eventType === 'media.categories.updated') {
        loadMediaCategories();
      }
      loadMediaList();
    };
    window.addEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
    return () => window.removeEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
  }, [loadMediaCategories, loadMediaList, mediaTask?.mediaId]);

  useEffect(() => {
    loadMediaCategories();
  }, [loadMediaCategories]);

  useEffect(() => {
    loadActiveMediaTask();
  }, [loadActiveMediaTask]);

  useEffect(() => {
    if (!hasMediaError) {
      setIsMediaErrorVisible(false);
      return undefined;
    }

    setIsMediaErrorVisible(false);
    let clearTimerId;
    const frameId = window.requestAnimationFrame(() => {
      setIsMediaErrorVisible(true);
    });
    const hideTimerId = window.setTimeout(() => {
      setIsMediaErrorVisible(false);
      clearTimerId = window.setTimeout(() => {
        setMediaErrorText((prev) => (prev ? '' : prev));
      }, MEDIA_ERROR_EXIT_MS);
    }, MEDIA_ERROR_HOLD_MS);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(hideTimerId);
      if (clearTimerId) window.clearTimeout(clearTimerId);
    };
  }, [hasMediaError, mediaErrorText]);

  useEffect(() => {
    if (!hasMediaTask) {
      setIsMediaTaskVisible(false);
      return undefined;
    }

    setIsMediaTaskVisible(false);
    const frameId = window.requestAnimationFrame(() => {
      setIsMediaTaskVisible(true);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [hasMediaTask]);

  useEffect(() => {
    if (!mediaTask?.mediaId || mediaTask.phase === 'done') return undefined;
    const item = mediaList.find((entry) => entry.id === mediaTask.mediaId);
    if (!item?.thumbnail || item.transcodeStatus !== 'ready') return undefined;

    setMediaTask((prev) => (prev ? { ...prev, phase: 'done' } : prev));
    return undefined;
  }, [mediaList, mediaTask?.mediaId, mediaTask?.phase]);

  useEffect(() => {
    if (!mediaTask?.mediaId || mediaTask.phase !== 'done') return undefined;
    const mediaId = mediaTask.mediaId;
    const timerId = window.setTimeout(() => {
      closeMediaTaskWithAnimation(mediaId, 'done');
    }, MEDIA_TASK_DONE_HOLD_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [closeMediaTaskWithAnimation, mediaTask?.mediaId, mediaTask?.phase]);

  useEffect(() => {
    if (mediaTask?.phase !== 'failed') return undefined;
    const mediaId = mediaTask.mediaId;
    const timerId = window.setTimeout(() => {
      closeMediaTaskWithAnimation(mediaId, 'failed');
    }, MEDIA_ERROR_HOLD_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [closeMediaTaskWithAnimation, mediaTask?.mediaId, mediaTask?.phase]);

  useEffect(() => {
    let intervalId;
    let cancelled = false;

    const runPolling = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      await loadActiveMediaTask();
      if (mediaTask?.mediaId) {
        loadMediaList();
      }
    };

    runPolling();
    intervalId = window.setInterval(
      runPolling,
      mediaTask?.mediaId || isUploading ? MEDIA_TASK_ACTIVE_POLL_MS : MEDIA_TASK_IDLE_POLL_MS,
    );

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isUploading, loadActiveMediaTask, loadMediaList, mediaTask?.mediaId]);

  useEffect(() => {
    if (!activeDropdown) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setActiveDropdown(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDropdown]);

  useEffect(() => {
    if (activeDropdown === null) return undefined;
    const handleGlobalClick = () => setActiveDropdown(null);
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  }, [activeDropdown]);

  useEffect(() => {
    if (!showCategoryPresetPanel) return undefined;
    const handlePointerDown = (event) => {
      if (manageCategoryPickerRef.current?.contains(event.target)) return;
      setShowCategoryPresetPanel(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [showCategoryPresetPanel]);

  const measureContentSpacing = useCallback(() => {
    if (!gridRef.current) return;

    const spacing = DEFAULT_CONTENT_SPACING_PX;
    const gridStyle = window.getComputedStyle(gridRef.current);
    const columns = gridStyle.gridTemplateColumns
      .split(' ')
      .filter((value) => value.trim() && value.trim() !== 'none').length || 1;
    const columnGap = Number.parseFloat(gridStyle.columnGap) || 0;
    const columnWidth = Math.max(0, (gridRef.current.clientWidth - columnGap * (columns - 1)) / columns);
    const cardHeight = Math.round((columnWidth * 9) / 16 + 96);
    setEmptyStateHeightPx(Math.max(220, Math.round(cardHeight + spacing)));
    setContentBottomPaddingPx(getMobileBottomTabHeight() + spacing);
  }, []);

  const syncLayoutMetrics = useCallback(() => {
    checkScroll();
    updateIndicator();
    measureContentSpacing();
  }, [measureContentSpacing, updateIndicator]);

  useLayoutEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      measureContentSpacing();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [filteredMediaList, measureContentSpacing]);

  useEffect(() => {
    syncLayoutMetrics();
    window.addEventListener('resize', syncLayoutMetrics);
    return () => window.removeEventListener('resize', syncLayoutMetrics);
  }, [syncLayoutMetrics]);

  useEffect(() => {
    let rafId1 = null;
    let rafId2 = null;
    const onLocaleChange = () => {
      setLocaleVersion((prev) => prev + 1);
      rafId1 = window.requestAnimationFrame(() => {
        rafId2 = window.requestAnimationFrame(() => {
          checkScroll();
          updateIndicator();
        });
      });
    };
    window.addEventListener(LOCALE_CHANGED_EVENT, onLocaleChange);
    return () => {
      window.removeEventListener(LOCALE_CHANGED_EVENT, onLocaleChange);
      if (rafId1 !== null) window.cancelAnimationFrame(rafId1);
      if (rafId2 !== null) window.cancelAnimationFrame(rafId2);
    };
  }, [updateIndicator]);

  const mediaCardNodes = useMemo(() => {
    return filteredMediaList.map((video) => {
      return (
        <MediaCard
          key={video.id}
          video={video}
          isSelectMode={isSelectMode}
          isSelected={selectedIds.has(video.id)}
          isDeleting={deletingIds.has(video.id)}
          isDropdownOpen={activeDropdown === video.id}
          onCardClick={handleCardClick}
          onToggleDropdown={toggleDropdown}
          onToggleStar={handleToggleStar}
          onOpenRenameEditor={openRenameEditor}
          onInitiateDelete={initiateDelete}
          onRequestRendition={handleRequestRendition}
        />
      );
    });
  }, [
    activeDropdown,
    deletingIds,
    filteredMediaList,
    handleCardClick,
    handleToggleStar,
    handleRequestRendition,
    initiateDelete,
    isSelectMode,
    openRenameEditor,
    selectedIds,
    toggleDropdown,
  ]);

  return (
    <section className="pt-2 sm:pt-3 relative">
      <div className="shrink-0 rounded-[2rem] border border-slate-100 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900 shadow-[0_10px_30px_rgb(0,0,0,0.045)] px-4 py-4 sm:px-6">
        <header className="relative h-[64px] sm:h-[66px]">
          <div className="absolute inset-0 flex items-center justify-between">
            <div className="relative flex items-center h-full min-w-0">
              <div className={`absolute left-0 flex items-center gap-3 min-w-0 transition-all duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] ${isSelectMode ? 'opacity-0 -translate-y-4 pointer-events-none' : 'opacity-100 translate-y-0 pointer-events-auto'}`}>
                <div className="w-[48px] h-[48px] rounded-[16px] bg-slate-100 dark:bg-zinc-800 text-blue-600 dark:text-blue-400 flex items-center justify-center border border-slate-200/90 dark:border-zinc-700 shadow-[0_6px_18px_rgba(15,23,42,0.08)] shrink-0">
                  <Cloud size={28} strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                  <h2 className="hidden sm:block text-xl sm:text-2xl font-bold leading-tight tracking-tight text-slate-900 dark:text-zinc-100 truncate">{t('lobby.cloudLibraryTitle')}</h2>
                  <p className="text-[12px] text-slate-500 dark:text-zinc-400 sm:mt-0.5 whitespace-nowrap">
                    {t('media.summary', { count: mediaList.length, used: mediaUsedText })}
                  </p>
                </div>
              </div>
              <div className={`absolute left-0 flex items-center gap-3 min-w-0 transition-all duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] ${!isSelectMode ? 'opacity-0 translate-y-4 pointer-events-none' : 'opacity-100 translate-y-0 pointer-events-auto'}`}>
                <div className="w-[48px] h-[48px] rounded-[16px] bg-blue-50 dark:bg-blue-500/20 text-blue-500 dark:text-blue-300 flex items-center justify-center border border-blue-100 dark:border-blue-500/30 shadow-sm shrink-0">
                  <CheckCircle2 size={26} />
                </div>
                <div className="min-w-0">
                  <h2 className="hidden sm:block text-xl sm:text-2xl font-bold leading-tight tracking-tight text-slate-900 dark:text-zinc-100 truncate">{t('mediaPanel.multiSelectTitle')}</h2>
                  <p className="text-[12px] text-blue-500 dark:text-blue-300 sm:mt-0.5 whitespace-nowrap">{t('mediaPanel.selectedCount', { count: selectedIds.size })}</p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end h-full">
              <button
                type="button"
                onClick={toggleSelectMode}
                className={`relative h-[40px] ${isSelectMode ? 'w-[44px] sm:w-[72px]' : 'w-[72px]'} rounded-[12px] font-semibold text-[14px] transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] shadow-sm active:scale-[0.96] inline-flex items-center justify-center overflow-hidden shrink-0 z-10 ${isSelectMode
                  ? 'bg-slate-800 dark:bg-zinc-100 text-white dark:text-zinc-900 border border-transparent'
                  : 'bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
                  }`}
              >
                <span className={`absolute transition-all duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] ${isSelectMode ? 'opacity-0 -translate-y-4 scale-90' : 'opacity-100 translate-y-0 scale-100'}`}>{t('mediaPanel.select')}</span>
                <span className={`absolute inline-flex items-center justify-center transition-all duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] ${!isSelectMode ? 'opacity-0 translate-y-4 scale-90' : 'opacity-100 translate-y-0 scale-100'}`}>
                  <CheckCircle2 size={18} className="sm:hidden" strokeWidth={2.5} />
                  <span className="hidden sm:inline">{t('mediaPanel.done')}</span>
                </span>
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleUploadFileChange}
              />
              <div className={`overflow-hidden transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] flex items-center ${isSelectMode ? 'max-w-0 opacity-0 ml-0' : 'max-w-[220px] opacity-100 ml-2 sm:ml-3'}`}>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={isUploadLocked}
                  className="hidden sm:inline-flex items-center justify-center gap-2 px-3.5 h-[40px] rounded-[12px] font-semibold text-[14px] bg-blue-600 hover:bg-blue-700 text-white shadow-[0_2px_10px_rgba(37,99,235,0.2)] transition-colors active:scale-[0.98] whitespace-nowrap shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <CloudUpload className="w-5 h-5 shrink-0" strokeWidth={2.4} />
                  <span>{t('lobby.uploadVideo')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={isUploadLocked}
                  className="sm:hidden inline-flex w-[40px] h-[40px] rounded-[12px] bg-blue-600 hover:bg-blue-700 text-white items-center justify-center shadow-[0_2px_10px_rgba(37,99,235,0.2)] transition-colors active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
                  aria-label={t('lobby.uploadVideo')}
                  title={t('lobby.uploadVideo')}
                >
                  <CloudUpload className="w-[18px] h-[18px] shrink-0" strokeWidth={2.4} />
                </button>
              </div>
              <div className={`overflow-hidden transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] flex items-center gap-2 sm:gap-3 ${!isSelectMode ? 'max-w-0 opacity-0 ml-0' : 'max-w-[96px] sm:max-w-[240px] opacity-100 ml-2 sm:ml-3'}`}>
                <button type="button" onClick={openMoveActionSheet} disabled={selectedIds.size === 0} className={`px-0 sm:px-3 h-[40px] w-[44px] sm:w-[94px] rounded-[12px] text-[14px] font-bold flex items-center justify-center gap-1.5 transition-all border shadow-sm whitespace-nowrap ${selectedIds.size > 0 ? 'bg-white dark:bg-zinc-900 text-blue-600 dark:text-blue-400 border-slate-200/80 dark:border-zinc-700 hover:bg-blue-50 dark:hover:bg-zinc-700 active:scale-[0.98]' : 'bg-transparent text-slate-400 dark:text-zinc-600 cursor-not-allowed border-slate-200/50 dark:border-zinc-800'}`}>
                  <FolderPlus size={18} className="sm:w-[15px] sm:h-[15px]" />
                  <span className="hidden sm:inline">{t('mediaPanel.moveToCategoryCta')}</span>
                </button>
                <button type="button" onClick={handleBulkDelete} disabled={selectedIds.size === 0} className={`px-0 sm:px-3 h-[40px] w-[44px] sm:w-[94px] rounded-[12px] text-[14px] font-bold flex items-center justify-center gap-1.5 transition-all border shadow-sm whitespace-nowrap ${selectedIds.size > 0 ? 'bg-red-50 dark:bg-red-500/10 border-red-100 dark:border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 active:scale-[0.98]' : 'bg-transparent text-slate-400 dark:text-zinc-600 border-slate-200/50 dark:border-zinc-800 cursor-not-allowed'}`}>
                  <Trash2 size={18} className="sm:w-[15px] sm:h-[15px]" />
                  <span className="hidden sm:inline">{t('mediaPanel.delete')}</span>
                </button>
              </div>
            </div>
          </div>
        </header>
        <div className="mt-4 flex items-center gap-2 h-[38px]">
          <div className="relative flex-1 h-full overflow-hidden flex items-center min-w-0">
            <div className={`hidden sm:flex absolute left-0 top-0 bottom-0 w-16 bg-gradient-to-r from-[#F8FAFC] dark:from-zinc-950 via-[#F8FAFC] dark:via-zinc-950 to-transparent z-20 items-center justify-start pointer-events-none transition-opacity duration-300 ${canScrollLeft ? 'opacity-100' : 'opacity-0'}`}>
              <button
                type="button"
                onClick={() => scrollTabs('left')}
                className={`ml-3 ${TAB_SCROLL_ARROW_BUTTON_CLASS} ${canScrollLeft ? 'pointer-events-auto' : 'pointer-events-none'}`}
                tabIndex={canScrollLeft ? 0 : -1}
                aria-hidden={canScrollLeft ? 'false' : 'true'}
              >
                <ChevronLeft size={16} strokeWidth={2.5} />
              </button>
            </div>

            <div
              ref={tabsRef}
              onScroll={() => {
                checkScroll();
                updateIndicator();
              }}
              className="relative w-full h-full flex items-center gap-2 overflow-x-auto no-scrollbar"
              style={{ scrollbarWidth: 'none' }}
            >
              <div
                className={`absolute top-1/2 h-[32px] rounded-[10px] shadow-sm pointer-events-none transition-[transform,width,opacity,background-color] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] inline-flex items-center justify-center gap-1.5 px-4 text-[14px] font-bold whitespace-nowrap overflow-hidden ${activeCategory === '__STARRED__' ? 'bg-orange-500 text-white' : 'bg-slate-800 text-white dark:bg-zinc-200 dark:text-zinc-900'}`}
                style={{
                  width: `${indicatorStyle.width}px`,
                  opacity: indicatorStyle.opacity,
                  transform: `translate3d(${indicatorStyle.left}px, -50%, 0)`,
                }}
              />
              <div
                className={`absolute top-1/2 h-[32px] rounded-[10px] pointer-events-none transition-[transform,width,opacity,color] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] inline-flex items-center justify-center gap-1.5 px-4 text-[14px] font-bold whitespace-nowrap overflow-hidden z-20 ${activeCategory === '__STARRED__' ? 'text-white' : 'text-white dark:text-zinc-900'}`}
                style={{
                  width: `${indicatorStyle.width}px`,
                  opacity: indicatorStyle.opacity,
                  transform: `translate3d(${indicatorStyle.left}px, -50%, 0)`,
                }}
              >
                {activeCategory === '__STARRED__' ? <Star size={18} strokeWidth={2.3} className="shrink-0 fill-current" /> : null}
                <span className="text-center">{activeTabLabel}</span>
              </div>
              {allTabs.map((cat) => (
                <button
                  key={cat}
                  data-tab={cat}
                  aria-selected={isTabActive(cat) ? 'true' : 'false'}
                  type="button"
                  onClick={() => handleCategoryChange(cat)}
                  className={`relative z-10 px-4 py-1.5 rounded-[10px] text-[14px] font-bold whitespace-nowrap transition-all active:scale-95 inline-flex items-center justify-center gap-1.5 ${isTabActive(cat)
                    ? 'text-transparent'
                    : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-200/60 dark:hover:bg-zinc-800'
                    }`}
                >
                  {cat === '__STARRED__' ? <Star size={18} strokeWidth={2.3} className={`relative z-10 shrink-0 ${isTabActive(cat) ? 'fill-current' : ''}`} /> : null}
                  <span className="relative z-10 text-center">{getTabLabel(cat)}</span>
                </button>
              ))}
            </div>

            <div className={`hidden sm:flex absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-[#F8FAFC] dark:from-zinc-950 via-[#F8FAFC] dark:via-zinc-950 to-transparent z-20 items-center justify-end pointer-events-none transition-opacity duration-300 ${canScrollRight ? 'opacity-100' : 'opacity-0'}`}>
              <button
                type="button"
                onClick={() => scrollTabs('right')}
                className={`mr-3 ${TAB_SCROLL_ARROW_BUTTON_CLASS} ${canScrollRight ? 'pointer-events-auto' : 'pointer-events-none'}`}
                tabIndex={canScrollRight ? 0 : -1}
                aria-hidden={canScrollRight ? 'false' : 'true'}
              >
                <ChevronRight size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          <div className="pl-3 border-l border-slate-200 dark:border-zinc-700 h-full flex items-center shrink-0">
            <button
              type="button"
              onClick={openManageCategoryModal}
              className="p-1.5 rounded-xl bg-white dark:bg-zinc-800/50 border border-slate-200/80 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 hover:bg-slate-200/60 dark:hover:bg-zinc-800 transition-colors active:scale-90 flex items-center justify-center shadow-sm"
              title={t('mediaPanel.manageCategories')}
            >
              <Settings2 size={18} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
      <div
        onAnimationEnd={() => setIsTabContentAnimating(false)}
        style={{
          animation: isTabContentAnimating
            ? `${tabDirection === 'right' ? 'physSlideInRight' : 'physSlideInLeft'} 0.4s cubic-bezier(0.22,1,0.36,1)`
            : 'none',
          marginTop: `${DEFAULT_CONTENT_SPACING_PX}px`,
          paddingBottom: `${contentBottomPaddingPx}px`,
        }}
      >
        {mediaErrorText ? (
          <div
            className={`grid overflow-hidden transition-[grid-template-rows,opacity,transform,margin-bottom] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] ${
              isMediaErrorVisible ? 'grid-rows-[1fr] opacity-100 translate-y-0 mb-3' : 'grid-rows-[0fr] opacity-0 -translate-y-2 mb-0'
            }`}
            style={{ transitionDuration: `${MEDIA_ERROR_EXIT_MS}ms` }}
          >
            <div className="min-h-0">
              <div className="rounded-xl border border-rose-100 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-[13px] font-semibold text-rose-600 dark:text-rose-300">
                {mediaErrorText}
              </div>
            </div>
          </div>
        ) : null}
        {mediaTask ? (
          <div
            className={`grid overflow-hidden transition-[grid-template-rows,opacity,transform,margin-bottom] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] ${
              isMediaTaskVisible ? 'grid-rows-[1fr] opacity-100 translate-y-0 mb-3' : 'grid-rows-[0fr] opacity-0 -translate-y-2 mb-0'
            }`}
            style={{ transitionDuration: `${MEDIA_ERROR_EXIT_MS}ms` }}
          >
            <div className="min-h-0">
              <div className="rounded-xl border border-blue-100 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/10 px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-[13px] font-semibold text-blue-600 dark:text-blue-300">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{mediaTaskLabel}</div>
                    {canResumeUpload ? (
                      <div className="mt-0.5 text-[11px] font-medium text-blue-500/80 dark:text-blue-300/80 truncate">
                        {t('mediaPanel.uploadResumeHint')}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {mediaTaskStatusText ? <span className="tabular-nums">{mediaTaskStatusText}</span> : null}
                    {canResumeUpload ? (
                      <button
                        type="button"
                        onClick={handleResumeUpload}
                        className="inline-flex h-8 items-center justify-center rounded-lg border border-blue-200/80 dark:border-blue-400/20 bg-white/80 dark:bg-blue-950/30 px-3 text-[12px] font-bold text-blue-600 dark:text-blue-200 transition-colors hover:bg-white dark:hover:bg-blue-900/40 active:scale-[0.98]"
                      >
                        {t('mediaPanel.uploadResumeAction')}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950/60">
                  <div
                    className="h-full rounded-full bg-blue-600 dark:bg-blue-400 transition-[width,opacity] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]"
                    style={{
                      width: `${mediaTaskProgress}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-[11px] font-medium leading-relaxed text-blue-500/80 dark:text-blue-300/80">
                  {canResumeUpload ? t('mediaPanel.uploadResumeSelectFileHint') : t('mediaPanel.uploadTaskHint')}
                </p>
              </div>
            </div>
          </div>
        ) : null}
        <div
          ref={gridRef}
          className="grid grid-cols-1 items-start sm:grid-cols-2 lg:grid-cols-3"
          style={{ columnGap: `${DEFAULT_CONTENT_SPACING_PX}px`, rowGap: `${DEFAULT_CONTENT_SPACING_PX}px` }}
        >
          {!isMediaLoading && filteredMediaList.length === 0 ? <EmptyMediaState minHeight={emptyStateHeightPx} /> : mediaCardNodes}
        </div>
      </div>

      <ModalShell
        mounted={showUploadProcessingModal}
        active={showUploadProcessingModal}
        closing={isUploadProcessingClosing}
        onClose={isUploading ? undefined : closeUploadProcessingModal}
        contentClassName="auth-card modal-content modal-content--form w-full rounded-t-[32px] rounded-b-none sm:rounded-[28px]"
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />
        <div className="modal-body !text-left !px-5 sm:!px-8 !pt-7 !pb-5">
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-[14px] bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300 flex items-center justify-center shrink-0">
              <CloudUpload className="w-6 h-6" strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[20px] leading-7 font-bold text-slate-900 dark:text-zinc-100">{t('mediaPanel.processingChoiceTitle')}</h3>
              <p className="text-[13px] leading-5 text-slate-500 dark:text-zinc-400">{t('mediaPanel.processingChoiceSubtitle')}</p>
            </div>
          </div>

          <div className="rounded-[14px] border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/80 p-3 mb-5 flex items-center gap-3">
            <div className="w-9 h-9 rounded-[10px] bg-white dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 shadow-sm flex items-center justify-center shrink-0">
              <FileVideo className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-slate-700 dark:text-zinc-200 truncate">{pendingUploadFile?.name || ''}</p>
              <p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">{formatMediaBytes(pendingUploadFile?.size || 0)}</p>
            </div>
            <div className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-medium">{t('mediaPanel.originalQuality')}</span>
              <span className="text-[13px] font-bold text-slate-700 dark:text-zinc-100">{getOriginalResolution(pendingUploadMetadata)}</span>
            </div>
          </div>

          <div className="w-full space-y-3">
            {[
              {
                id: 'fast_playable',
                title: t('mediaPanel.fastPlayableTitle'),
                qualities: getProcessingQualities('fast_playable', pendingUploadMetadata),
                descKey: 'mediaPanel.fastPlayableDesc',
                Icon: Play,
              },
              {
                id: 'full_quality',
                title: t('mediaPanel.fullQualityTitle'),
                qualities: getProcessingQualities('full_quality', pendingUploadMetadata),
                descKey: 'mediaPanel.fullQualityDesc',
                Icon: MonitorPlay,
              },
            ].map((option) => {
              const isActive = selectedUploadProcessingMode === option.id;
              const Icon = option.Icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedUploadProcessingMode(option.id)}
                  className={`w-full text-left rounded-[18px] border-2 p-4 transition-all duration-200 active:scale-[0.99] flex items-start gap-4 ${isActive
                    ? 'border-blue-600 bg-blue-50/70 text-slate-900 dark:border-blue-400 dark:bg-blue-500/15 dark:text-zinc-100'
                    : 'border-slate-100 bg-white text-slate-800 hover:border-slate-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700'
                    }`}
                >
                  <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors duration-200 ${isActive ? 'bg-blue-600 text-white dark:bg-blue-500' : 'bg-slate-100 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500'}`}>
                    <Icon className={`w-5 h-5 ${option.id === 'fast_playable' ? 'ml-0.5' : ''}`} fill={option.id === 'fast_playable' ? 'currentColor' : 'none'} />
                  </span>
                  <span className="flex-1 min-w-0 pt-0.5">
                    <span className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="font-bold text-[15px] text-slate-800 dark:text-zinc-100 whitespace-nowrap">{option.title}</span>
                      {option.id === 'fast_playable' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">{t('mediaPanel.recommended')}</span>
                      ) : null}
                    </span>
                    <span className="block text-[12px] leading-5 text-slate-500 dark:text-zinc-400">
                      {t(option.descKey, { qualities: option.qualities })}
                    </span>
                  </span>
                  {isActive ? <CheckCircle2 className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-2" /> : null}
                </button>
              );
            })}
          </div>
          <div className="flex items-start gap-2 text-left text-slate-400 dark:text-zinc-500 mt-4 px-1">
            <Info className="w-3.5 h-3.5 mt-[3px] shrink-0" />
            <p className="text-[11px] leading-5">
              {t('mediaPanel.processingQualityLimit', { resolution: getOriginalResolution(pendingUploadMetadata) })}
            </p>
          </div>
        </div>
        <div className="modal-actions !px-5 sm:!px-8">
          <button type="button" onClick={closeUploadProcessingModal} disabled={isUploadLocked} className="modal-btn modal-btn-secondary !w-28 !rounded-[14px] !py-3.5 shrink-0">
            {t('mediaPanel.cancel')}
          </button>
          <button type="button" onClick={confirmUploadProcessing} disabled={isUploadLocked} className="modal-btn modal-btn-primary !flex-1 !rounded-[14px] !py-3.5 gap-2">
            <CloudUpload className="w-4 h-4" />
            {isUploading ? t('media.processing') : t('mediaPanel.startUpload')}
          </button>
        </div>
      </ModalShell>

      <ModalShell
        mounted={showDeleteConfirmModal}
        active={showDeleteConfirmModal}
        closing={isDeleteConfirmClosing}
        onClose={closeDeleteConfirmModal}
        contentClassName={COMPACT_MODAL_CONTENT_CLASS}
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-error" />
        <div className="modal-body">
          <div className="modal-icon-badge is-error">
            <div className="modal-icon-core">
              <Trash2 className="modal-icon-glyph w-8 h-8" />
            </div>
          </div>
          <h3 className="modal-heading">{t('mediaPanel.confirmDeleteTitle')}</h3>
          <p className="modal-copy">
            {pendingDeleteIds.length > 1
              ? t('mediaPanel.confirmDeleteMultiple', { count: pendingDeleteIds.length })
              : t('mediaPanel.confirmDeleteSingle')}
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={closeDeleteConfirmModal} className="modal-btn modal-btn-secondary">
            {t('mediaPanel.cancel')}
          </button>
          <button type="button" onClick={executeDelete} className="modal-btn modal-btn-danger">
            {t('mediaPanel.delete')}
          </button>
        </div>
      </ModalShell>

      <ModalShell
        mounted={showMoveActionSheet}
        active={showMoveActionSheet}
        closing={isMoveActionSheetClosing}
        onClose={closeMoveActionSheet}
        contentClassName={UNIFIED_CATEGORY_MODAL_CONTENT_CLASS}
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />
        <div className="absolute inset-0 pointer-events-none rounded-t-[32px] sm:rounded-[32px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] z-20" />
        <div className="pt-6 sm:pt-10 px-6 sm:px-10 relative z-10 flex flex-col items-center w-full" style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
          <div className="w-[64px] h-[64px] mb-4 rounded-[18px] bg-[#F0F7FF] dark:bg-blue-900/20 flex items-center justify-center shadow-[inset_0_0_0_1px_rgba(0,122,255,0.05),0_8px_20px_rgba(0,122,255,0.12)] dark:shadow-[0_8px_20px_rgba(0,122,255,0.15)] relative">
            <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent dark:from-white/5 rounded-[18px]" />
            <FolderPlus className="modal-icon-glyph w-7 h-7 text-[#007AFF] dark:text-[#0A84FF]" strokeWidth={2} />
          </div>
          <h3 className="text-[22px] font-bold tracking-tight text-gray-900 dark:text-white mb-2">{t('mediaPanel.moveToCategoryTitle')}</h3>
          <p className="text-[14px] text-gray-500 dark:text-[#A1A1AA] text-center leading-[1.6] mb-5">{t('mediaPanel.moveToCategoryDesc', { count: selectedIds.size })}</p>
          <div className="w-full h-[220px] rounded-[20px] border border-slate-200/90 dark:border-zinc-700 bg-[#F8FAFC] dark:bg-[#1C1C1E] overflow-hidden">
            <div className="h-full overflow-y-auto no-scrollbar">
              {categories.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-center text-[14px] text-slate-500 dark:text-zinc-400">{t('mediaPanel.noCategories')}</p>
                </div>
              ) : (
                categories.map((cat, idx) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => handleMoveToCategory(cat)}
                    className={`w-full h-[64px] flex items-center gap-3 px-4 text-left hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors ${idx !== categories.length - 1 ? 'border-b border-slate-200/80 dark:border-zinc-700/80' : ''}`}
                  >
                    <span className="w-10 h-10 rounded-[12px] bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 inline-flex items-center justify-center text-[20px] font-semibold">#</span>
                    <span className="flex-1 min-w-0 truncate text-[16px] text-slate-800 dark:text-zinc-100">{cat}</span>
                    <span className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-blue-600 dark:text-blue-400">
                      <ChevronRight size={18} strokeWidth={2.5} />
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 w-full mt-5">
            <button
              type="button"
              onClick={closeMoveActionSheet}
              className="flex-1 py-[14px] rounded-2xl font-semibold text-[15px] transition-all active:scale-[0.98] bg-[#F2F2F7] text-gray-700 dark:bg-[#1C1C1E] dark:text-gray-300"
            >
              {t('mediaPanel.cancel')}
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        mounted={showManageCategoryModal}
        active={showManageCategoryModal}
        closing={isManageCategoryClosing}
        onClose={closeManageCategoryModal}
        contentClassName={UNIFIED_CATEGORY_MODAL_CONTENT_CLASS}
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />
        <div className="absolute inset-0 pointer-events-none rounded-t-[32px] sm:rounded-[32px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] z-20" />
        <div className="pt-6 sm:pt-10 px-6 sm:px-10 relative z-10 flex flex-col items-center w-full" style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
          <div className="w-[64px] h-[64px] mb-4 rounded-[18px] bg-[#F0F7FF] dark:bg-blue-900/20 flex items-center justify-center shadow-[inset_0_0_0_1px_rgba(0,122,255,0.05),0_8px_20px_rgba(0,122,255,0.12)] dark:shadow-[0_8px_20px_rgba(0,122,255,0.15)] relative">
            <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent dark:from-white/5 rounded-[18px]" />
            <Settings2 className="modal-icon-glyph w-7 h-7 text-[#007AFF] dark:text-[#0A84FF]" strokeWidth={2} />
          </div>

          <h3 className="text-[22px] font-bold tracking-tight text-gray-900 dark:text-white mb-2">{t('mediaPanel.manageCategories')}</h3>
          <p className="text-[14px] text-gray-500 dark:text-[#A1A1AA] text-center leading-[1.6] mb-5">{t('mediaPanel.manageCategoriesDesc')}</p>

          <div className="w-full mb-4 relative" ref={manageCategoryPickerRef}>
            <div className="flex items-center gap-3">
              <div className="relative flex-1 app-tonal-input-shell">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleCreateCategory();
                  }}
                  placeholder={t('mediaPanel.categoryInputPlaceholder')}
                  className="app-tonal-input w-full h-[52px] px-4 pr-11 text-[15px] leading-none"
                />
                {categoryPresetOptions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowCategoryPresetPanel((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full inline-flex items-center justify-center text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    aria-label={t('mediaPanel.expandCategorySuggestions')}
                  >
                    <ChevronDown size={18} className={`transition-transform duration-200 ${showCategoryPresetPanel ? 'rotate-180' : ''}`} />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleCreateCategory}
                disabled={!newCategoryName.trim()}
                className={`h-[52px] px-6 rounded-[16px] text-[15px] font-semibold inline-flex items-center justify-center transition-all ${newCategoryName.trim()
                  ? 'bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-100 active:scale-[0.98]'
                  : 'bg-slate-200/70 dark:bg-zinc-700/60 text-slate-400 dark:text-zinc-500 cursor-not-allowed'
                  }`}
              >
                <span className="inline-flex items-center justify-center gap-1.5 leading-none">
                  <Plus size={18} />
                  {t('mediaPanel.add')}
                </span>
              </button>
            </div>

            {showCategoryPresetPanel && categoryPresetOptions.length > 0 ? (
              <div className="absolute left-0 right-0 top-[calc(100%+12px)] z-40 rounded-[20px] border border-slate-200/90 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-[0_10px_26px_rgba(15,23,42,0.08)] overflow-hidden">
                <div className="grid grid-cols-2 gap-x-2 gap-y-2 p-4">
                  {categoryPresetOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => handlePickPresetCategory(option)}
                      className="h-10 px-3 rounded-xl text-left text-[15px] text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors inline-flex items-center gap-2"
                    >
                      <Plus size={16} className="text-slate-400 dark:text-zinc-500" />
                      <span>{option}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="w-full h-[160px] rounded-[20px] border border-slate-200/90 dark:border-zinc-700 bg-[#F8FAFC] dark:bg-[#1C1C1E] overflow-hidden">
            <div className="h-full overflow-y-auto no-scrollbar">
              {draftCategories.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-center text-[14px] text-slate-500 dark:text-zinc-400">{t('mediaPanel.noCategories')}</p>
                </div>
              ) : (
                draftCategories.map((cat, idx) => (
                  <div key={cat} className={`h-[64px] flex items-center gap-3 px-4 ${idx !== draftCategories.length - 1 ? 'border-b border-slate-200/80 dark:border-zinc-700/80' : ''}`}>
                    <span className="w-10 h-10 rounded-[12px] bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 inline-flex items-center justify-center text-[20px] font-semibold">#</span>
                    <span className="flex-1 text-[16px] text-slate-800 dark:text-zinc-100">{cat}</span>
                    <button
                      type="button"
                      onClick={() => handleDeleteCategory(cat)}
                      className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/20 transition-colors"
                      aria-label={t('mediaPanel.deleteCategoryAria', { category: cat })}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 w-full mt-6">
            <button
              type="button"
              onClick={closeManageCategoryModal}
              className="flex-1 py-[14px] rounded-2xl font-semibold text-[15px] transition-all active:scale-[0.98] bg-[#F2F2F7] text-gray-700 dark:bg-[#1C1C1E] dark:text-gray-300"
            >
              {t('mediaPanel.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSaveCategoryChanges}
              className="flex-1 py-[14px] rounded-2xl font-semibold text-[15px] transition-all active:scale-[0.98] bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.2)] dark:bg-[#0A84FF]"
            >
              {t('mediaPanel.save')}
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        mounted={Boolean(renamingItem)}
        active={Boolean(renamingItem)}
        closing={isRenameClosing}
        onClose={closeRenameEditor}
        contentClassName={COMPACT_MODAL_CONTENT_CLASS}
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />
        <div className="modal-body">
          <div className="modal-icon-badge is-info">
            <div className="modal-icon-core">
              <Edit className="modal-icon-glyph w-8 h-8" />
            </div>
          </div>
          <h3 className="modal-heading">{t('mediaPanel.renameTitle')}</h3>
          <p className="modal-copy">{t('mediaPanel.renameDesc')}</p>
          <div className="relative w-full mt-1 app-tonal-input-shell">
            <input
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveRenameAndClose();
              }}
              placeholder={t('mediaPanel.renamePlaceholder')}
              className="app-tonal-input w-full px-4 py-3 text-[15px]"
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={closeRenameEditor} className="modal-btn modal-btn-secondary">
            {t('mediaPanel.cancel')}
          </button>
          <button type="button" onClick={saveRenameAndClose} className="modal-btn modal-btn-primary">
            {t('mediaPanel.save')}
          </button>
        </div>
      </ModalShell>
    </section>
  );
});

export default MediaLibraryPanel;
