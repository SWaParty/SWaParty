import { lazy, Suspense } from 'react';

const EmojiPicker = lazy(() => import('emoji-picker-react'));

export function RoomEmojiPicker({
  onSelect,
  isDark = false,
  className = '',
  width = 300,
  height = 320,
}) {
  return (
    <div className={`swaparty-emoji-picker overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-[#181a1f] ${className}`}>
      <Suspense
        fallback={(
          <div
            className="flex items-center justify-center text-sm font-semibold text-slate-500 dark:text-zinc-400"
            style={{ width, height }}
          >
            ...
          </div>
        )}
      >
        <EmojiPicker
          width={width}
          height={height}
          theme={isDark ? 'dark' : 'light'}
          emojiStyle="native"
          lazyLoadEmojis
          skinTonesDisabled
          suggestedEmojisMode="recent"
          previewConfig={{ showPreview: false }}
          onEmojiClick={(emojiData) => {
            if (emojiData?.emoji) onSelect(emojiData.emoji);
          }}
        />
      </Suspense>
    </div>
  );
}
