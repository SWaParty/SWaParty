import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import {
  Megaphone,
  MessageSquare,
  Plus,
  Send,
} from 'lucide-react';
import { t } from '../../i18n';
import { RoomEmojiPicker } from './RoomEmojiPicker';

function formatChatClockTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function ChatPanel({
  isMobile = false,
  messages,
  user,
  canSendChat = true,
  chatInput,
  setChatInput,
  sendMessage,
  chatEndRef,
  onlineCount = 1,
  canSubmitChat = canSendChat,
  roomNotice = '',
  isDark = false,
}) {
  const currentUserId = user.id || user.email || user.name;
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const chatInputRef = useRef(null);
  const canSendCurrentMessage = canSubmitChat && chatInput.trim();

  useLayoutEffect(() => {
    const input = chatInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = 112;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  }, [chatInput]);

  const handleChatInputKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (canSendCurrentMessage) {
      sendMessage(event);
    }
  };

  const renderMessageAvatar = (msg, isOwnMessage) => {
    const avatarUrl = msg.avatar || (isOwnMessage ? user.avatarUrl : '');
    const name = msg.user || user.name || '?';
    return (
      <div className="mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-[12px] font-black text-slate-500 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {avatarUrl ? (
          <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            {String(name).trim().slice(0, 1).toUpperCase() || '?'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!isMobile ? (
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-100 dark:border-zinc-800/50 shrink-0">
          <div className="flex items-center gap-2.5 font-bold text-[15px] text-slate-800 dark:text-zinc-100">
            <MessageSquare className="w-5 h-5 text-blue-500" />
            {t('room.info')}
          </div>
          <span className="bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 text-[12px] px-2.5 py-1 rounded-lg font-bold border border-slate-200/50 dark:border-zinc-700">
            {t('room.onlineCount', { count: onlineCount })}
          </span>
        </div>
      ) : null}

      <div className={`min-h-0 flex-1 overflow-y-auto no-scrollbar p-4 flex flex-col gap-4 ${isMobile ? 'bg-white dark:bg-zinc-900' : 'bg-[#f4f6f8]/50 dark:bg-[#09090b]/50'}`}>
        {String(roomNotice || '').trim() ? (
          <div className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 shadow-sm dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="mb-1 flex items-center gap-2 text-[12px] font-black">
              <Megaphone className="h-4 w-4" />
              {t('room.roomNoticeLabel')}
            </div>
            <p className="text-[13px] font-semibold leading-relaxed">{roomNotice}</p>
          </div>
        ) : null}

        {messages.map((msg, index) => {
          const isSystemMessage = msg.type !== 'chat';
          const previousMessage = messages[index - 1];
          const showTimeDivider = msg.type === 'chat'
            && Number.isFinite(msg.createdAt)
            && (!Number.isFinite(previousMessage?.createdAt) || msg.createdAt - previousMessage.createdAt >= 5 * 60 * 1000);
          const isOwnMessage = msg.userId ? msg.userId === currentUserId : msg.user === user.name;
          return (
            <Fragment key={msg.id}>
              {showTimeDivider ? (
                <div className="flex justify-center">
                  <div className="rounded-full bg-slate-900/5 px-3 py-1 text-[12px] font-semibold text-slate-500 dark:bg-white/8 dark:text-zinc-400">
                    {formatChatClockTime(msg.createdAt)}
                  </div>
                </div>
              ) : null}
              {isSystemMessage ? (
                <div className="flex justify-center [animation:swaparty-chat-message-in_220ms_cubic-bezier(0.2,0.8,0.2,1)_both]">
                  <div className="max-w-[86%] rounded-full bg-slate-900/5 px-3 py-1.5 text-center text-[12px] font-semibold leading-snug text-slate-500 dark:bg-white/8 dark:text-zinc-400">
                    {msg.text}
                  </div>
                </div>
              ) : (
                <div className={`flex items-start gap-2 [animation:swaparty-chat-message-in_260ms_cubic-bezier(0.2,0.8,0.2,1)_both] ${isOwnMessage ? 'justify-end [--chat-enter-x:18px]' : 'justify-start [--chat-enter-x:-18px]'}`}>
                  {!isOwnMessage ? renderMessageAvatar(msg, isOwnMessage) : null}
                  <div className={`max-w-[78%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed shadow-sm transition-[transform,box-shadow,background-color,border-color] duration-300 ${isOwnMessage ? 'bg-blue-600 text-white rounded-br-md shadow-blue-500/15' : 'bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 border border-slate-100 dark:border-zinc-700 rounded-bl-md'}`}>
                    {!isOwnMessage ? <div className="text-[11px] opacity-60 font-semibold mb-1">{msg.user}</div> : null}
                    {msg.text}
                  </div>
                  {isOwnMessage ? renderMessageAvatar(msg, isOwnMessage) : null}
                </div>
              )}
            </Fragment>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      <div className={`p-3 md:p-4 shrink-0 ${isMobile ? 'bg-white pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-slate-100 shadow-[0_-8px_24px_rgba(15,23,42,0.05)] dark:bg-zinc-900 dark:border-zinc-800/50' : 'bg-white dark:bg-zinc-900 border-t border-slate-100 dark:border-zinc-800/50'}`}>
        {!canSendChat ? (
          <p className="text-[12px] mb-2 text-slate-500 dark:text-zinc-400">{t('room.chatDisabledPlaceholder')}</p>
        ) : null}
        <form
          onSubmit={sendMessage}
          className={`relative flex items-end rounded-[18px] border px-2 py-2 shadow-sm transition-all duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] focus-within:ring-2 ${canSendCurrentMessage ? 'border-blue-300 bg-white shadow-blue-500/10 focus-within:ring-blue-500/20 dark:border-blue-500/50 dark:bg-zinc-900' : 'border-slate-200/60 bg-slate-50 hover:bg-slate-100 focus-within:border-blue-300 focus-within:bg-white focus-within:ring-blue-500/20 dark:border-zinc-700/50 dark:bg-zinc-800/80 dark:hover:bg-zinc-800 dark:focus-within:border-blue-500/60 dark:focus-within:bg-zinc-900'}`}
        >
          <button
            type="button"
            disabled={!canSendChat}
            onClick={() => setShowEmojiPanel((prev) => !prev)}
            title={showEmojiPanel ? t('room.emojiClose') : t('room.emojiOpen')}
            className={`rounded-xl p-2 transition-all duration-300 ease-out hover:bg-slate-200/50 active:scale-90 disabled:opacity-50 dark:hover:bg-zinc-700 ${showEmojiPanel ? 'bg-slate-200/60 text-slate-700 dark:bg-zinc-700 dark:text-zinc-100' : 'text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300'}`}
            aria-label={showEmojiPanel ? t('room.emojiClose') : t('room.emojiOpen')}
          >
            <Plus className={`h-[18px] w-[18px] transition-transform duration-300 ease-out ${showEmojiPanel ? 'rotate-45 scale-105' : 'rotate-0 scale-100'}`} />
          </button>
          {showEmojiPanel ? (
            <div className="absolute bottom-full left-3 z-50 pb-3">
              <RoomEmojiPicker
                isDark={isDark}
                width={300}
                height={320}
                onSelect={(emoji) => {
                  setChatInput((prev) => prev + emoji);
                  setShowEmojiPanel(false);
                }}
              />
            </div>
          ) : null}
          <textarea
            ref={chatInputRef}
            rows={1}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={handleChatInputKeyDown}
            disabled={!canSendChat}
            placeholder={canSendChat ? t('room.chatPlaceholder') : t('room.chatDisabledPlaceholder')}
            className="no-scrollbar max-h-28 min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] font-medium leading-6 text-slate-800 outline-none transition-[height,min-height,max-height] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] placeholder-slate-400 focus:outline-none dark:text-zinc-100 dark:placeholder-zinc-500"
          />
          <button
            type="submit"
            disabled={!canSendCurrentMessage}
            className={`ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border active:scale-90 transition-all duration-200 outline-none focus:outline-none disabled:opacity-60 ${canSendCurrentMessage ? 'border-blue-500 bg-blue-600 text-white shadow-md shadow-blue-500/20 hover:bg-blue-700' : 'border-slate-200 bg-slate-100 text-slate-400 hover:bg-slate-200/70 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500 dark:hover:bg-zinc-700'}`}
          >
            <Send className={`h-4 w-4 transition-transform duration-200 ${canSendCurrentMessage ? '-translate-x-0.5 translate-y-0 scale-100' : 'scale-95'}`} />
          </button>
        </form>
      </div>
    </div>
  );
}
