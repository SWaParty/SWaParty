export default function MobileBottomTabBar({ items = [] }) {
  return (
    <div data-mobile-bottom-tab="true" className="md:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-zinc-900 border-t border-slate-200/70 dark:border-zinc-800/70 z-50 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex justify-around shadow-[0_-4px_18px_rgba(15,23,42,0.04)] dark:shadow-[0_-4px_18px_rgba(0,0,0,0.26)] overflow-hidden [transform:translateZ(0)] [backface-visibility:hidden] [will-change:transform] after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-[-1px] after:h-[1px] after:bg-white dark:after:bg-zinc-900 after:pointer-events-none">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = Boolean(item.active);
        const badgeRaw = item.badge;
        const badgeNumber = typeof badgeRaw === 'number' ? badgeRaw : Number(badgeRaw);
        const showBadge = Number.isFinite(badgeNumber) && badgeNumber > 0;
        const badgeText = showBadge ? (badgeNumber > 99 ? '99+' : String(badgeNumber)) : '';

        return (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            className={`relative flex flex-col items-center justify-center w-full py-1.5 rounded-xl transition-colors ${
              isActive
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300'
            }`}
            aria-label={item.label}
            title={item.label}
          >
            <div className={`p-1 mb-0.5 rounded-lg transition-colors ${isActive ? 'bg-blue-50 dark:bg-blue-500/20' : 'bg-transparent'}`}>
              <Icon className="w-[22px] h-[22px]" />
            </div>
            <span className="text-[11px] font-medium">{item.label}</span>
            {showBadge ? (
              <span className="absolute top-1 right-3 min-w-[16px] h-[16px] bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center rounded-full border-2 border-white dark:border-zinc-900 px-1 shadow-sm">
                {badgeText}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
