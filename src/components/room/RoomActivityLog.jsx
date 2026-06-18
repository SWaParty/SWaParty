import {
  Activity,
  AlertTriangle,
  FileVideo,
  Pause,
  Play,
} from 'lucide-react';
import { t } from '../../i18n';

function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function getLogVisual(log) {
  if (log.kind === 'play') return { icon: Play, className: 'border-orange-200 bg-orange-50 text-orange-600 dark:border-orange-500/25 dark:bg-orange-500/10 dark:text-orange-300' };
  if (log.kind === 'pause') return { icon: Pause, className: 'border-orange-200 bg-orange-50 text-orange-600 dark:border-orange-500/25 dark:bg-orange-500/10 dark:text-orange-300' };
  if (log.kind === 'source') return { icon: FileVideo, className: 'border-slate-200 bg-slate-100 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' };
  if (log.kind === 'error') return { icon: AlertTriangle, className: 'border-red-100 bg-red-50 text-red-500 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300' };
  if (log.type === 'sync') return { icon: Activity, className: 'border-indigo-100 bg-indigo-50 text-indigo-600 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-300' };
  return { icon: Activity, className: 'border-slate-200 bg-slate-100 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' };
}

export function RoomActivityLog({ logs = [] }) {
  const displayLogs = logs.slice(-30).reverse();

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[20px] p-5 shadow-sm border border-slate-100 dark:border-zinc-800/80">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-extrabold text-slate-800 dark:text-zinc-100 flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-500" />
          {t('room.activityLogTitle')}
        </h3>
        <span className="text-[12px] font-semibold text-slate-400 dark:text-zinc-500">
          {t('room.activityLogLatestOnly')}
        </span>
      </div>

      <div className="h-[220px] max-h-[220px] overflow-y-auto no-scrollbar pr-1">
        {displayLogs.length ? (
          <div className="flex flex-col gap-3">
            {displayLogs.map((log) => {
              const visual = getLogVisual(log);
              const Icon = visual.icon;
              return (
                <div key={log.id} className="grid grid-cols-[58px_minmax(0,1fr)] items-start gap-3 text-[13px]">
                  <time className="pt-1 font-mono text-[12px] font-semibold text-slate-400 dark:text-zinc-500">
                    {formatLogTime(log.createdAt)}
                  </time>
                  <div className={`inline-flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 font-semibold leading-relaxed ${visual.className}`}>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{log.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] font-semibold text-slate-400 dark:text-zinc-500">
            {t('room.activityLogEmpty')}
          </div>
        )}
      </div>
    </div>
  );
}
