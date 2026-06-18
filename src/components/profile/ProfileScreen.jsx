import {
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    Bell,
    Camera,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    Download,
    Edit2,
    Eye,
    EyeOff,
    Globe,
    HardDrive,
    KeyRound,
    Lock,
    LockOpen,
    LogOut,
    Mail,
    MessageCircle,
    Moon,
    RefreshCw,
    Rocket,
    RotateCcw,
    Search,
    Shield,
    ShieldAlert,
    ShieldCheck,
    Sun,
    Timer,
    User,
    UserX,
    Users,
    X,
    XCircle
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MobileBottomTabBar from '../common/MobileBottomTabBar';
import { getLocale, setLocale, t } from '../../i18n';
import {
    clearProfileMetaCacheDirty,
    getProfileMetaCacheKey,
    isProfileMetaCacheDirty,
    markProfileMetaCacheDirty,
    readCachedProfileMeta,
    writeCachedProfileMeta,
} from '../../lib/localProfileCache';
import { MEDIA_CHANGED_EVENT } from '../../lib/realtimeMediaBus';
import { PROFILE_UPDATED_EVENT } from '../../lib/realtimeProfileBus';
import {
    detectGpuVideoRenderingSupport,
    readGpuVideoRenderingPreference,
    writeGpuVideoRenderingPreference,
} from '../../lib/videoRenderingPreferences';
import { normalizeSettingsTab } from '../../routes/settingsRoutes';
import QuickContactsPanel from './QuickContactsPanel';
import { buildSettingsSearchCatalog, resolveSettingsSearchTerms } from './settingsSearchCatalog';
import TwoFactorSetupModal from './TwoFactorSetupModal';

const MODAL_CLOSE_MS = 300;
const SAVE_PENDING_MIN_MS = 1000;
const SAVE_RESULT_SHOW_MS = 1000;
const COPY_RESULT_SHOW_MS = 1000;
const LOGOUT_DELAY_MS = 1000;
const PROFILE_FORM_CLEAR_DELAY_MS = 300;
const PROFILE_SCROLL_RESET_AFTER_CLOSE_MS = 160;
const PROFILE_TAB_IDS = ['profile', 'security', 'preferences', 'contacts'];
const PROFILE_TAB_PRELOAD_START_DELAY_MS = 240;
const EMAIL_CODE_COOLDOWN_SEC = 60;
const EMAIL_CODE_COOLDOWN_KEY = 'swaparty.email_change_code.cooldown_until';
const EMAIL_CODE_TARGET_KEY = 'swaparty.email_change_code.target_email';
const PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX = 'swaparty.profile.prefetched_backup_codes';
const PROFILE_META_CACHE = new Map();
const DEFAULT_PROFILE_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

function readEmailCodeCooldownUntil() {
    if (typeof window === 'undefined') return 0;
    try {
        const raw = window.localStorage.getItem(EMAIL_CODE_COOLDOWN_KEY);
        const parsed = Number(raw || 0);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}

function persistEmailCodeCooldownUntil(untilMs) {
    if (typeof window === 'undefined') return;
    try {
        if (untilMs > Date.now()) {
            window.localStorage.setItem(EMAIL_CODE_COOLDOWN_KEY, String(untilMs));
        } else {
            window.localStorage.removeItem(EMAIL_CODE_COOLDOWN_KEY);
        }
    } catch {
        // ignore persistence failures
    }
}

function readEmailCodeTargetEmail() {
    if (typeof window === 'undefined') return '';
    try {
        return String(window.localStorage.getItem(EMAIL_CODE_TARGET_KEY)).trim().toLowerCase();
    } catch {
        return '';
    }
}

function persistEmailCodeTargetEmail(email) {
    if (typeof window === 'undefined') return;
    try {
        const normalized = String(email).trim().toLowerCase();
        if (normalized) {
            window.localStorage.setItem(EMAIL_CODE_TARGET_KEY, normalized);
        } else {
            window.localStorage.removeItem(EMAIL_CODE_TARGET_KEY);
        }
    } catch {
        // ignore persistence failures
    }
}

function createMountedTabMap(initialValue = false) {
    return PROFILE_TAB_IDS.reduce((acc, tabId) => {
        acc[tabId] = Boolean(initialValue);
        return acc;
    }, {});
}

function getPrefetchedBackupCodesKeyForUser(user) {
    const idPart = String(user?.id).trim();
    const emailPart = String(user?.email).trim().toLowerCase();
    if (idPart) return `${PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX}:id:${idPart}`;
    if (emailPart) return `${PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX}:email:${emailPart}`;
    return '';
}

function consumePrefetchedBackupCodes(user) {
    if (typeof window === 'undefined') return [];
    try {
        const cacheKey = getPrefetchedBackupCodesKeyForUser(user);
        if (!cacheKey) return [];
        const raw = window.sessionStorage.getItem(cacheKey);
        window.sessionStorage.removeItem(cacheKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(Boolean);
    } catch {
        return [];
    }
}

function formatStorageAmount(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (!Number.isFinite(value) || value <= 0) return { value: '0', unit: 'MB' };

    const mb = value / (1024 * 1024);
    if (mb < 1024) return { value: String(Math.round(mb)), unit: 'MB' };
    return { value: (mb / 1024).toFixed(1), unit: 'GB' };
}

function statusIconClass(status) {
    if (status === 'active') return 'text-emerald-600 dark:text-emerald-400';
    if (status === 'disabled') return 'text-rose-600 dark:text-rose-400';
    return 'text-zinc-500 dark:text-zinc-400';
}

function extractErrorMessage(payload, fallback) {
    const msg = payload?.error || payload?.message;
    if (typeof msg === 'string' && msg.trim()) return msg;
    return fallback;
}

function mapSaveFieldErrorToText(item) {
    const field = String(item?.field);
    const code = String(item?.code || '');

    if (field === 'displayName') return t('profile.errDisplayNameFailed');
    if (field === 'password') {
        if (code === 'password_old_incorrect') return t('profile.errPasswordOldIncorrect');
        if (code === 'password_too_short') return t('profile.errPasswordTooShort');
        if (code === 'password_complexity') return t('profile.errPasswordComplexity');
        if (code === 'password_invalid_chars') return t('profile.errPasswordInvalidChars');
        if (code === 'password_too_weak') return t('profile.errPasswordTooWeak');
        if (code === 'password_mismatch') return t('profile.errPasswordMismatch');
        if (code === 'password_same_as_old') return t('profile.errPasswordSameAsOld');
        if (code === 'password_required' || code === 'password_empty') return '';
        return t('profile.errPasswordFailed');
    }
    if (field === 'email') return t('profile.errEmailFailed');
    if (field === 'avatar') return t('profile.errAvatarFailed');

    return t('profile.errGenericSaveFailed');
}

const PASSWORD_ERROR_PRIORITY = {
    password_old_incorrect: 1,
    password_same_as_old: 2,
    password_mismatch: 3,
    password_too_short: 4,
    password_complexity: 5,
    password_invalid_chars: 6,
    password_too_weak: 7,
};

function sortAndMapPasswordErrors(fieldErrors) {
    const sorted = Array.isArray(fieldErrors)
        ? [...fieldErrors]
            .filter((item) => String(item?.field || '') === 'password')
            .sort((a, b) => {
                const ca = String(a?.code || '');
                const cb = String(b?.code || '');
                const pa = PASSWORD_ERROR_PRIORITY[ca] ?? 999;
                const pb = PASSWORD_ERROR_PRIORITY[cb] ?? 999;
                return pa - pb;
            })
        : [];

    const mapped = sorted
        .map((item) => mapSaveFieldErrorToText(item))
        .filter(Boolean);

    return Array.from(new Set(mapped));
}

function isPasswordRelatedServerMessage(payload) {
    const message = String(payload?.error || payload?.message || '').toLowerCase();
    if (!message) return false;
    return /password|oldpassword|newpassword|confirmpassword|密码|密碼/.test(message);
}

function isEmailAlreadyRegisteredPayload(payload) {
    const code = String(payload?.code || payload?.errorCode || payload?.reason || '').toLowerCase();
    const message = String(payload?.error || payload?.message || '').toLowerCase();
    const fieldErrors = Array.isArray(payload?.fieldErrors) ? payload.fieldErrors : [];
    const hasFieldCode = fieldErrors.some((item) => {
        const field = String(item?.field || '').toLowerCase();
        const itemCode = String(item?.code || '').toLowerCase();
        if (field !== 'email') return false;
        return itemCode.includes('exist') || itemCode.includes('taken') || itemCode.includes('registered') || itemCode.includes('duplicate');
    });

    if (hasFieldCode) return true;
    if (code.includes('email_exists') || code.includes('email_taken') || code.includes('already_registered') || code.includes('duplicate_email')) return true;
    return /(already\s*(registered|exists|used)|email.*(exists|taken|used)|邮箱.*(已被注册|已存在|被占用)|郵箱.*(已被註冊|已存在|被佔用)|メール.*(登録済み|使用済み)|이메일.*(이미|등록|사용))/.test(message);
}

const TonalInput = ({ icon, label, type = 'text', value, onChange, placeholder, disabled, action }) => {
    const InputIcon = icon;
    return (
        <div className="group relative transition-all">
            <div className="flex items-center justify-between text-[13px] font-medium text-slate-500 dark:text-zinc-400 mb-1.5 ml-1">
                <span>{label}</span>
            </div>
            <div
                className={`app-tonal-input-shell ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
                <div className="app-tonal-input-icon pl-4 pr-3 flex items-center justify-center">
                    <InputIcon className="w-[18px] h-[18px]" />
                </div>
                <input
                    type={type}
                    value={value}
                    onChange={onChange}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="app-tonal-input py-3.5 pr-4 text-[15px]"
                />
                {action ? <div className="pr-2">{action}</div> : null}
            </div>
        </div>
    );
};

const OtpSixInput = ({ value, onChange, disabled }) => {
    const inputRefs = useRef([]);
    const digits = Array.from({ length: 6 }, (_, index) => value[index]);

    const updateAt = (index, nextChar) => {
        const next = value.split('');
        next[index] = nextChar;
        onChange(next.join('').slice(0, 6));
    };

    const handleChange = (index, event) => {
        const nextChar = String(event.target.value).replace(/\D/g, '').slice(-1);
        if (!nextChar) return;
        updateAt(index, nextChar);
        if (index < 5) inputRefs.current[index + 1]?.focus();
    };

    const handleKeyDown = (index, event) => {
        if (event.key !== 'Backspace') return;
        const current = value[index];
        if (current) {
            updateAt(index, '');
            return;
        }
        if (index > 0) {
            updateAt(index - 1, '');
            inputRefs.current[index - 1]?.focus();
        }
    };

    const handlePaste = (event) => {
        event.preventDefault();
        const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        if (!pasted) return;
        onChange(pasted);
        inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    };

    return (
        <div className="flex justify-between gap-2 px-1" onPaste={handlePaste}>
            {digits.map((digit, index) => (
                <input
                    key={index}
                    ref={(el) => { inputRefs.current[index] = el; }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={1}
                    value={digit}
                    disabled={disabled}
                    onChange={(event) => handleChange(index, event)}
                    onKeyDown={(event) => handleKeyDown(index, event)}
                    className="h-12 w-11 rounded-xl border border-zinc-300 bg-white text-center text-xl font-bold text-zinc-900 outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-60"
                />
            ))}
        </div>
    );
};

function HardwareAccelerationIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none">
            <rect x="4" y="6" width="16" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
            <rect x="9" y="10" width="6" height="4" rx="1" stroke="currentColor" strokeWidth="1.8" />
            <path d="M2.8 10h1.8M2.8 14h1.8M19.4 10h1.8M19.4 14h1.8M8 4.5V6M12 4.5V6M16 4.5V6M8 18v1.5M12 18v1.5M16 18v1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function PlaybackControlIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none">
            <rect x="5" y="4" width="14" height="16" rx="2.4" stroke="currentColor" strokeWidth="1.9" />
            <path d="M10 9.2v5.6l4.8-2.8L10 9.2z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
    );
}

function EntrySoundIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none">
            <path d="M5 14.5h3.1l4.4 3.8V5.7L8.1 9.5H5v5z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
            <path d="M16 9.2a4.6 4.6 0 010 5.6M18.7 6.6a8.2 8.2 0 010 10.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
    );
}

function BackupRevealIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="w-5 h-5" fill="none">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M7.5 10h9M7.5 14h5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="17.2" cy="13.9" r="1.3" fill="currentColor" />
        </svg>
    );
}

function SegmentedControl({ value, options, onChange, fullWidth = false }) {
    const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));
    return (
        <div
            className={`relative grid w-full max-w-full rounded-xl bg-slate-100/80 dark:bg-zinc-800/80 border border-slate-200/80 dark:border-zinc-700/80 p-1 ${fullWidth ? '' : 'sm:w-[300px]'}`}
            style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
            <span
                className="pointer-events-none absolute inset-y-1 left-1 rounded-lg bg-white shadow-sm transition-transform duration-200 dark:bg-zinc-900"
                style={{
                    width: `calc((100% - 0.5rem) / ${options.length})`,
                    transform: `translateX(${activeIndex * 100}%)`,
                }}
            />
            {options.map((option) => {
                const isActive = value === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onChange(option.value)}
                        title={option.label}
                        className={`relative z-10 h-8 px-3 rounded-lg text-[12px] sm:text-[13px] font-semibold transition-colors whitespace-nowrap truncate ${isActive ? 'text-slate-800 dark:text-zinc-100' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
function SelectControl({ value, options, onChange, className = '', fullWidth = false }) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef(null);
    const selected = options.find((item) => item.value === value) || options[0];

    useEffect(() => {
        if (!isOpen) return undefined;
        const handlePointerDown = (event) => {
            if (!containerRef.current?.contains(event.target)) {
                setIsOpen(false);
            }
        };
        const handleEscape = (event) => {
            if (event.key === 'Escape') setIsOpen(false);
        };
        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen]);

    const selectValue = (nextValue) => {
        if (nextValue !== value) {
            onChange({ target: { value: nextValue } });
        }
        setIsOpen(false);
    };

    return (
        <div ref={containerRef} className={`relative ${fullWidth ? 'w-full' : 'w-full sm:w-[188px]'} ${className}`}>
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => setIsOpen((prev) => !prev)}
                className={`w-full rounded-[18px] border py-2.5 pl-4 pr-10 text-left text-[14px] font-bold transition-colors ${isOpen ? 'border-blue-300 bg-slate-50 text-slate-700 dark:border-blue-500/60 dark:bg-zinc-800 dark:text-zinc-100' : 'border-slate-300 bg-slate-50 text-slate-700 hover:border-slate-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600'}`}
            >
                {selected?.label}
                <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 transition-transform ${isOpen ? 'rotate-180 text-blue-500 dark:text-blue-400' : 'text-slate-400 dark:text-zinc-500'}`} />
            </button>

            {isOpen ? (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 rounded-2xl border border-slate-300/90 bg-white shadow-[0_14px_36px_rgb(15,23,42,0.14)] overflow-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-[0_14px_36px_rgb(0,0,0,0.35)]">
                    <div role="listbox" className="py-1">
                        {options.map((option) => {
                            const isSelected = option.value === value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    onClick={() => selectValue(option.value)}
                                    className={`w-full px-4 py-2.5 text-left text-[14px] font-semibold transition-colors ${isSelected ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800'}`}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// ---------------- UI Components adapted from new design ---------------- //

function SectionTitle({ title, className = '' }) {
    return (
        <h3 className={`text-[13px] sm:text-[14px] uppercase tracking-widest font-bold text-slate-400 dark:text-zinc-500 ml-4 sm:ml-6 mb-3 ${className}`}>
            {title}
        </h3>
    );
}

function Card({ children, allowOverflow = false }) {
    return (
        <div className={`bg-white dark:bg-zinc-900 rounded-[24px] sm:rounded-[28px] shadow-[0_8px_30px_rgb(0,0,0,0.03)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100/80 dark:border-zinc-800/80 ${allowOverflow ? 'relative z-40 overflow-visible' : 'relative z-0 overflow-hidden'} mb-8 sm:mb-10 transition-shadow duration-500 hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] dark:hover:shadow-[0_8px_30px_rgb(0,0,0,0.3)]`}>
            <div className="flex flex-col divide-y divide-slate-100/60 dark:divide-zinc-800/60">
                {children}
            </div>
        </div>
    );
}

function Row({ label, description, icon, iconBg, children, stacked = false }) {
    return (
        <div className={`flex ${stacked ? 'flex-col items-stretch gap-4' : 'flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-0'} justify-between px-5 sm:px-6 py-4 sm:py-5 hover:bg-slate-50/50 dark:hover:bg-zinc-800/50 transition-colors duration-300 group`}>
            <div className={`flex items-center gap-4 sm:gap-5 w-full min-w-0 ${stacked ? '' : 'sm:w-auto'}`}>
                {icon && (
                    <div className={`w-10 h-10 sm:w-11 sm:h-11 shrink-0 rounded-[12px] sm:rounded-[14px] flex items-center justify-center shadow-sm text-white ${iconBg}`}>
                        {icon}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <span className="text-[15px] sm:text-[16px] font-semibold text-slate-800 dark:text-zinc-100">{label}</span>
                    {description && <p className="text-[12px] sm:text-[13px] text-slate-500 dark:text-zinc-400 font-medium mt-1 leading-relaxed pr-0 sm:pr-6">{description}</p>}
                </div>
            </div>
            <div className={`w-full flex items-center shrink-0 ${stacked ? 'justify-stretch pl-0 mt-0' : 'sm:w-auto justify-end pl-0 sm:pl-4 mt-1 sm:mt-0'}`}>
                {children}
            </div>
        </div>
    );
}

function AppleToggle({ checked, onChange, disabled }) {
    return (
        <button
            type="button"
            onClick={onChange}
            disabled={disabled}
            className={`relative inline-flex h-[30px] w-[50px] sm:h-[32px] sm:w-[52px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none active:scale-95 disabled:opacity-50 disabled:active:scale-100 ${checked ? 'bg-[#34c759]' : 'bg-slate-200 dark:bg-zinc-700'}`}
        >
            <span className={`pointer-events-none inline-block h-[26px] w-[26px] sm:h-[28px] sm:w-[28px] transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-300 cubic-bezier(0.34, 1.56, 0.64, 1) ${checked ? 'translate-x-[20px]' : 'translate-x-0'}`} />
        </button>
    );
}

function normalizeProfileTabId(tabId) {
    return normalizeSettingsTab(tabId);
}

// ---------------- Main Component ---------------- //

const ProfileScreen = memo(function ProfileScreen({ user, initialTab = 'profile', initialProfileMeta = null, onTabChange, onUpdateUser, onBack, onLogout, isDark, toggleTheme, activeRoom = null, isOpen = false, cleanupDelayMs = PROFILE_FORM_CLEAR_DELAY_MS }) {
    // Navigation State
    const [activeTab, setActiveTab] = useState(() => normalizeProfileTabId(initialTab));
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isDesktopSearchFocused, setIsDesktopSearchFocused] = useState(false);
    const [isMobileSearchActive, setIsMobileSearchActive] = useState(false);
    const searchRef = useRef(null);
    const mobileInputRef = useRef(null);
    const mobileSearchOverlayRef = useRef(null);
    const mobileSearchOpenButtonRef = useRef(null);
    const tabSwitchRafRef = useRef(null);
    const pendingTabRef = useRef('');
    const initialUserRef = useRef(user);
    const initialProfileMetaRef = useRef(initialProfileMeta);
    const onUpdateUserRef = useRef(onUpdateUser);
    const saveErrorEnterActionRef = useRef(null);
    const deleteEnterActionRef = useRef(null);
    const twoFactorBlockedEnterActionRef = useRef(null);
    const twoFactorDisableEnterActionRef = useRef(null);
    const backupCodesEnterActionRef = useRef(null);
    const backupCodesErrorEnterActionRef = useRef(null);
    const emailErrorEnterActionRef = useRef(null);

    const [nickname, setNickname] = useState(user.name);
    const [emailInput, setEmailInput] = useState(user.email);
    const [isEmailAlreadyRegistered, setIsEmailAlreadyRegistered] = useState(false);
    const [verifyCode, setVerifyCode] = useState('');
    const [isSendingCode, setIsSendingCode] = useState(false);
    const [emailCodeCooldownUntil, setEmailCodeCooldownUntil] = useState(() => readEmailCodeCooldownUntil());
    const [emailCodeTargetEmail, setEmailCodeTargetEmail] = useState(() => readEmailCodeTargetEmail());
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordSaveState, setPasswordSaveState] = useState('idle');
    const [showOldPassword, setShowOldPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [isTwoFactorEnabled, setIsTwoFactorEnabled] = useState(false);
    const [isTwoFactorProcessing, setIsTwoFactorProcessing] = useState(false);
    const [hardwareAcceleration, setHardwareAcceleration] = useState(() => readGpuVideoRenderingPreference());
    const [gpuVideoRenderingSupport, setGpuVideoRenderingSupport] = useState(null);
    const [allowControl, setAllowControl] = useState(false);
    const [joinSound, setJoinSound] = useState(true);
    const [autoResync, setAutoResync] = useState(true);
    const [syncThreshold, setSyncThreshold] = useState('2');
    const [autoCatchUpOnJoin, setAutoCatchUpOnJoin] = useState(true);
    const [messageSound, setMessageSound] = useState(true);
    const [messageFilter, setMessageFilter] = useState('all');
    const [isLoadingProfile, setIsLoadingProfile] = useState(true);
    const [saveState, setSaveState] = useState('idle');
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isDeleteModalClosing, setIsDeleteModalClosing] = useState(false);
    const [showTwoFactorBlockedModal, setShowTwoFactorBlockedModal] = useState(false);
    const [isTwoFactorBlockedModalClosing, setIsTwoFactorBlockedModalClosing] = useState(false);
    const [showTwoFactorSetupModal, setShowTwoFactorSetupModal] = useState(false);
    const [isTwoFactorSetupModalClosing, setIsTwoFactorSetupModalClosing] = useState(false);
    const [showTwoFactorDisableModal, setShowTwoFactorDisableModal] = useState(false);
    const [isTwoFactorDisableModalClosing, setIsTwoFactorDisableModalClosing] = useState(false);
    const [twoFactorDisableCode, setTwoFactorDisableCode] = useState('');
    const [twoFactorDisableError, setTwoFactorDisableError] = useState('');
    const [backupCodes, setBackupCodes] = useState(() => consumePrefetchedBackupCodes(user));
    const [showBackupCodesModal, setShowBackupCodesModal] = useState(false);
    const [isBackupCodesModalClosing, setIsBackupCodesModalClosing] = useState(false);
    const [backupCodesCopied, setBackupCodesCopied] = useState(false);
    const [backupCodesRegenerating, setBackupCodesRegenerating] = useState(false);
    const [showBackupCodesErrorModal, setShowBackupCodesErrorModal] = useState(false);
    const [isBackupCodesErrorModalClosing, setIsBackupCodesErrorModalClosing] = useState(false);
    const [showSaveErrorModal, setShowSaveErrorModal] = useState(false);
    const [isSaveErrorModalClosing, setIsSaveErrorModalClosing] = useState(false);
    const [saveErrors, setSaveErrors] = useState([]);
    const [saveErrorDisplay, setSaveErrorDisplay] = useState('list');
    const [showEmailErrorModal, setShowEmailErrorModal] = useState(false);
    const [isEmailErrorModalClosing, setIsEmailErrorModalClosing] = useState(false);
    const [emailErrorText, setEmailErrorText] = useState('');
    const [profileMeta, setProfileMeta] = useState(null);
    const [mediaQuota, setMediaQuota] = useState(null);
    const [selectedLocale, setSelectedLocale] = useState(getLocale());
    const [isProfileLangDropdownOpen, setIsProfileLangDropdownOpen] = useState(false);
    const [mountedTabMap, setMountedTabMap] = useState(() => createMountedTabMap(false));
    const mainScrollRef = useRef(null);
    const profileLangDropdownRef = useRef(null);
    const avatarFileInputRef = useRef(null);
    const [avatarPreviewUrl, setAvatarPreviewUrl] = useState(null);
    const [avatarFile, setAvatarFile] = useState(null);
    const saveStateTimerRef = useRef(null);
    const passwordSaveStateTimerRef = useRef(null);
    const copyStateTimerRef = useRef(null);
    const closeScrollResetTimerRef = useRef(null);
    const prevIsOpenRef = useRef(false);
    const tabPreloadTokenRef = useRef(0);
    const tabPreloadRafIdsRef = useRef([]);
    const tabPreloadDeferredTimerIdsRef = useRef([]);
    const tabPreloadIdleIdsRef = useRef([]);
    const tabPreloadStartTimerRef = useRef(null);
    const [copyState, setCopyState] = useState('idle');
    const [nowMs, setNowMs] = useState(() => Date.now());
    const resetMainScrollTop = useCallback(() => {
        const container = mainScrollRef.current;
        if (!container) return;
        container.scrollTop = 0;
    }, []);

    const cancelTabPreload = useCallback(() => {
        tabPreloadTokenRef.current += 1;
        if (tabPreloadStartTimerRef.current) {
            window.clearTimeout(tabPreloadStartTimerRef.current);
            tabPreloadStartTimerRef.current = null;
        }
        if (tabPreloadDeferredTimerIdsRef.current.length > 0) {
            tabPreloadDeferredTimerIdsRef.current.forEach((id) => {
                window.clearTimeout(id);
            });
            tabPreloadDeferredTimerIdsRef.current = [];
        }
        if (tabPreloadIdleIdsRef.current.length > 0) {
            tabPreloadIdleIdsRef.current.forEach((id) => {
                if ('cancelIdleCallback' in window) {
                    window.cancelIdleCallback(id);
                }
            });
            tabPreloadIdleIdsRef.current = [];
        }
        if (tabPreloadRafIdsRef.current.length === 0) return;
        tabPreloadRafIdsRef.current.forEach((id) => {
            window.cancelAnimationFrame(id);
        });
        tabPreloadRafIdsRef.current = [];
    }, []);

    const scheduleTabPreload = useCallback((baseTabId) => {
        const baseTab = normalizeProfileTabId(baseTabId);
        cancelTabPreload();
        const token = ++tabPreloadTokenRef.current;

        setMountedTabMap((prev) => ({ ...prev, [baseTab]: true }));

        const deferredTabs = PROFILE_TAB_IDS.filter((tabId) => tabId !== baseTab);
        deferredTabs.forEach((tabId, index) => {
            const delayMs = 140 + (index * 120);
            const timerId = window.setTimeout(() => {
                if (token !== tabPreloadTokenRef.current) return;
                if ('requestIdleCallback' in window) {
                    const idleId = window.requestIdleCallback(() => {
                        if (token !== tabPreloadTokenRef.current) return;
                        setMountedTabMap((prev) => (prev[tabId] ? prev : { ...prev, [tabId]: true }));
                    }, { timeout: 280 + (index * 100) });
                    tabPreloadIdleIdsRef.current.push(idleId);
                    return;
                }
                const rafId = window.requestAnimationFrame(() => {
                    if (token !== tabPreloadTokenRef.current) return;
                    setMountedTabMap((prev) => (prev[tabId] ? prev : { ...prev, [tabId]: true }));
                });
                tabPreloadRafIdsRef.current.push(rafId);
            }, delayMs);
            tabPreloadDeferredTimerIdsRef.current.push(timerId);
        });
    }, [cancelTabPreload]);

    const scheduleTabChange = useCallback((nextTabId) => {
        const next = normalizeProfileTabId(nextTabId);
        if (!next || next === activeTab) return;
        setMountedTabMap((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
        pendingTabRef.current = next;
        if (tabSwitchRafRef.current) return;
        tabSwitchRafRef.current = window.requestAnimationFrame(() => {
            tabSwitchRafRef.current = null;
            const resolved = pendingTabRef.current;
            pendingTabRef.current = '';
            if (!resolved) return;
            setActiveTab(resolved);
            if (typeof onTabChange === 'function') onTabChange(resolved);
        });
    }, [activeTab, onTabChange]);

    const navItems = [
        { id: 'profile', label: t('profile.sectionBasicInfo'), shortLabel: t('profile.tabShortProfile'), icon: User, color: 'bg-slate-600 dark:bg-zinc-600' },
        { id: 'security', label: t('profile.sectionSecurity'), shortLabel: t('profile.tabShortSecurity'), icon: Shield, color: 'bg-emerald-500 dark:bg-emerald-600' },
        { id: 'preferences', label: t('profile.sectionPreferences'), shortLabel: t('profile.tabShortPreferences'), icon: MessageCircle, color: 'bg-blue-500' },
        { id: 'contacts', label: t('profile.sectionQuickContacts'), shortLabel: t('profile.tabShortContacts'), icon: Users, color: 'bg-indigo-500' },
    ];
    const settingsSearchCatalog = useMemo(() => {
        void selectedLocale;
        return buildSettingsSearchCatalog(t);
    }, [selectedLocale]);

    const closeMobileSearchOverlay = useCallback(() => {
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        if (activeEl && mobileSearchOverlayRef.current?.contains(activeEl) && typeof activeEl.blur === 'function') {
            activeEl.blur();
        }
        setIsMobileSearchActive(false);
        setSearchQuery('');
        if (mobileSearchOpenButtonRef.current?.focus) {
            window.setTimeout(() => {
                mobileSearchOpenButtonRef.current.focus();
            }, 0);
        }
    }, []);

    const loadMediaQuota = useCallback(async () => {
        try {
            const resp = await fetch('/api/media/quota', { credentials: 'include' });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok || !payload?.quota) return;
            setMediaQuota(payload.quota);
        } catch {
            // Storage usage is auxiliary; keep the last visible value on failure.
        }
    }, []);

    const handleSearchResultClick = useCallback((tabId) => {
        scheduleTabChange(tabId);
        setSearchQuery('');
        setIsDesktopSearchFocused(false);
        closeMobileSearchOverlay();
    }, [closeMobileSearchOverlay, scheduleTabChange]);

    const handleBackToLobby = useCallback(() => {
        if (typeof onBack !== 'function') return;
        if (typeof window !== 'undefined') {
            window.requestAnimationFrame(() => onBack());
            return;
        }
        onBack();
    }, [onBack]);

    const handleHardwareAccelerationChange = useCallback(() => {
        if (gpuVideoRenderingSupport?.canUseGpuCompositing === false) return;
        setHardwareAcceleration((current) => writeGpuVideoRenderingPreference(!current));
    }, [gpuVideoRenderingSupport]);

    useEffect(() => {
        let cancelled = false;
        detectGpuVideoRenderingSupport().then((support) => {
            if (cancelled) return;
            setGpuVideoRenderingSupport(support);
            if (!support.canUseGpuCompositing) {
                setHardwareAcceleration(writeGpuVideoRenderingPreference(false));
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const next = normalizeProfileTabId(initialTab);
        if (next === activeTab) return;
        setActiveTab(next);
    }, [activeTab, initialTab]);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (searchRef.current && !searchRef.current.contains(event.target)) {
                setIsDesktopSearchFocused(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        const terms = resolveSettingsSearchTerms(searchQuery);
        if (terms.length === 0) {
            setSearchResults([]);
            return;
        }
        const results = settingsSearchCatalog.filter((item) => {
            const title = String(item.title || '').toLowerCase();
            const desc = String(item.desc || '').toLowerCase();
            const keywords = Array.isArray(item.keywords) ? item.keywords.map((kw) => String(kw).toLowerCase()) : [];
            return terms.some((term) => title.includes(term) || desc.includes(term) || keywords.some((kw) => kw.includes(term)));
        });
        setSearchResults(results);
    }, [searchQuery, settingsSearchCatalog]);

    useEffect(() => {
        if (!isMobileSearchActive || !mobileInputRef.current) return;
        mobileInputRef.current.focus();
    }, [isMobileSearchActive]);

    useEffect(() => {
        setNickname(user.name);
        setEmailInput(user.email);
    }, [user.email, user.name]);

    useEffect(() => {
        if (!isOpen) return;
        resetMainScrollTop();
    }, [activeTab, isOpen, resetMainScrollTop]);

    useEffect(() => {
        if (isOpen) {
            if (closeScrollResetTimerRef.current) {
                window.clearTimeout(closeScrollResetTimerRef.current);
                closeScrollResetTimerRef.current = null;
            }
            return undefined;
        }

        if (closeScrollResetTimerRef.current) {
            window.clearTimeout(closeScrollResetTimerRef.current);
        }
        closeScrollResetTimerRef.current = window.setTimeout(() => {
            resetMainScrollTop();
            closeScrollResetTimerRef.current = null;
        }, Math.max(0, cleanupDelayMs + PROFILE_SCROLL_RESET_AFTER_CLOSE_MS));

        return () => {
            if (closeScrollResetTimerRef.current) {
                window.clearTimeout(closeScrollResetTimerRef.current);
                closeScrollResetTimerRef.current = null;
            }
        };
    }, [cleanupDelayMs, isOpen, resetMainScrollTop]);

    useEffect(() => {
        let alive = true;
        const initialUser = initialUserRef.current;
        const updateUser = onUpdateUserRef.current;
        const seededMeta = initialProfileMetaRef.current && typeof initialProfileMetaRef.current === 'object' ? initialProfileMetaRef.current : null;
        if (seededMeta) {
            const cacheUser = { id: seededMeta.id || initialUser.id, email: seededMeta.email || initialUser.email };
            const cacheKey = getProfileMetaCacheKey(cacheUser);
            if (cacheKey) {
                PROFILE_META_CACHE.set(cacheKey, seededMeta);
            }
            writeCachedProfileMeta(cacheUser, seededMeta);
            clearProfileMetaCacheDirty(cacheUser);
            setProfileMeta(seededMeta);
            setIsTwoFactorEnabled(Boolean(seededMeta.twoFactorEnabled));
            if (!seededMeta.twoFactorEnabled) setBackupCodes([]);
            const nextName = seededMeta.displayName || initialUser.name;
            setNickname(nextName);
            setEmailInput(seededMeta.email || initialUser.email);
            updateUser({
                ...initialUser,
                name: nextName,
                email: seededMeta.email || initialUser.email,
                avatarUrl: seededMeta.avatarUrl || initialUser.avatarUrl || null,
                locale: seededMeta.locale || initialUser.locale || null,
            });
            setIsLoadingProfile(false);
            return () => {
                alive = false;
            };
        }
        const cacheKey = getProfileMetaCacheKey(initialUser);
        const memoryCachedMeta = cacheKey ? PROFILE_META_CACHE.get(cacheKey) : null;
        const localCachedMeta = readCachedProfileMeta(initialUser);
        const cachedMeta = memoryCachedMeta || localCachedMeta;
        const shouldForceRefresh = isProfileMetaCacheDirty(initialUser);

        if (cachedMeta) {
            setProfileMeta(cachedMeta);
            setIsTwoFactorEnabled(Boolean(cachedMeta.twoFactorEnabled));
            if (!cachedMeta.twoFactorEnabled) setBackupCodes([]);
            const nextName = cachedMeta.displayName || initialUser.name;
            setNickname(nextName);
            setEmailInput(cachedMeta.email || initialUser.email);
            updateUser({
                ...initialUser,
                name: nextName,
                email: cachedMeta.email || initialUser.email,
                avatarUrl: cachedMeta.avatarUrl || initialUser.avatarUrl || null,
                locale: cachedMeta.locale || initialUser.locale || null,
            });
            setIsLoadingProfile(false);
        }

        if (cachedMeta && !shouldForceRefresh) {
            setIsLoadingProfile(false);
            return () => {
                alive = false;
            };
        }

        const loadProfile = async () => {
            setIsLoadingProfile(true);
            try {
                const resp = await fetch('/api/auth/profile', { credentials: 'include' });
                const payload = await resp.json().catch(() => ({}));
                if (!alive) return;
                if (!resp.ok || !payload?.ok || !payload?.user) {
                    if (!cachedMeta) {
                        setProfileMeta(null);
                        setIsTwoFactorEnabled(false);
                        setBackupCodes([]);
                    }
                    return;
                }

                const nextUser = payload.user;
                setProfileMeta(nextUser);
                if (nextUser.locale) {
                    const ok = setLocale(nextUser.locale, { persist: true });
                    if (ok) setSelectedLocale(nextUser.locale);
                }
                setIsTwoFactorEnabled(Boolean(nextUser.twoFactorEnabled));
                if (!nextUser.twoFactorEnabled) setBackupCodes([]);
                if (cacheKey) {
                    PROFILE_META_CACHE.set(cacheKey, nextUser);
                }
                writeCachedProfileMeta(initialUser, nextUser);
                clearProfileMetaCacheDirty(initialUser);

                const nextName = nextUser.displayName || initialUser.name;
                setNickname(nextName);
                setEmailInput(nextUser.email || initialUser.email);
                updateUser({
                    ...initialUser,
                    name: nextName,
                    email: nextUser.email || initialUser.email,
                    avatarUrl: nextUser.avatarUrl || initialUser.avatarUrl || null,
                    locale: nextUser.locale || initialUser.locale || null,
                });
            } finally {
                if (alive) setIsLoadingProfile(false);
            }
        };

        loadProfile();
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        loadMediaQuota();
    }, [loadMediaQuota]);

    useEffect(() => {
        const handleProfileUpdated = (event) => {
            const nextProfile = event?.detail || {};
            const nextUserId = String(nextProfile.userId || nextProfile.id || '').trim();
            const currentUserId = String(user?.id || '').trim();
            if (!nextUserId || nextUserId !== currentUserId) return;
            const nextName = nextProfile.displayName || nextProfile.name || user.name;
            const nextEmail = nextProfile.email || user.email;
            const nextMeta = {
                ...(profileMeta || {}),
                id: nextUserId,
                publicId: nextProfile.publicId || profileMeta?.publicId || user.publicId || null,
                email: nextEmail,
                displayName: nextName,
                avatarUrl: nextProfile.avatarUrl || null,
                locale: nextProfile.locale || profileMeta?.locale || user.locale || null,
            };
            setProfileMeta(nextMeta);
            setNickname(nextName);
            setEmailInput(nextEmail);
            if (nextMeta.locale) setSelectedLocale(nextMeta.locale);
            if (avatarPreviewUrl) {
                URL.revokeObjectURL(avatarPreviewUrl);
                setAvatarPreviewUrl(null);
            }
            setAvatarFile(null);
            writeCachedProfileMeta(user, nextMeta);
            clearProfileMetaCacheDirty(user);
        };
        window.addEventListener(PROFILE_UPDATED_EVENT, handleProfileUpdated);
        return () => window.removeEventListener(PROFILE_UPDATED_EVENT, handleProfileUpdated);
    }, [avatarPreviewUrl, profileMeta, user]);

    useEffect(() => {
        const handleMediaChanged = (event) => {
            const eventType = String(event?.detail?.type || '').trim();
            if (eventType === 'media.updated' || eventType === 'media.deleted') {
                loadMediaQuota();
            }
        };
        window.addEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
        return () => window.removeEventListener(MEDIA_CHANGED_EVENT, handleMediaChanged);
    }, [loadMediaQuota]);

    const displayName = nickname.trim() || profileMeta?.displayName || user.name || t('profile.fallbackDisplayName');
    const email = profileMeta?.email || user.email;
    const profileId = profileMeta?.publicId || user.publicId;
    const avatarUrl = avatarPreviewUrl || user.avatarUrl || null;
    const userStatus = profileMeta?.status;
    const hasPassword = profileMeta?.hasPassword ?? true;
    const storageUsedBytes = Math.max(0, Number(mediaQuota?.usedStorageBytes || 0));
    const storageTotalBytes = Math.max(1, Number(mediaQuota?.maxStorageBytes || DEFAULT_PROFILE_STORAGE_QUOTA_BYTES));
    const storageFreeBytes = Math.max(storageTotalBytes - storageUsedBytes, 0);
    const storagePercent = Math.min(100, Math.max(0, Number(mediaQuota?.storagePercent ?? ((storageUsedBytes / storageTotalBytes) * 100))));
    const storageUsedDisplay = formatStorageAmount(storageUsedBytes);
    const storageTotalGb = storageTotalBytes / (1024 * 1024 * 1024);
    const storageFreeDisplay = formatStorageAmount(storageFreeBytes);
    const originalDisplayName = (profileMeta?.displayName || user.name).trim();
    const originalEmail = (profileMeta?.email || user.email).trim().toLowerCase();
    const normalizedEmailInput = emailInput.trim().toLowerCase();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const hasNicknameChange = Boolean(nickname.trim()) && nickname.trim() !== originalDisplayName;
    const hasEmailChange = normalizedEmailInput !== originalEmail;
    const isEmailInputValid = !hasEmailChange || emailPattern.test(normalizedEmailInput);
    const isNewEmailValid = hasEmailChange && isEmailInputValid;
    const isVerifyCodeValid = /^\d{6}$/.test(verifyCode.trim());
    const hasAvatarChange = Boolean(avatarFile);
    const hasProfileSubmitChanges = hasNicknameChange || hasEmailChange || hasAvatarChange;

    const canSave = useMemo(() => {
        if (saveState !== 'idle' || isLoadingProfile) return false;
        if (!nickname.trim()) return false;
        if (!isEmailInputValid) return false;
        if (!hasProfileSubmitChanges) return false;
        if (hasEmailChange && !isVerifyCodeValid) return false;
        return true;
    }, [hasEmailChange, hasProfileSubmitChanges, isEmailInputValid, isLoadingProfile, isVerifyCodeValid, nickname, saveState]);

    const canPasswordSave = useMemo(() => {
        if (passwordSaveState === 'saving' || isLoadingProfile) return false;
        if (hasPassword) return Boolean(oldPassword && newPassword && confirmPassword);
        return Boolean(newPassword && confirmPassword);
    }, [confirmPassword, hasPassword, isLoadingProfile, newPassword, oldPassword, passwordSaveState]);

    const localeOptions = [
        { value: 'zh-CN', label: t('profile.localeZhCN') },
        { value: 'zh-TW', label: t('profile.localeZhTW') },
        { value: 'en', label: t('profile.localeEn') },
        { value: 'ja', label: t('profile.localeJa') },
        { value: 'ko', label: t('profile.localeKo') },
    ];
    const localeIconMap = {
        'zh-CN': '🇨🇳',
        'zh-TW': '🇹🇼',
        en: '🇺🇸',
        ja: '🇯🇵',
        ko: '🇰🇷',
    };
    const emailAlreadyRegisteredLabelMap = {
        'zh-CN': '邮箱已被注册',
        'zh-TW': '郵箱已被註冊',
        en: 'Email in use',
        ja: '登録済み',
        ko: '이미 등록됨',
    };
    const selectedLocaleOption = localeOptions.find((item) => item.value === selectedLocale) || localeOptions[0];
    const emailCodeCooldownLeftSec = Math.max(0, Math.ceil((emailCodeCooldownUntil - nowMs) / 1000));
    const isEmailCodeCoolingDown = emailCodeCooldownLeftSec > 0;
    const shouldShowEmailCodeInput = isNewEmailValid && emailCodeTargetEmail === normalizedEmailInput;

    useEffect(() => {
        const wasOpen = prevIsOpenRef.current;
        let timer = null;

        const clearFormState = () => {
            const resetName = profileMeta?.displayName || user.name;
            const resetEmail = profileMeta?.email || user.email;

            setActiveTab(normalizeProfileTabId(initialTab));
            setSearchQuery('');
            setIsDesktopSearchFocused(false);
            setIsMobileSearchActive(false);
            setIsProfileLangDropdownOpen(false);

            setNickname(resetName);
            setEmailInput(resetEmail);
            setVerifyCode('');
            setOldPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setShowOldPassword(false);
            setShowNewPassword(false);
            setShowConfirmPassword(false);
            setAvatarFile(null);
            setAvatarPreviewUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return null;
            });
            setSaveState('idle');
            setSaveErrors([]);
            setShowSaveErrorModal(false);
            setIsSaveErrorModalClosing(false);
            setShowTwoFactorDisableModal(false);
            setIsTwoFactorDisableModalClosing(false);
            setTwoFactorDisableCode('');
            setTwoFactorDisableError('');
            setShowBackupCodesErrorModal(false);
            setIsBackupCodesErrorModalClosing(false);
            setCopyState('idle');
            setPasswordSaveState('idle');
            setEmailCodeTargetEmail('');
            persistEmailCodeTargetEmail('');

            if (saveStateTimerRef.current) {
                window.clearTimeout(saveStateTimerRef.current);
                saveStateTimerRef.current = null;
            }
            if (copyStateTimerRef.current) {
                window.clearTimeout(copyStateTimerRef.current);
                copyStateTimerRef.current = null;
            }
            if (passwordSaveStateTimerRef.current) {
                window.clearTimeout(passwordSaveStateTimerRef.current);
                passwordSaveStateTimerRef.current = null;
            }
        };

        if (!wasOpen && isOpen) {
            cancelTabPreload();
            setMountedTabMap({ ...createMountedTabMap(false), [normalizeProfileTabId(initialTab)]: true });
            const token = ++tabPreloadTokenRef.current;
            tabPreloadStartTimerRef.current = window.setTimeout(() => {
                tabPreloadStartTimerRef.current = null;
                if (token !== tabPreloadTokenRef.current) return;
                scheduleTabPreload(initialTab);
            }, PROFILE_TAB_PRELOAD_START_DELAY_MS);
        } else if (wasOpen && !isOpen) {
            cancelTabPreload();
            setMountedTabMap(createMountedTabMap(false));
            timer = window.setTimeout(() => {
                clearFormState();
            }, cleanupDelayMs);
        }

        prevIsOpenRef.current = isOpen;

        return () => {
            if (timer) window.clearTimeout(timer);
        };
    }, [cancelTabPreload, cleanupDelayMs, initialTab, isOpen, onUpdateUser, profileMeta?.avatarUrl, profileMeta?.displayName, profileMeta?.email, profileMeta?.locale, scheduleTabPreload, user]);

    useEffect(() => {
        if (!isOpen || emailCodeCooldownUntil <= 0) return undefined;
        const tick = () => setNowMs(Date.now());
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [emailCodeCooldownUntil, isOpen]);

    useEffect(() => {
        return () => {
            cancelTabPreload();
            if (tabSwitchRafRef.current) {
                window.cancelAnimationFrame(tabSwitchRafRef.current);
                tabSwitchRafRef.current = null;
            }
        };
    }, [cancelTabPreload]);

    useEffect(() => {
        if (!isTwoFactorEnabled || backupCodes.length > 0) return undefined;
        let alive = true;
        const loadBackupCodes = async () => {
            try {
                const resp = await fetch('/api/auth/profile/2fa/recovery/list', {
                    method: 'GET',
                    credentials: 'include',
                });
                const payload = await resp.json().catch(() => ({}));
                if (!alive) return;
                if (!resp.ok || !payload?.ok || !Array.isArray(payload?.recoveryCodes)) return;
                setBackupCodes(payload.recoveryCodes.filter(Boolean));
            } catch {
                // ignore auto-load failure, user can regenerate if needed
            }
        };
        loadBackupCodes();
        return () => {
            alive = false;
        };
    }, [isTwoFactorEnabled, backupCodes.length]);

    useEffect(() => {
        if (emailCodeCooldownUntil <= 0) return;
        if (emailCodeCooldownUntil <= Date.now()) {
            setEmailCodeCooldownUntil(0);
            persistEmailCodeCooldownUntil(0);
        }
    }, [emailCodeCooldownUntil, nowMs]);

    const handleLocaleChange = async (nextLocale) => {
        const prevLocale = selectedLocale;
        if (!nextLocale || nextLocale === prevLocale) return;

        const ok = setLocale(nextLocale, { persist: true });
        if (!ok) {
            openSaveErrorModal([t('profile.changeLanguageFailed')], { centered: true });
            return;
        }
        setSelectedLocale(nextLocale);

        try {
            markProfileMetaCacheDirty(user, 'locale-change');
            const resp = await fetch('/api/auth/profile', {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    locale: nextLocale,
                    theme: isDark ? 'dark' : 'light',
                }),
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok || !payload?.user) {
                setLocale(prevLocale, { persist: true });
                setSelectedLocale(prevLocale);
                clearProfileMetaCacheDirty(user);
                openSaveErrorModal([t('profile.changeLanguageFailed')], { centered: true });
                return;
            }

            const savedUser = payload.user;
            setProfileMeta((prev) => {
                const next = prev ? { ...prev, ...savedUser } : savedUser;
                const cacheKey = getProfileMetaCacheKey(user);
                if (cacheKey && next) {
                    PROFILE_META_CACHE.set(cacheKey, next);
                    writeCachedProfileMeta(user, next);
                }
                return next;
            });
            clearProfileMetaCacheDirty(user);
            onUpdateUser({
                ...user,
                name: savedUser.displayName || user.name,
                email: savedUser.email || user.email,
                avatarUrl: savedUser.avatarUrl || user.avatarUrl || null,
                locale: savedUser.locale || nextLocale,
            });
        } catch {
            setLocale(prevLocale, { persist: true });
            setSelectedLocale(prevLocale);
            clearProfileMetaCacheDirty(user);
            openSaveErrorModal([t('profile.changeLanguageFailed')], { centered: true });
        }
    };

    const handleAvatarSelect = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type?.startsWith('image/')) return;

        const nextPreviewUrl = URL.createObjectURL(file);
        if (avatarPreviewUrl) {
            URL.revokeObjectURL(avatarPreviewUrl);
        }
        setAvatarPreviewUrl(nextPreviewUrl);
        setAvatarFile(file);
        event.target.value = '';
    };

    useEffect(() => {
        return () => {
            if (saveStateTimerRef.current) {
                window.clearTimeout(saveStateTimerRef.current);
            }
            if (copyStateTimerRef.current) {
                window.clearTimeout(copyStateTimerRef.current);
            }
            if (avatarPreviewUrl) {
                URL.revokeObjectURL(avatarPreviewUrl);
            }
            if (closeScrollResetTimerRef.current) {
                window.clearTimeout(closeScrollResetTimerRef.current);
                closeScrollResetTimerRef.current = null;
            }
        };
    }, [avatarPreviewUrl]);

    useEffect(() => {
        if (saveState !== 'success' && saveState !== 'error') return undefined;
        if (saveStateTimerRef.current) {
            window.clearTimeout(saveStateTimerRef.current);
        }
        saveStateTimerRef.current = window.setTimeout(() => {
            setSaveState('idle');
            saveStateTimerRef.current = null;
        }, SAVE_RESULT_SHOW_MS);

        return () => {
            if (saveStateTimerRef.current) {
                window.clearTimeout(saveStateTimerRef.current);
                saveStateTimerRef.current = null;
            }
        };
    }, [saveState]);

    useEffect(() => {
        if (!isNewEmailValid) {
            setVerifyCode('');
            setEmailCodeTargetEmail('');
            persistEmailCodeTargetEmail('');
            setIsEmailAlreadyRegistered(false);
            return;
        }
        if (emailCodeTargetEmail && emailCodeTargetEmail !== normalizedEmailInput) {
            setVerifyCode('');
        }
        setIsEmailAlreadyRegistered(false);
    }, [emailCodeTargetEmail, isNewEmailValid, normalizedEmailInput]);

    useEffect(() => {
        if (!isProfileLangDropdownOpen) return undefined;
        const handlePointerDown = (event) => {
            if (!profileLangDropdownRef.current?.contains(event.target)) {
                setIsProfileLangDropdownOpen(false);
            }
        };
        const handleEscape = (event) => {
            if (event.key === 'Escape') setIsProfileLangDropdownOpen(false);
        };
        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [isProfileLangDropdownOpen]);

    const openSaveErrorModal = (items, options = {}) => {
        const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
        if (nextItems.length === 0) return;
        setSaveErrors(nextItems);
        setSaveErrorDisplay(options.centered ? 'center' : 'list');
        setIsSaveErrorModalClosing(false);
        setShowSaveErrorModal(true);
    };

    const closeSaveErrorModal = () => {
        if (isSaveErrorModalClosing) return;
        setIsSaveErrorModalClosing(true);
        window.setTimeout(() => {
            setShowSaveErrorModal(false);
            setIsSaveErrorModalClosing(false);
            setSaveErrors([]);
            setSaveErrorDisplay('list');
        }, MODAL_CLOSE_MS);
    };

    const closeTwoFactorBlockedModal = () => {
        if (isTwoFactorBlockedModalClosing) return;
        setIsTwoFactorBlockedModalClosing(true);
        window.setTimeout(() => {
            setShowTwoFactorBlockedModal(false);
            setIsTwoFactorBlockedModalClosing(false);
        }, MODAL_CLOSE_MS);
    };

    const openTwoFactorSetupModal = () => {
        setIsTwoFactorSetupModalClosing(false);
        setShowTwoFactorSetupModal(true);
    };

    const closeTwoFactorSetupModal = () => {
        if (isTwoFactorSetupModalClosing) return;
        setIsTwoFactorSetupModalClosing(true);
        window.setTimeout(() => {
            setShowTwoFactorSetupModal(false);
            setIsTwoFactorSetupModalClosing(false);
        }, MODAL_CLOSE_MS);
    };

    const completeTwoFactorSetup = ({ recoveryCodes = [] } = {}) => {
        setIsTwoFactorEnabled(true);
        setBackupCodes(Array.isArray(recoveryCodes) ? recoveryCodes.filter(Boolean) : []);
        setProfileMeta((prev) => {
            const next = prev ? { ...prev, twoFactorEnabled: true } : prev;
            const cacheKey = getProfileMetaCacheKey(user);
            if (cacheKey && next) {
                PROFILE_META_CACHE.set(cacheKey, next);
                writeCachedProfileMeta(user, next);
                clearProfileMetaCacheDirty(user);
            }
            return next;
        });
        closeTwoFactorSetupModal();
    };

    const openTwoFactorDisableModal = () => {
        if (isTwoFactorProcessing) return;
        setTwoFactorDisableCode('');
        setTwoFactorDisableError('');
        setIsTwoFactorDisableModalClosing(false);
        setShowTwoFactorDisableModal(true);
    };

    const closeTwoFactorDisableModal = () => {
        if (isTwoFactorDisableModalClosing) return;
        setIsTwoFactorDisableModalClosing(true);
        window.setTimeout(() => {
            setShowTwoFactorDisableModal(false);
            setIsTwoFactorDisableModalClosing(false);
            setTwoFactorDisableCode('');
            setTwoFactorDisableError('');
        }, MODAL_CLOSE_MS);
    };

    const openBackupCodesModal = () => {
        if (!isTwoFactorEnabled || !backupCodes.length) return;
        setIsBackupCodesModalClosing(false);
        setShowBackupCodesModal(true);
    };

    const closeBackupCodesModal = () => {
        if (isBackupCodesModalClosing) return;
        setIsBackupCodesModalClosing(true);
        window.setTimeout(() => {
            setShowBackupCodesModal(false);
            setIsBackupCodesModalClosing(false);
        }, MODAL_CLOSE_MS);
    };

    const handleCopyBackupCodes = async () => {
        if (!backupCodes.length) return;
        try {
            await navigator.clipboard.writeText(backupCodes.join('\n'));
            setBackupCodesCopied(true);
            window.setTimeout(() => setBackupCodesCopied(false), 2000);
        } catch {
            setBackupCodesCopied(false);
        }
    };

    const handleDownloadBackupCodes = () => {
        if (!backupCodes.length) return;
        const text = backupCodes.join('\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'swaparty-2fa-backup-codes.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const openBackupCodesErrorModal = () => {
        setIsBackupCodesErrorModalClosing(false);
        setShowBackupCodesErrorModal(true);
    };

    const closeBackupCodesErrorModal = () => {
        if (isBackupCodesErrorModalClosing) return;
        setIsBackupCodesErrorModalClosing(true);
        window.setTimeout(() => {
            setShowBackupCodesErrorModal(false);
            setIsBackupCodesErrorModalClosing(false);
        }, MODAL_CLOSE_MS);
    };

    const openEmailErrorModal = (message) => {
        setEmailErrorText(String(message || t('profile.emailChangeSendFailed')));
        setIsEmailErrorModalClosing(false);
        setShowEmailErrorModal(true);
    };

    const closeEmailErrorModal = () => {
        if (isEmailErrorModalClosing) return;
        setIsEmailErrorModalClosing(true);
        window.setTimeout(() => {
            setShowEmailErrorModal(false);
            setIsEmailErrorModalClosing(false);
            setEmailErrorText('');
        }, MODAL_CLOSE_MS);
    };

    const handleRegenerateBackupCodes = async () => {
        if (backupCodesRegenerating || isTwoFactorProcessing || !isTwoFactorEnabled) return;
        setBackupCodesRegenerating(true);
        try {
            const resp = await fetch('/api/auth/profile/2fa/recovery/regenerate', {
                method: 'POST',
                credentials: 'include',
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok || !Array.isArray(payload?.recoveryCodes)) {
                openBackupCodesErrorModal();
                return;
            }
            const nextCodes = payload.recoveryCodes.filter(Boolean);
            setBackupCodes(nextCodes);
            if (nextCodes.length) openBackupCodesModal();
        } catch {
            openBackupCodesErrorModal();
        } finally {
            setBackupCodesRegenerating(false);
        }
    };

    const handleDisableTwoFactorConfirm = async () => {
        if (isTwoFactorProcessing) return;
        const code = twoFactorDisableCode.trim();
        if (!/^\d{6}$/.test(code)) {
            setTwoFactorDisableError(t('profile.twoFactorCodeInvalid'));
            return;
        }

        setIsTwoFactorProcessing(true);
        setTwoFactorDisableError('');
        try {
            const resp = await fetch('/api/auth/profile/2fa/disable', {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok) {
                setTwoFactorDisableError(t('profile.twoFactorCodeMismatch'));
                return;
            }
            setIsTwoFactorEnabled(false);
            setBackupCodes([]);
            setShowBackupCodesModal(false);
            setIsBackupCodesModalClosing(false);
            setProfileMeta((prev) => {
                const next = prev ? { ...prev, twoFactorEnabled: false } : prev;
                const cacheKey = getProfileMetaCacheKey(user);
                if (cacheKey && next) {
                    PROFILE_META_CACHE.set(cacheKey, next);
                    writeCachedProfileMeta(user, next);
                    clearProfileMetaCacheDirty(user);
                }
                return next;
            });
            closeTwoFactorDisableModal();
        } catch {
            setTwoFactorDisableError(t('profile.twoFactorCodeMismatch'));
        } finally {
            setIsTwoFactorProcessing(false);
        }
    };

    const handleTwoFactorToggle = async () => {
        if (isTwoFactorProcessing) return;
        if (!isTwoFactorEnabled && !hasPassword) {
            setIsTwoFactorBlockedModalClosing(false);
            setShowTwoFactorBlockedModal(true);
            return;
        }
        if (!isTwoFactorEnabled) {
            openTwoFactorSetupModal();
            return;
        }
        openTwoFactorDisableModal();
    };

    const handleSendEmailCode = async () => {
        if (!hasEmailChange || isSendingCode || isEmailCodeCoolingDown) return;
        if (!isEmailInputValid) {
            openEmailErrorModal(t('profile.emailChangeSendFailed'));
            return;
        }
        setIsEmailAlreadyRegistered(false);
        setIsSendingCode(true);
        try {
            const resp = await fetch('/api/auth/email-change/send-code', {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    newEmail: normalizedEmailInput,
                    locale: selectedLocale,
                }),
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok) {
                if (isEmailAlreadyRegisteredPayload(payload)) {
                    setIsEmailAlreadyRegistered(true);
                    openEmailErrorModal(t('profile.emailAlreadyRegisteredHint'));
                    return;
                }
                openEmailErrorModal(t('profile.emailChangeSendFailed'));
                return;
            }
            const cooldownSec = Number(payload?.cooldownSec || payload?.retryAfterSec || EMAIL_CODE_COOLDOWN_SEC);
            const safeCooldownSec = Number.isFinite(cooldownSec) && cooldownSec > 0 ? cooldownSec : EMAIL_CODE_COOLDOWN_SEC;
            const nowAtSend = Date.now();
            const nextUntil = nowAtSend + safeCooldownSec * 1000;
            setNowMs(nowAtSend);
            setEmailCodeCooldownUntil(nextUntil);
            persistEmailCodeCooldownUntil(nextUntil);
            setEmailCodeTargetEmail(normalizedEmailInput);
            persistEmailCodeTargetEmail(normalizedEmailInput);
            setIsEmailAlreadyRegistered(false);
        } catch {
            openEmailErrorModal(t('profile.emailChangeSendFailed'));
        } finally {
            setIsSendingCode(false);
        }
    };

    const handleCopyProfileId = async () => {
        if (!profileId || profileId === '-') return;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(String(profileId));
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = String(profileId);
                textArea.setAttribute('readonly', '');
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            setCopyState('success');
            if (copyStateTimerRef.current) window.clearTimeout(copyStateTimerRef.current);
            copyStateTimerRef.current = window.setTimeout(() => {
                setCopyState('idle');
                copyStateTimerRef.current = null;
            }, COPY_RESULT_SHOW_MS);
        } catch {
            setCopyState('error');
            if (copyStateTimerRef.current) window.clearTimeout(copyStateTimerRef.current);
            copyStateTimerRef.current = window.setTimeout(() => {
                setCopyState('idle');
                copyStateTimerRef.current = null;
            }, COPY_RESULT_SHOW_MS);
        }
    };

    const clearPasswordInputs = () => {
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowOldPassword(false);
        setShowNewPassword(false);
        setShowConfirmPassword(false);
    };

    const markPasswordButtonResult = (state) => {
        if (passwordSaveStateTimerRef.current) {
            window.clearTimeout(passwordSaveStateTimerRef.current);
            passwordSaveStateTimerRef.current = null;
        }
        setPasswordSaveState(state);
        passwordSaveStateTimerRef.current = window.setTimeout(() => {
            setPasswordSaveState('idle');
            passwordSaveStateTimerRef.current = null;
        }, SAVE_RESULT_SHOW_MS);
    };

    const handlePasswordCancel = () => {
        if (passwordSaveState === 'saving') return;
        if (passwordSaveStateTimerRef.current) {
            window.clearTimeout(passwordSaveStateTimerRef.current);
            passwordSaveStateTimerRef.current = null;
        }
        setPasswordSaveState('idle');
        clearPasswordInputs();
    };

    const handlePasswordSave = async () => {
        if (!canPasswordSave) return;

        if (passwordSaveStateTimerRef.current) {
            window.clearTimeout(passwordSaveStateTimerRef.current);
            passwordSaveStateTimerRef.current = null;
        }
        setPasswordSaveState('saving');
        const saveStartedAt = Date.now();

        const waitForPendingMin = async () => {
            const elapsed = Date.now() - saveStartedAt;
            const rest = Math.max(0, SAVE_PENDING_MIN_MS - elapsed);
            if (rest > 0) {
                await new Promise((resolve) => {
                    window.setTimeout(resolve, rest);
                });
            }
        };

        const showResultAndReset = async (nextState) => {
            await waitForPendingMin();
            setPasswordSaveState(nextState);
            passwordSaveStateTimerRef.current = window.setTimeout(() => {
                setPasswordSaveState('idle');
                passwordSaveStateTimerRef.current = null;
            }, SAVE_RESULT_SHOW_MS);
        };

        try {
            markProfileMetaCacheDirty(user, 'password-save');
            const payloadBody = {};
            if (hasPassword) payloadBody.oldPassword = oldPassword;
            payloadBody.newPassword = newPassword;
            payloadBody.confirmPassword = confirmPassword;

            const resp = await fetch('/api/auth/profile/password', {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payloadBody),
            });
            const payload = await resp.json().catch(() => ({}));

            if (!resp.ok || !payload?.ok || !payload?.user) {
                const passwordOnlyFieldErrorItems = sortAndMapPasswordErrors(payload?.fieldErrors);
                const nextErrorItems = passwordOnlyFieldErrorItems.length > 0
                    ? passwordOnlyFieldErrorItems
                    : [extractErrorMessage(payload, t('profile.errPasswordFailed'))];
                await showResultAndReset('error');
                openSaveErrorModal(nextErrorItems, { centered: true });
                return;
            }

            const savedUser = payload.user;
            setProfileMeta(savedUser);
            if (savedUser?.locale) {
                const ok = setLocale(savedUser.locale, { persist: true });
                if (ok) setSelectedLocale(savedUser.locale);
            }
            setIsTwoFactorEnabled(Boolean(savedUser.twoFactorEnabled));
            if (!savedUser.twoFactorEnabled) setBackupCodes([]);
            {
                const cacheKey = getProfileMetaCacheKey(user);
                if (cacheKey) PROFILE_META_CACHE.set(cacheKey, savedUser);
            }
            writeCachedProfileMeta(user, savedUser);
            clearProfileMetaCacheDirty(user);
            onUpdateUser({
                ...user,
                name: savedUser.displayName || nickname.trim(),
                email: savedUser.email || user.email,
                avatarUrl: savedUser.avatarUrl || user.avatarUrl || null,
                locale: savedUser.locale || user.locale || null,
            });

            clearPasswordInputs();
            await showResultAndReset('success');
        } catch {
            await showResultAndReset('error');
            openSaveErrorModal([t('profile.errNetworkRequestFailed')], { centered: true });
        }
    };

    const handleSave = async () => {
        if (!canSave || !hasProfileSubmitChanges) return;
        if (saveStateTimerRef.current) {
            window.clearTimeout(saveStateTimerRef.current);
            saveStateTimerRef.current = null;
        }
        setSaveState('saving');
        const saveStartedAt = Date.now();

        const waitForPendingMin = async () => {
            const elapsed = Date.now() - saveStartedAt;
            const rest = Math.max(0, SAVE_PENDING_MIN_MS - elapsed);
            if (rest > 0) {
                await new Promise((resolve) => {
                    window.setTimeout(resolve, rest);
                });
            }
        };

        const showResultAndReset = async (nextState) => {
            await waitForPendingMin();
            setSaveState(nextState);
        };

        try {
            markProfileMetaCacheDirty(user, 'profile-save');
            const payloadBody = {};
            if (hasNicknameChange) {
                payloadBody.displayName = nickname.trim();
            }
            if (hasEmailChange) {
                payloadBody.newEmail = normalizedEmailInput;
                payloadBody.emailCode = verifyCode.trim();
            }
            payloadBody.locale = selectedLocale;
            payloadBody.theme = isDark ? 'dark' : 'light';

            const resp = await fetch('/api/auth/profile', {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payloadBody),
            });
            const payload = await resp.json().catch(() => ({}));

            if (!resp.ok || !payload?.ok || !payload?.user) {
                const passwordFieldErrorItems = Array.isArray(payload?.fieldErrors)
                    ? payload.fieldErrors
                        .filter((item) => String(item?.field || '') === 'password')
                        .map((item) => mapSaveFieldErrorToText(item))
                    : [];
                const nonPasswordFieldErrorItems = Array.isArray(payload?.fieldErrors)
                    ? payload.fieldErrors
                        .filter((item) => String(item?.field || '') !== 'password')
                        .map((item) => mapSaveFieldErrorToText(item))
                    : [];
                const hasPasswordRoutedError = passwordFieldErrorItems.length > 0 || isPasswordRelatedServerMessage(payload);
                if (hasPasswordRoutedError) {
                    markPasswordButtonResult('error');
                }
                const nextErrorItems = nonPasswordFieldErrorItems.length > 0
                    ? nonPasswordFieldErrorItems
                    : hasPasswordRoutedError
                        ? []
                        : [extractErrorMessage(payload, t('profile.errGenericSaveFailed'))];
                if (nextErrorItems.length === 0 && hasPasswordRoutedError) {
                    await waitForPendingMin();
                    setSaveState('idle');
                } else {
                    await showResultAndReset('error');
                    openSaveErrorModal(nextErrorItems);
                }
                return;
            }

            const savedUser = payload.user;
            setProfileMeta(savedUser);
            if (savedUser?.locale) {
                const ok = setLocale(savedUser.locale, { persist: true });
                if (ok) setSelectedLocale(savedUser.locale);
            }
            setIsTwoFactorEnabled(Boolean(savedUser.twoFactorEnabled));
            if (!savedUser.twoFactorEnabled) setBackupCodes([]);
            {
                const cacheKey = getProfileMetaCacheKey(user);
                if (cacheKey) PROFILE_META_CACHE.set(cacheKey, savedUser);
            }
            writeCachedProfileMeta(user, savedUser);
            clearProfileMetaCacheDirty(user);
            if (payload.emailChanged) {
                setEmailInput(savedUser.email || user.email);
                setVerifyCode('');
                setEmailCodeTargetEmail('');
                persistEmailCodeTargetEmail('');
            }
            onUpdateUser({
                ...user,
                name: savedUser.displayName || nickname.trim(),
                email: savedUser.email || user.email,
                avatarUrl: savedUser.avatarUrl || user.avatarUrl || null,
                locale: savedUser.locale || user.locale || null,
            });

            if (hasAvatarChange) {
                let uploadAvatar = avatarFile;
                if (!(uploadAvatar instanceof Blob) && typeof uploadAvatar === 'string' && uploadAvatar.startsWith('blob:')) {
                    try {
                        const localBlobResp = await fetch(uploadAvatar);
                        if (localBlobResp.ok) {
                            uploadAvatar = await localBlobResp.blob();
                        }
                    } catch {
                        // keep original value, handled by guard below
                    }
                }
                if (!(uploadAvatar instanceof Blob)) {
                    await showResultAndReset('error');
                    openSaveErrorModal([t('profile.errAvatarFailed')]);
                    return;
                }

                const uploadName = typeof avatarFile?.name === 'string' && avatarFile.name ? avatarFile.name : `avatar-${Date.now()}.png`;
                const uploadType = typeof uploadAvatar?.type === 'string' && uploadAvatar.type ? uploadAvatar.type : 'image/png';
                const uploadFileObj = uploadAvatar instanceof File
                    ? uploadAvatar
                    : new File([uploadAvatar], uploadName, { type: uploadType });
                const avatarResp = await fetch('/api/auth/profile/avatar', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'content-type': uploadFileObj.type || uploadType,
                        'x-avatar-filename': encodeURIComponent(uploadFileObj.name || uploadName),
                    },
                    body: uploadFileObj,
                });
                const avatarPayload = await avatarResp.json().catch(() => ({}));
                if (!avatarResp.ok || !avatarPayload?.ok || !avatarPayload?.avatarUrl) {
                    const avatarFieldErrorItems = Array.isArray(avatarPayload?.fieldErrors)
                        ? avatarPayload.fieldErrors.map((item) => mapSaveFieldErrorToText(item))
                        : [];
                    const nextAvatarErrorItems = avatarFieldErrorItems.length > 0
                        ? avatarFieldErrorItems
                        : [t('profile.errAvatarFailed')];
                    await showResultAndReset('error');
                    openSaveErrorModal(nextAvatarErrorItems);
                    return;
                }

                const nextAvatarUrl = avatarPayload.avatarUrl;
                const avatarUser = avatarPayload.user || {};
                onUpdateUser({
                    ...user,
                    id: avatarUser.id || user.id,
                    publicId: avatarUser.publicId || user.publicId || null,
                    name: avatarUser.displayName || savedUser.displayName || nickname.trim(),
                    displayName: avatarUser.displayName || savedUser.displayName || nickname.trim(),
                    email: avatarUser.email || savedUser.email || user.email,
                    avatarUrl: nextAvatarUrl,
                    locale: avatarUser.locale || savedUser.locale || user.locale || null,
                });
                setProfileMeta((prev) => {
                    const next = prev ? { ...prev, avatarUrl: nextAvatarUrl } : prev;
                    const cacheKey = getProfileMetaCacheKey(user);
                    if (cacheKey && next) {
                        PROFILE_META_CACHE.set(cacheKey, next);
                        writeCachedProfileMeta(user, next);
                        clearProfileMetaCacheDirty(user);
                    }
                    return next;
                });
                setAvatarFile(null);
                if (avatarPreviewUrl) {
                    URL.revokeObjectURL(avatarPreviewUrl);
                }
                setAvatarPreviewUrl(null);
            }

            await showResultAndReset('success');
        } catch {
            await showResultAndReset('error');
            openSaveErrorModal([t('profile.errGenericSaveFailed')]);
        }
    };

    const handleDeleteAccount = async () => {
        if (isDeletingAccount) return;
        setIsDeletingAccount(true);
        try {
            const resp = await fetch('/api/auth/delete-account', {
                method: 'POST',
                credentials: 'include',
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok || !payload?.ok) {
                openSaveErrorModal([extractErrorMessage(payload, t('profile.deleteFailed'))], { centered: true });
                return;
            }
            setIsDeleteModalClosing(true);
            window.setTimeout(async () => {
                setShowDeleteModal(false);
                setIsDeleteModalClosing(false);
                await onLogout();
            }, MODAL_CLOSE_MS);
        } catch {
            openSaveErrorModal([t('profile.deleteFailed')], { centered: true });
        } finally {
            setIsDeletingAccount(false);
        }
    };

    const closeDeleteModal = () => {
        if (isDeleteModalClosing || isDeletingAccount) return;
        setIsDeleteModalClosing(true);
        window.setTimeout(() => {
            setShowDeleteModal(false);
            setIsDeleteModalClosing(false);
        }, MODAL_CLOSE_MS);
    };

    const handleLogout = async () => {
        if (isLoggingOut) return;
        setIsLoggingOut(true);
        try {
            await new Promise((resolve) => {
                window.setTimeout(resolve, LOGOUT_DELAY_MS);
            });
            await onLogout();
        } finally {
            setIsLoggingOut(false);
        }
    };

    saveErrorEnterActionRef.current = closeSaveErrorModal;
    deleteEnterActionRef.current = handleDeleteAccount;
    twoFactorBlockedEnterActionRef.current = closeTwoFactorBlockedModal;
    twoFactorDisableEnterActionRef.current = handleDisableTwoFactorConfirm;
    backupCodesEnterActionRef.current = closeBackupCodesModal;
    backupCodesErrorEnterActionRef.current = closeBackupCodesErrorModal;
    emailErrorEnterActionRef.current = closeEmailErrorModal;

    useEffect(() => {
        if (!showSaveErrorModal || isSaveErrorModalClosing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            saveErrorEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isSaveErrorModalClosing, showSaveErrorModal]);

    useEffect(() => {
        if (!showDeleteModal || isDeleteModalClosing || isDeletingAccount) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            deleteEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isDeleteModalClosing, isDeletingAccount, showDeleteModal]);

    useEffect(() => {
        if (!showTwoFactorBlockedModal || isTwoFactorBlockedModalClosing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            twoFactorBlockedEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isTwoFactorBlockedModalClosing, showTwoFactorBlockedModal]);

    useEffect(() => {
        if (!showTwoFactorDisableModal || isTwoFactorDisableModalClosing || isTwoFactorProcessing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            twoFactorDisableEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isTwoFactorDisableModalClosing, isTwoFactorProcessing, showTwoFactorDisableModal]);

    useEffect(() => {
        if (!showBackupCodesModal || isBackupCodesModalClosing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            backupCodesEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isBackupCodesModalClosing, showBackupCodesModal]);

    useEffect(() => {
        if (!showBackupCodesErrorModal || isBackupCodesErrorModalClosing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            backupCodesErrorEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isBackupCodesErrorModalClosing, showBackupCodesErrorModal]);

    useEffect(() => {
        if (!showEmailErrorModal || isEmailErrorModalClosing) return undefined;
        const onKeyDown = (event) => {
            if (event.isComposing || event.key !== 'Enter') return;
            event.preventDefault();
            emailErrorEnterActionRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isEmailErrorModalClosing, showEmailErrorModal]);

    const SaveButton = () => (
        <div className="pt-4 pb-6">
            <button
                onClick={handleSave}
                disabled={!canSave}
                className={`modal-btn !w-full !h-[52px] ${saveState === 'error' ? 'modal-btn-danger' : saveState === 'success' ? 'modal-btn-success' : 'modal-btn-primary'}`}
            >
                {saveState === 'saving' ? (
                    <span className="inline-flex items-center">
                        <span className="w-[20px] h-[20px] mr-2 border-2 border-white/60 border-t-white rounded-full animate-spin" />
                        {t('profile.savingAllChanges')}...
                    </span>
                ) : saveState === 'success' ? (
                    t('profile.saveSuccess')
                ) : saveState === 'error' ? (
                    t('profile.backupCodesRegenerateFailedTitle')
                ) : (
                    t('profile.saveAllChanges')
                )}
            </button>
        </div>
    );

    return (
        <div className="flex h-full bg-[#eef2f6] dark:bg-zinc-950 text-slate-800 dark:text-zinc-100 font-sans overflow-hidden overscroll-none selection:bg-blue-100 dark:selection:bg-blue-500/30">

            <style>{`
                @keyframes fadeSlideUp {
                    0% {
                        opacity: 0;
                        transform: translateY(15px);
                    }
                    100% {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                .animate-tab-content {
                    animation: fadeSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }
                .no-scrollbar::-webkit-scrollbar { display: none; }
                .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
            `}</style>

            <div
                ref={mobileSearchOverlayRef}
                className={`md:hidden absolute inset-0 bg-[#f8fafc] dark:bg-[#09090b] z-[60] flex flex-col transition-all duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] ${isMobileSearchActive
                    ? 'opacity-100 translate-y-0 pointer-events-auto'
                    : 'opacity-0 translate-y-8 pointer-events-none'
                    }`}
                aria-hidden={!isMobileSearchActive}
            >
                <div className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl px-4 py-3 border-b border-slate-200/60 dark:border-zinc-800/60 flex items-center gap-3">
                    <div className="flex-1 flex items-center bg-slate-100 dark:bg-zinc-800 rounded-xl px-3 py-2 border border-transparent focus-within:border-blue-500/50 transition-colors">
                        <Search size={16} className="text-slate-400 dark:text-zinc-500 mr-2" />
                        <input
                            ref={mobileInputRef}
                            type="search"
                            name="settings_search_mobile_no_autofill"
                            autoComplete="new-password"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            data-form-type="other"
                            placeholder={t('profile.searchSettings')}
                            className="bg-transparent border-none outline-none text-sm w-full py-0.5 text-slate-800 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            disabled={!isMobileSearchActive}
                        />
                        {searchQuery ? (
                            <button type="button" onClick={() => setSearchQuery('')} className="text-slate-400 p-1 transition-transform active:scale-90" tabIndex={isMobileSearchActive ? 0 : -1}>
                                <X size={14} />
                            </button>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        className="text-sm text-blue-600 dark:text-blue-400 font-medium whitespace-nowrap active:opacity-70"
                        onClick={closeMobileSearchOverlay}
                        tabIndex={isMobileSearchActive ? 0 : -1}
                    >
                        {t('profile.searchCancel')}
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto bg-[#f8fafc] dark:bg-[#09090b] no-scrollbar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {searchQuery ? (
                        searchResults.length > 0 ? (
                            <ul className="bg-white dark:bg-zinc-900/50 border-b border-slate-100 dark:border-zinc-800">
                                {searchResults.map((result) => (
                                    <li key={result.id} className="border-b border-slate-100/60 dark:border-zinc-800/60 last:border-none">
                                        <button
                                            type="button"
                                            className="w-full text-left px-5 py-4 active:bg-slate-50 dark:active:bg-zinc-800/50 flex items-center"
                                            onClick={() => handleSearchResultClick(result.tab)}
                                        >
                                            <div className="flex-1">
                                                <div className="text-sm font-bold text-slate-800 dark:text-zinc-100">{result.title}</div>
                                                <div className="text-xs text-slate-500 dark:text-zinc-400 mt-1 line-clamp-1">{result.desc}</div>
                                            </div>
                                            <ChevronRight className="w-4 h-4 text-slate-300 dark:text-zinc-600" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <div className="p-10 text-center text-sm text-slate-400 dark:text-zinc-500 flex flex-col items-center">
                                <Search size={32} className="text-slate-200 dark:text-zinc-700 mb-3" />
                                {t('profile.searchNoResults')}
                            </div>
                        )
                    ) : (
                        <div className="p-6 text-[13px] text-slate-400 dark:text-zinc-500 text-center font-medium">{t('profile.searchHint')}</div>
                    )}
                </div>
            </div>
            {/* 核心应用容器 */}
            <div className="w-full flex flex-col md:flex-row bg-[#f8fafc] dark:bg-[#09090b] relative">

                {/* ================= 移动端/窄屏：顶部导航栏 ================= */}
                <div className="md:hidden flex flex-col bg-white/90 dark:bg-zinc-900/90 backdrop-blur-2xl border-b border-slate-200/60 dark:border-zinc-800/60 z-20 sticky top-0 shadow-sm">
                    <div className="flex items-center justify-between px-4 pt-6 pb-3 relative">
                        <button onClick={handleBackToLobby} className="flex items-center text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 transition-colors p-2 -ml-1 active:scale-95">
                            <ArrowLeft className="w-6 h-6" />
                        </button>
                        <h1 className="font-bold text-[17px] text-slate-800 dark:text-zinc-100 tracking-tight absolute left-1/2 -translate-x-1/2">
                            {t('profile.settingsNavTitle')}
                        </h1>
                        <div className="flex items-center gap-1 -mr-1">
                            <button ref={mobileSearchOpenButtonRef} type="button" onClick={() => setIsMobileSearchActive(true)} className="text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 transition-colors p-2 active:scale-95">
                                <Search className="w-[22px] h-[22px]" />
                            </button>
                            <button type="button" onClick={toggleTheme} className="text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 transition-colors p-2 active:scale-95">
                                {isDark ? <Sun className="w-[22px] h-[22px]" /> : <Moon className="w-[22px] h-[22px]" />}
                            </button>
                        </div>
                    </div>
                </div>

                {/* ================= 移动端/窄屏：底部 TabBar 导航栏 ================= */}
                <MobileBottomTabBar
                    items={navItems.map((item) => ({
                        id: item.id,
                        label: item.shortLabel,
                        icon: item.icon,
                        active: activeTab === item.id,
                        onClick: () => scheduleTabChange(item.id),
                    }))}
                />

                {/* ================= 电脑端/宽屏：左侧固定导航栏 ================= */}
                <aside className="hidden md:flex w-[280px] lg:w-[320px] flex-shrink-0 bg-white dark:bg-zinc-900 border-r border-slate-200/50 dark:border-zinc-800/50 flex-col z-10 sidebar-entry">

                    {/* 桌面端全局操作区（返回大厅 & 主题切换） */}
                    <div className="px-5 pt-8 pb-2 flex items-center justify-between">
                        <button onClick={handleBackToLobby} className="flex items-center text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 transition-colors group">
                            <ArrowLeft className="w-[18px] h-[18px] mr-1.5 group-hover:-translate-x-0.5 transition-transform" />
                            <span className="text-[14px] font-semibold">{t('profile.backToLobby')}</span>
                        </button>
                        <button onClick={toggleTheme} className="text-slate-400 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300 transition-colors bg-slate-200/50 dark:bg-zinc-800/50 hover:bg-slate-200 dark:hover:bg-zinc-800 p-1.5 rounded-xl">
                            {isDark ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
                        </button>
                    </div>

                    <div className="pt-4 px-5 pb-5 relative" ref={searchRef}>
                        <div className="bg-slate-200/50 dark:bg-zinc-800/50 text-slate-500 dark:text-zinc-400 rounded-xl px-4 py-2.5 flex items-center text-[14px] transition-all duration-300 focus-within:bg-white dark:focus-within:bg-zinc-900 focus-within:shadow-md focus-within:ring-2 ring-blue-500/20 group">
                            <Search className="w-4 h-4 mr-2.5 text-slate-400 dark:text-zinc-500 group-focus-within:text-blue-500 transition-colors" />
                            <input
                                type="search"
                                name="settings_search_no_autofill"
                                autoComplete="new-password"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                data-lpignore="true"
                                data-1p-ignore="true"
                                data-bwignore="true"
                                data-form-type="other"
                                placeholder={t('profile.searchSettings')}
                                className="bg-transparent outline-none w-full placeholder:text-slate-400 dark:placeholder:text-zinc-500"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onFocus={() => setIsDesktopSearchFocused(true)}
                            />
                        </div>

                        {isDesktopSearchFocused && searchQuery ? (
                            <div className="absolute top-[68px] left-5 right-5 bg-white dark:bg-zinc-800 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] border border-slate-100 dark:border-zinc-700 overflow-hidden z-50 max-h-[320px] overflow-y-auto no-scrollbar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                                {searchResults.length > 0 ? (
                                    <ul className="py-2">
                                        {searchResults.map((result) => (
                                            <li key={result.id}>
                                                <button
                                                    type="button"
                                                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-zinc-700 focus:bg-slate-50 dark:focus:bg-zinc-700 outline-none group transition-colors border-b border-slate-50 dark:border-zinc-800/50 last:border-0"
                                                    onClick={() => handleSearchResultClick(result.tab)}
                                                >
                                                    <div className="text-[14px] font-bold text-slate-800 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                                        {result.title}
                                                    </div>
                                                    <div className="text-[12px] text-slate-500 dark:text-zinc-400 truncate mt-0.5">
                                                        {navItems.find((item) => item.id === result.tab)?.shortLabel} · {result.desc}
                                                    </div>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <div className="p-4 text-center text-[13px] text-slate-400 dark:text-zinc-500">
                                        {t('profile.searchNoResults')}
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </div>

                    <div className="px-6 pb-6 pt-2">
                        <div className="flex items-center gap-4 group cursor-pointer">
                            <div className="relative flex-shrink-0">
                                <img
                                    src={avatarUrl}
                                    alt="Avatar"
                                    className="w-14 h-14 rounded-[18px] border border-slate-200/50 dark:border-zinc-700/50 bg-white dark:bg-zinc-800 shadow-sm transition-transform duration-300 group-hover:scale-105 object-cover"
                                />
                            </div>
                            <div className="overflow-hidden">
                                <h2 className="font-bold text-[16px] text-slate-800 dark:text-zinc-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors duration-300">
                                    {displayName}
                                </h2>
                                <p className="text-[13px] text-slate-500 dark:text-zinc-400 font-medium truncate mt-0.5">
                                    {email}
                                </p>
                            </div>
                        </div>
                    </div>

                    <nav className="flex-1 overflow-y-auto no-scrollbar px-4 space-y-1.5 pb-6">
                        {navItems.map((item) => {
                            const Icon = item.icon;
                            const isActive = activeTab === item.id;
                            return (
                                <button
                                    key={item.id}
                                    onClick={() => scheduleTabChange(item.id)}
                                    className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl transition-colors duration-300 text-[14px] font-semibold ${isActive
                                        ? 'bg-white dark:bg-zinc-800 text-blue-600 dark:text-blue-400 shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-slate-100 dark:border-zinc-700'
                                        : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-200/50 dark:hover:bg-zinc-800/50 hover:text-slate-900 dark:hover:text-zinc-100 border border-transparent'
                                        }`}
                                >
                                    <div className={`p-1.5 rounded-xl transition-colors duration-300 ${isActive ? 'bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400' : item.color + ' text-white'}`}>
                                        <Icon className="w-4 h-4" />
                                    </div>
                                    {item.label}
                                </button>
                            );
                        })}
                    </nav>
                </aside>

                {/* ================= 右侧滚动内容区 ================= */}
                <main ref={mainScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain relative no-scrollbar pb-0 md:pb-0">
                    <div className="max-w-[760px] mx-auto pt-8 md:pt-16 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-16 px-4 sm:px-8 md:px-10">

                        {/* ================= 账号与个人信息 面板 ================= */}
                        {mountedTabMap.profile ? (
                        <div className={activeTab === 'profile' ? 'block animate-tab-content' : 'hidden'}>
                            <div>
                                <h1 className="hidden md:block text-[26px] md:text-[32px] font-extrabold mb-8 md:mb-10 text-slate-800 dark:text-zinc-100 tracking-tight">
                                    {t('profile.sectionBasicInfo')}
                                </h1>

                                {/* 大头像区域 */}
                                <div className="flex flex-col items-center mb-10 md:mb-12">
                                    <div className="relative group cursor-pointer w-fit self-center">
                                        <button type="button" onClick={() => avatarFileInputRef.current?.click()} className="block">
                                            <div className="w-24 h-24 md:w-28 md:h-28 rounded-[32px] bg-gradient-to-tr from-green-200 to-blue-200 dark:from-emerald-300/30 dark:to-sky-300/30 p-1 shadow-sm transition-transform duration-300 group-hover:scale-105">
                                                {avatarUrl ? (
                                                    <img src={avatarUrl} alt="avatar" className="w-full h-full rounded-[28px] object-cover border-4 border-white dark:border-zinc-800" />
                                                ) : (
                                                    <div className="w-full h-full rounded-[28px] bg-white dark:bg-zinc-800 border-4 border-white dark:border-zinc-700 flex items-center justify-center text-3xl font-bold text-slate-700 dark:text-zinc-100">
                                                        {(displayName).charAt(0).toUpperCase()}
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => avatarFileInputRef.current?.click()}
                                            className="absolute right-[-4px] bottom-[-4px] h-9 w-9 rounded-full bg-blue-600 text-white border-4 border-white dark:border-zinc-900 shadow-md inline-flex items-center justify-center hover:bg-blue-700 transition-colors"
                                            aria-label="Change avatar"
                                        >
                                            <Camera className="w-4 h-4" />
                                        </button>
                                        <input
                                            ref={avatarFileInputRef}
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleAvatarSelect}
                                        />
                                    </div>
                                    <h2 className="text-xl md:text-2xl font-bold mt-5 text-slate-800 dark:text-zinc-100 inline-flex items-center gap-2">
                                        {displayName}
                                        <ShieldCheck className={`w-5 h-5 ${statusIconClass(userStatus)}`} />
                                    </h2>

                                    <div className="mt-2.5 inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-zinc-800/60 text-slate-600 dark:text-zinc-400 text-[13px] font-mono border border-slate-200/50 dark:border-zinc-700">
                                        <button
                                            type="button"
                                            onClick={handleCopyProfileId}
                                            className="inline-flex items-center justify-center w-5 h-5 rounded-md text-slate-500 dark:text-zinc-400 hover:bg-slate-200/70 dark:hover:bg-zinc-700 transition-colors"
                                        >
                                            {copyState === 'success' ? (
                                                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                            ) : copyState === 'error' ? (
                                                <XCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                                            ) : (
                                                <Copy className="w-3.5 h-3.5" />
                                            )}
                                        </button>
                                        <span>ID: {profileId}</span>
                                    </div>
                                </div>

                                <SectionTitle title={t('profile.sectionBasicInfo')} />
                                <Card allowOverflow>
                                    <div className="flex items-center px-4 sm:px-6 py-3 sm:py-4 group transition-colors">
                                        <div className="w-[90px] sm:w-[120px] flex items-center gap-2 sm:gap-3 text-[13px] sm:text-[14px] font-bold text-slate-700 dark:text-zinc-300 shrink-0">
                                            <User className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-slate-400 dark:text-zinc-500" />
                                            {t('profile.labelDisplayName')}
                                        </div>
                                        <div className="flex-1 relative app-tonal-input-shell rounded-xl">
                                            <input
                                                type="text"
                                                value={nickname}
                                                onChange={(e) => setNickname(e.target.value)}
                                                className="app-tonal-input w-full px-3 sm:px-4 py-2 sm:py-2.5 pr-9 text-[14px] sm:text-[15px] font-medium"
                                                placeholder={t('profile.placeholderNickname')}
                                            />
                                            <Edit2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 pointer-events-none opacity-40 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" />
                                        </div>
                                    </div>

                                    <div className="px-4 sm:px-6 py-3 sm:py-4 transition-colors">
                                        <div className="flex items-center">
                                            <div className="w-[90px] sm:w-[120px] flex items-center gap-2 sm:gap-3 text-[13px] sm:text-[14px] font-bold text-slate-700 dark:text-zinc-300 shrink-0">
                                                <Mail className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-slate-400 dark:text-zinc-500" />
                                                {t('profile.labelLoginEmail')}
                                            </div>
                                            <div className={`flex-1 flex items-center ${hasEmailChange ? 'gap-2' : 'gap-0'}`}>
                                                <div className="flex-1">
                                                    <div className="relative group app-tonal-input-shell rounded-xl">
                                                        <input
                                                            type="email"
                                                            value={emailInput}
                                                            onChange={(e) => setEmailInput(e.target.value)}
                                                            className="app-tonal-input w-full px-3 sm:px-4 py-2 sm:py-2.5 pr-9 text-[14px] sm:text-[15px] font-medium"
                                                            placeholder={t('profile.placeholderEmail')}
                                                        />
                                                        <Edit2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 pointer-events-none opacity-40 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity" />
                                                    </div>
                                                </div>
                                                <div className={`overflow-hidden transition-all duration-300 [transition-timing-function:cubic-bezier(0.25,1,0.5,1)] ${hasEmailChange ? 'w-[90px] opacity-100' : 'w-0 opacity-0'}`}>
                                                    <button
                                                        type="button"
                                                        onClick={handleSendEmailCode}
                                                        disabled={isSendingCode || isEmailCodeCoolingDown || isEmailAlreadyRegistered}
                                                        className="w-[90px] h-[38px] bg-blue-600 text-white text-[12px] sm:text-[13px] font-bold rounded-lg hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50 whitespace-nowrap"
                                                    >
                                                        {isSendingCode ? t('auth.pleaseWait') : isEmailAlreadyRegistered ? (emailAlreadyRegisteredLabelMap[selectedLocale] || emailAlreadyRegisteredLabelMap.en) : isEmailCodeCoolingDown ? `${t('profile.codeSent')} ${emailCodeCooldownLeftSec}s` : t('profile.sendCode')}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        <div className={`grid transition-all duration-300 [transition-timing-function:cubic-bezier(0.25,1,0.5,1)] ${shouldShowEmailCodeInput ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0 mt-0'}`}>
                                            <div className="overflow-hidden">
                                                <div className="flex items-center py-1 px-px">
                                                    <div className="w-[90px] sm:w-[120px] flex items-center gap-2 sm:gap-3 text-[13px] sm:text-[14px] font-bold text-slate-700 dark:text-zinc-300 shrink-0">
                                                        <KeyRound className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-slate-400 dark:text-zinc-500" />
                                                        {t('profile.emailCode')}
                                                    </div>
                                                    <div className="flex-1 app-tonal-input-shell rounded-xl">
                                                        <input
                                                            type="text"
                                                            value={verifyCode}
                                                            onChange={(e) => setVerifyCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                                                            placeholder={t('profile.placeholderEmailCode')}
                                                            className="app-tonal-input px-3 sm:px-4 py-2 sm:py-2.5 text-[14px] sm:text-[15px]"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative rounded-b-[24px] sm:rounded-b-[28px]" ref={profileLangDropdownRef}>
                                        <button
                                            type="button"
                                            onClick={() => setIsProfileLangDropdownOpen((prev) => !prev)}
                                            className="w-full flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 cursor-pointer hover:bg-slate-50/80 dark:hover:bg-zinc-800/60 transition-colors text-left rounded-b-[24px] sm:rounded-b-[28px]"
                                            aria-haspopup="listbox"
                                            aria-expanded={isProfileLangDropdownOpen}
                                        >
                                            <div className="w-[90px] sm:w-[120px] flex items-center gap-2 sm:gap-3 text-[13px] sm:text-[14px] font-bold text-slate-700 dark:text-zinc-300 shrink-0">
                                                <Globe className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-slate-400 dark:text-zinc-500" />
                                                {t('profile.labelLanguage')}
                                            </div>

                                            <div className="flex-1 flex justify-end">
                                                <div className="flex items-center gap-1.5 sm:gap-2 text-[13px] sm:text-[14px] font-bold text-slate-700 dark:text-zinc-200 bg-slate-50 dark:bg-zinc-800 hover:bg-slate-100 dark:hover:bg-zinc-700 border border-slate-100 dark:border-zinc-700 px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl transition-colors">
                                                    <span>{localeIconMap[selectedLocaleOption?.value] || '🌐'}</span>
                                                    <span className="mr-0.5">{selectedLocaleOption?.label}</span>
                                                    <ChevronDown className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 dark:text-zinc-500 transition-transform duration-300 ${isProfileLangDropdownOpen ? 'rotate-180 text-blue-500 dark:text-blue-400' : ''}`} />
                                                </div>
                                            </div>
                                        </button>

                                        <div className={`absolute top-full right-4 sm:right-6 mt-1 sm:mt-2 w-[180px] sm:w-[220px] bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700/80 rounded-[20px] shadow-[0_12px_40px_rgb(0,0,0,0.08)] dark:shadow-[0_12px_40px_rgb(0,0,0,0.35)] z-50 overflow-hidden transition-all duration-300 transform origin-top-right ${isProfileLangDropdownOpen ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'}`}>
                                            <div role="listbox" className="p-1.5 flex flex-col gap-0.5">
                                                {localeOptions.map((option) => {
                                                    const isSelected = option.value === selectedLocale;
                                                    return (
                                                        <button
                                                            key={option.value}
                                                            type="button"
                                                            role="option"
                                                            aria-selected={isSelected}
                                                            onClick={() => {
                                                                handleLocaleChange(option.value);
                                                                setIsProfileLangDropdownOpen(false);
                                                            }}
                                                            className={`flex items-center justify-between px-3 py-2.5 rounded-[14px] transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300' : 'hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200'}`}
                                                        >
                                                            <div className="flex items-center gap-2 text-[13px] sm:text-[14px] font-bold">
                                                                <span>{localeIconMap[option.value] || '🌐'}</span>
                                                                {option.label}
                                                            </div>
                                                            {isSelected ? <Check className="w-4 h-4 text-blue-600 dark:text-blue-300" /> : null}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                </Card>

                                <SectionTitle title={t('profile.cloudStorage')} />
                                <Card>
                                    <div className="p-6">
                                        <div className="flex items-start justify-between mb-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-md">
                                                    <HardDrive className="w-6 h-6" />
                                                </div>
                                                <div>
                                                    <div className="flex items-baseline gap-1">
                                                        <span className="text-[28px] font-black text-slate-800 dark:text-zinc-100 leading-none">{storageUsedDisplay.value}</span>
                                                        <span className="text-[14px] font-bold text-slate-400 dark:text-zinc-500">{storageUsedDisplay.unit}</span>
                                                    </div>
                                                    <div className="text-[13px] font-medium text-slate-500 dark:text-zinc-400 mt-1">
                                                        {t('profile.storageSummaryPlaceholder', { total: storageTotalGb.toFixed(storageTotalGb >= 10 ? 0 : 1), percent: storagePercent.toFixed(1) })}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="h-3 w-full bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden flex shadow-inner relative mb-5">
                                            <div className="bg-gradient-to-r from-blue-400 to-blue-600 h-full rounded-full transition-all duration-1000" style={{ width: `${storagePercent}%` }}></div>
                                        </div>

                                        <div className="flex items-center justify-between text-[13px] px-1">
                                            <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400 font-medium">
                                                <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                                                {t('profile.storageUsed')}
                                            </div>
                                            <span className="font-bold text-slate-800 dark:text-zinc-100">{storageUsedDisplay.value} {storageUsedDisplay.unit}</span>
                                        </div>
                                        <div className="flex items-center justify-between text-[13px] px-1 mt-2.5">
                                            <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400 font-medium">
                                                <div className="w-2.5 h-2.5 rounded-full bg-slate-200 dark:bg-zinc-700" />
                                                {t('profile.storageAvailable')}
                                            </div>
                                            <span className="font-bold text-slate-800 dark:text-zinc-100">{storageFreeDisplay.value} {storageFreeDisplay.unit}</span>
                                        </div>
                                    </div>
                                </Card>

                                <SaveButton />
                            </div>
                        </div>
                        ) : null}

                        {/* ================= 登录与安全性 面板 ================= */}
                        {mountedTabMap.security ? (
                        <div className={activeTab === 'security' ? 'block animate-tab-content' : 'hidden'}>
                            <div>
                                <h1 className="hidden md:block text-[26px] md:text-[32px] font-extrabold mb-8 md:mb-10 text-slate-800 dark:text-zinc-100 tracking-tight">
                                    {t('profile.sectionSecurity')}
                                </h1>

                                <SectionTitle title={t('profile.password')} />
                                {!hasPassword ? <div className="mb-6 text-[14px] text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/10 border border-blue-200/70 dark:border-zinc-700/50 rounded-2xl px-5 py-4">{t('profile.securityNoPasswordHint')}</div> : null}
                                <Card>
                                    <div className="p-5 sm:p-6 space-y-5">
                                        {hasPassword && (
                                            <TonalInput
                                                icon={Lock}
                                                type={showOldPassword ? 'text' : 'password'}
                                                label={t('profile.oldPassword')}
                                                value={oldPassword}
                                                onChange={(e) => setOldPassword(e.target.value)}
                                                placeholder={t('profile.placeholderOldPassword')}
                                                action={(
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowOldPassword((prev) => !prev)}
                                                        className="h-9 w-9 inline-flex items-center justify-center rounded-xl text-slate-500 dark:text-zinc-400 hover:bg-slate-200/70 dark:hover:bg-zinc-700/70 transition-colors"
                                                    >
                                                        {showOldPassword ? <EyeOff className="w-[17px] h-[17px]" /> : <Eye className="w-[17px] h-[17px]" />}
                                                    </button>
                                                )}
                                            />
                                        )}
                                        <TonalInput
                                            icon={Lock}
                                            type={showNewPassword ? 'text' : 'password'}
                                            label={hasPassword ? t('profile.newPassword') : t('profile.setPassword')}
                                            value={newPassword}
                                            onChange={(e) => setNewPassword(e.target.value)}
                                            placeholder={hasPassword ? t('profile.placeholderNewPassword') : t('profile.placeholderSetPassword')}
                                            action={(
                                                <button
                                                    type="button"
                                                    onClick={() => setShowNewPassword((prev) => !prev)}
                                                    className="h-9 w-9 inline-flex items-center justify-center rounded-xl text-slate-500 dark:text-zinc-400 hover:bg-slate-200/70 dark:hover:bg-zinc-700/70 transition-colors"
                                                >
                                                    {showNewPassword ? <EyeOff className="w-[17px] h-[17px]" /> : <Eye className="w-[17px] h-[17px]" />}
                                                </button>
                                            )}
                                        />
                                        <TonalInput
                                            icon={Lock}
                                            type={showConfirmPassword ? 'text' : 'password'}
                                            label={t('profile.confirmPassword')}
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder={t('profile.placeholderConfirmPassword')}
                                            action={(
                                                <button
                                                    type="button"
                                                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                                                    className="h-9 w-9 inline-flex items-center justify-center rounded-xl text-slate-500 dark:text-zinc-400 hover:bg-slate-200/70 dark:hover:bg-zinc-700/70 transition-colors"
                                                >
                                                    {showConfirmPassword ? <EyeOff className="w-[17px] h-[17px]" /> : <Eye className="w-[17px] h-[17px]" />}
                                                </button>
                                            )}
                                        />
                                        <div className="pt-2 grid grid-cols-2 gap-3">
                                            <button
                                                type="button"
                                                onClick={handlePasswordCancel}
                                                disabled={passwordSaveState === 'saving'}
                                                className="modal-btn modal-btn-secondary !h-11 !w-full"
                                            >
                                                {t('profile.passwordChangeCancel')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handlePasswordSave}
                                                disabled={passwordSaveState === 'saving' || !canPasswordSave}
                                                className={`modal-btn !h-11 !w-full ${passwordSaveState === 'error'
                                                    ? 'modal-btn-danger'
                                                    : 'modal-btn-primary'
                                                    }`}
                                            >
                                                {passwordSaveState === 'saving'
                                                    ? t('auth.pleaseWait')
                                                    : passwordSaveState === 'success'
                                                        ? t('profile.saveSuccess')
                                                        : passwordSaveState === 'error'
                                                            ? t('profile.passwordChangeFailed')
                                                            : (hasPassword ? t('profile.passwordChangeAction') : t('profile.passwordSetAction'))}
                                            </button>
                                        </div>
                                    </div>
                                </Card>

                                <SectionTitle title={t('profile.twoFactorAuth')} className="mt-8" />
                                <Card>
                                    <Row
                                        label={t('profile.twoFactorAuth')}
                                        description={t('profile.twoFactorAuthDesc')}
                                        icon={<ShieldCheck className="w-5 h-5 text-emerald-500 dark:text-emerald-300" />}
                                        iconBg="bg-slate-600 dark:bg-zinc-600"
                                    >
                                        <AppleToggle checked={isTwoFactorEnabled} onChange={handleTwoFactorToggle} disabled={isTwoFactorProcessing} />
                                    </Row>

                                    {isTwoFactorEnabled && (
                                        <div className="px-5 sm:px-6 py-6 border-t border-slate-100/60 dark:border-zinc-800/60 bg-slate-50/50 dark:bg-zinc-900/50">
                                            {/* 你原有的备份代码块容器适配新样式 */}
                                            <div className="rounded-2xl border border-slate-200/90 dark:border-zinc-700/80 bg-white dark:bg-zinc-800/50 overflow-hidden shadow-sm">
                                                <div className="p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                                    <div className="flex items-center gap-4 min-w-0">
                                                        <span className="w-14 h-14 rounded-2xl bg-slate-50 dark:bg-zinc-900 border border-slate-200/70 dark:border-zinc-700 text-blue-600 dark:text-blue-400 inline-flex items-center justify-center flex-shrink-0">
                                                            <KeyRound className="w-6 h-6" />
                                                        </span>
                                                        <div className="min-w-0">
                                                            <div className="text-[16px] font-bold text-slate-900 dark:text-zinc-100">
                                                                {backupCodes.length
                                                                    ? t('profile.backupCodesCount', { count: backupCodes.length })
                                                                    : t('profile.backupCodesTitle')}
                                                            </div>
                                                            <div className="text-[13px] text-slate-500 dark:text-zinc-400 mt-1">{t('profile.backupCodesDesc')}</div>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-2 w-full sm:w-auto">
                                                        <button
                                                            type="button"
                                                            onClick={openBackupCodesModal}
                                                            disabled={!backupCodes.length}
                                                            className="h-10 w-10 inline-flex items-center justify-center rounded-xl text-slate-500 dark:text-zinc-300 bg-white dark:bg-zinc-800 border border-slate-200/70 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
                                                            title={backupCodes.length ? t('profile.backupCodesReveal') : t('profile.backupCodesRevealUnavailable')}
                                                        >
                                                            <BackupRevealIcon />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={handleDownloadBackupCodes}
                                                            disabled={!backupCodes.length}
                                                            className="flex-1 sm:flex-none h-10 px-4 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[14px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 disabled:opacity-50"
                                                        >
                                                            <Download className="w-4 h-4" />
                                                            {t('profile.backupCodesDownload')}
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="px-5 py-3.5 border-t border-slate-200/80 dark:border-zinc-700/70 bg-slate-100/60 dark:bg-zinc-900/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                                                    <div className="inline-flex items-center gap-2 text-[12px] text-slate-500 dark:text-zinc-400">
                                                        <ShieldAlert className="w-3.5 h-3.5" />
                                                        <span>{t('profile.backupCodesSingleUse')}</span>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={handleRegenerateBackupCodes}
                                                        disabled={!isTwoFactorEnabled || backupCodesRegenerating}
                                                        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                                                    >
                                                        <RotateCcw className={`w-3.5 h-3.5 ${backupCodesRegenerating ? 'animate-spin' : ''}`} />
                                                        {backupCodesRegenerating ? t('auth.pleaseWait') : t('profile.backupCodesRegenerate')}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </Card>

                                <SectionTitle title={t('profile.sectionActions')} className="mt-12 !text-red-400 dark:!text-red-500/80" />
                                <Card>
                                    <button onClick={handleLogout} disabled={isLoggingOut} className="w-full flex items-center justify-between px-5 sm:px-6 py-5 text-red-500 hover:bg-red-50/50 dark:hover:bg-red-500/10 transition-colors group">
                                        <span className="text-[15px] sm:text-[16px] font-medium">{t('profile.logout')}</span>
                                        <LogOut className="w-5 h-5 opacity-60 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-300" />
                                    </button>
                                    <button
                                        onClick={() => {
                                            setIsDeleteModalClosing(false);
                                            setShowDeleteModal(true);
                                        }}
                                        className="w-full flex items-center justify-between px-5 sm:px-6 py-5 text-red-500 hover:bg-red-50/50 dark:hover:bg-red-500/10 transition-colors border-t border-slate-100 dark:border-zinc-800/80 group"
                                    >
                                        <span className="text-[15px] sm:text-[16px] font-medium">{t('profile.deleteAccount')}</span>
                                        <UserX className="w-5 h-5 opacity-60 group-hover:opacity-100 group-hover:scale-110 transition-all duration-300" />
                                    </button>
                                </Card>
                            </div>
                        </div>
                        ) : null}

                        {/* ================= 观影偏好 面板 ================= */}
                        {mountedTabMap.preferences ? (
                        <div className={activeTab === 'preferences' ? 'block animate-tab-content' : 'hidden'}>
                            <div>
                                <h1 className="hidden md:block text-[26px] md:text-[32px] font-extrabold mb-8 md:mb-10 text-slate-800 dark:text-zinc-100 tracking-tight">
                                    {t('profile.sectionPreferences')}
                                </h1>

                                <SectionTitle title={t('profile.playbackRoomSettings')} />
                                <Card>
                                    <Row
                                        label={t('profile.hardwareAcceleration')}
                                        description={t('profile.hardwareAccelerationDesc')}
                                        icon={<HardwareAccelerationIcon />}
                                        iconBg="bg-gradient-to-br from-slate-400 to-slate-500 dark:from-zinc-500 dark:to-zinc-600"
                                    >
                                        <AppleToggle
                                            checked={hardwareAcceleration}
                                            onChange={handleHardwareAccelerationChange}
                                            disabled={gpuVideoRenderingSupport?.canUseGpuCompositing === false}
                                        />
                                    </Row>
                                    <Row
                                        label={t('profile.allowControl')}
                                        description={t('profile.allowControlDesc')}
                                        icon={<PlaybackControlIcon />}
                                        iconBg="bg-gradient-to-br from-blue-400 to-blue-500 dark:from-blue-500 dark:to-blue-600"
                                    >
                                        <AppleToggle checked={allowControl} onChange={() => setAllowControl(!allowControl)} />
                                    </Row>
                                    <Row
                                        label={t('profile.joinSound')}
                                        description={t('profile.joinSoundDesc')}
                                        icon={<EntrySoundIcon />}
                                        iconBg="bg-gradient-to-br from-indigo-400 to-indigo-500 dark:from-indigo-500 dark:to-indigo-600"
                                    >
                                        <AppleToggle checked={joinSound} onChange={() => setJoinSound(!joinSound)} />
                                    </Row>
                                </Card>
                                <SectionTitle title={t('profile.syncStrategySettings')} />
                                <Card allowOverflow>
                                    <Row
                                        label={t('profile.autoResync')}
                                        description={t('profile.autoResyncDesc')}
                                        icon={<RefreshCw className="w-5 h-5" />}
                                        iconBg="bg-gradient-to-br from-emerald-400 to-emerald-500 dark:from-emerald-500 dark:to-emerald-600"
                                    >
                                        <AppleToggle checked={autoResync} onChange={() => setAutoResync(!autoResync)} />
                                    </Row>
                                    <Row
                                        label={t('profile.syncThreshold')}
                                        description={t('profile.syncThresholdDesc')}
                                        icon={<Timer className="w-5 h-5" />}
                                        iconBg="bg-gradient-to-br from-amber-400 to-orange-500 dark:from-amber-500 dark:to-orange-600"
                                    >
                                        <SelectControl
                                            value={syncThreshold}
                                            onChange={(event) => setSyncThreshold(event.target.value)}
                                            options={[
                                                { value: '1', label: t('profile.syncThresholdGt1s') },
                                                { value: '2', label: t('profile.syncThresholdGt2s') },
                                                { value: '5', label: t('profile.syncThresholdGt5s') },
                                            ]}
                                        />
                                    </Row>
                                    <Row
                                        label={t('profile.autoCatchUpOnJoin')}
                                        description={t('profile.autoCatchUpOnJoinDesc')}
                                        icon={<Rocket className="w-5 h-5" />}
                                        iconBg="bg-gradient-to-br from-cyan-400 to-blue-500 dark:from-cyan-500 dark:to-blue-600"
                                    >
                                        <AppleToggle checked={autoCatchUpOnJoin} onChange={() => setAutoCatchUpOnJoin(!autoCatchUpOnJoin)} />
                                    </Row>
                                </Card>
                                <SectionTitle title={t('profile.chatInteractionSettings')} />
                                <Card>
                                    <Row
                                        label={t('profile.messageNotificationSound')}
                                        description={t('profile.messageNotificationSoundDesc')}
                                        icon={<Bell className="w-5 h-5" />}
                                        iconBg="bg-gradient-to-br from-rose-400 to-pink-500 dark:from-rose-500 dark:to-pink-600"
                                    >
                                        <AppleToggle checked={messageSound} onChange={() => setMessageSound(!messageSound)} />
                                    </Row>
                                    <Row
                                        label={t('profile.messageDisplayFilter')}
                                        description={t('profile.messageDisplayFilterDesc')}
                                        icon={<MessageCircle className="w-5 h-5" />}
                                        iconBg="bg-gradient-to-br from-blue-400 to-sky-500 dark:from-blue-500 dark:to-sky-600"
                                        stacked
                                    >
                                        <SegmentedControl
                                            value={messageFilter}
                                            onChange={setMessageFilter}
                                            fullWidth
                                            options={[
                                                { value: 'all', label: t('profile.messageFilterAll') },
                                                { value: 'chat', label: t('profile.messageFilterChat') },
                                            ]}
                                        />
                                    </Row>
                                </Card>
                            </div>
                        </div>
                        ) : null}

                        {/* ================= 快捷联系人 面板 ================= */}
                        {mountedTabMap.contacts ? (
                        <div className={activeTab === 'contacts' ? 'block animate-tab-content' : 'hidden'}>
                            <div>
                                <QuickContactsPanel activeRoom={activeRoom} currentUser={user} />
                            </div>
                        </div>
                        ) : null}
                    </div>
                </main>
            </div>

            {/* ================= 以下为原有的 Modals，全部保持不动 ================= */}

            {showSaveErrorModal ? (
                <div className={`modal-overlay ${isSaveErrorModalClosing ? 'closing' : ''}`} onClick={closeSaveErrorModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isSaveErrorModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-error" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-error">
                                <div className="modal-icon-core">
                                    <AlertCircle className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.backupCodesRegenerateFailedTitle')}</h3>
                            <p className="modal-copy">{t('profile.saveErrorSubtitle')}</p>
                        </div>

                        {saveErrorDisplay === 'center' ? (
                            <div className="px-5 sm:px-6 pb-4">
                                <ul className="space-y-2.5">
                                    {saveErrors.map((item, index) => (
                                        <li key={`${item}-${index}`} className="flex items-center justify-center bg-red-50/60 dark:bg-red-500/10 p-3 rounded-xl border border-red-100/60 dark:border-red-500/20">
                                            <XCircle className="w-[18px] h-[18px] text-red-500 flex-shrink-0 mr-2.5" />
                                            <span className="text-[18px] text-red-700 dark:text-red-300 font-semibold leading-tight text-center">
                                                {item}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ) : (
                            <div className="modal-list-wrap">
                                <ul className="space-y-2.5">
                                    {saveErrors.map((item, index) => (
                                        <li key={`${item}-${index}`} className="flex items-start bg-red-50/60 dark:bg-red-500/10 p-2.5 rounded-xl border border-red-100/60 dark:border-red-500/20">
                                            <XCircle className="w-[18px] h-[18px] text-red-500 flex-shrink-0 mt-[1px] mr-2.5" />
                                            <span className="text-[14px] text-red-800 dark:text-red-300 font-medium leading-tight">
                                                {item}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <div className="modal-actions single">
                            <button
                                type="button"
                                onClick={closeSaveErrorModal}
                                className="modal-btn modal-btn-primary"
                            >
                                {t('auth.modalAcknowledge')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showDeleteModal ? (
                <div className={`modal-overlay ${isDeleteModalClosing ? 'closing' : ''}`} onClick={closeDeleteModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isDeleteModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[28px]`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-error" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-error">
                                <div className="modal-icon-core">
                                    <AlertTriangle className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.deleteConfirmTitle')}</h3>
                            <p className="modal-copy">{t('profile.deleteConfirmDesc')}</p>
                        </div>
                        <div className="modal-actions">
                            <button
                                type="button"
                                onClick={closeDeleteModal}
                                disabled={isDeletingAccount}
                                className="modal-btn modal-btn-secondary"
                            >
                                {t('profile.deleteCancel')}
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteAccount}
                                disabled={isDeletingAccount}
                                className="modal-btn modal-btn-danger"
                            >
                                {isDeletingAccount ? t('profile.deleting') : t('profile.deleteConfirmAction')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showTwoFactorBlockedModal ? (
                <div className={`modal-overlay ${isTwoFactorBlockedModalClosing ? 'closing' : ''}`} onClick={closeTwoFactorBlockedModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isTwoFactorBlockedModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-warning" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-warning">
                                <div className="modal-icon-core">
                                    <Lock className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.twoFactorPasswordRequiredTitle')}</h3>
                            <p className="modal-copy">{t('profile.twoFactorPasswordRequiredDesc')}</p>
                        </div>
                        <div className="modal-actions single">
                            <button
                                type="button"
                                onClick={closeTwoFactorBlockedModal}
                                className="modal-btn modal-btn-primary"
                            >
                                {t('auth.modalAcknowledge')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showTwoFactorDisableModal ? (
                <div className={`modal-overlay ${isTwoFactorDisableModalClosing ? 'closing' : ''}`} onClick={closeTwoFactorDisableModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isTwoFactorDisableModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-warning" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-warning">
                                <div className="modal-icon-core">
                                    <LockOpen className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.twoFactorDisableTitle')}</h3>
                            <p className="modal-copy">{t('profile.twoFactorDisableDesc')}</p>
                            <div className="mt-4">
                                <OtpSixInput
                                    value={twoFactorDisableCode}
                                    onChange={(next) => {
                                        setTwoFactorDisableCode(next);
                                        if (twoFactorDisableError) setTwoFactorDisableError('');
                                    }}
                                    disabled={isTwoFactorProcessing}
                                />
                                <p className={`mt-2 min-h-[20px] text-center text-sm font-medium ${twoFactorDisableError ? 'text-rose-500' : 'text-transparent'}`}>
                                    {twoFactorDisableError}
                                </p>
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button
                                type="button"
                                onClick={closeTwoFactorDisableModal}
                                disabled={isTwoFactorProcessing}
                                className="modal-btn modal-btn-secondary"
                            >
                                {t('profile.twoFactorDisableCancel')}
                            </button>
                            <button
                                type="button"
                                onClick={handleDisableTwoFactorConfirm}
                                disabled={isTwoFactorProcessing}
                                className="modal-btn modal-btn-danger"
                            >
                                {isTwoFactorProcessing ? t('auth.pleaseWait') : t('profile.twoFactorDisableConfirm')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showBackupCodesModal ? (
                <div className={`modal-overlay ${isBackupCodesModalClosing ? 'closing' : ''}`} onClick={closeBackupCodesModal}>
                    <div
                        className={`auth-card modal-content modal-content--form ${isBackupCodesModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-info" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-info">
                                <div className="modal-icon-core">
                                    <KeyRound className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.backupCodesModalTitle')}</h3>
                            <p className="modal-copy">{t('profile.backupCodesModalDesc')}</p>

                            <div className="mt-4 grid grid-cols-3 gap-2">
                                {backupCodes.map((code, index) => (
                                    <div key={`${code}-${index}`} className="rounded-xl border border-slate-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 px-3 py-2 text-center">
                                        <code className="text-[16px] font-mono font-semibold text-slate-700 dark:text-zinc-200 tracking-tight">{code}</code>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button
                                type="button"
                                onClick={handleCopyBackupCodes}
                                className="modal-btn modal-btn-secondary"
                            >
                                {backupCodesCopied ? t('profile.backupCodesCopied') : t('profile.backupCodesCopy')}
                            </button>
                            <button
                                type="button"
                                onClick={closeBackupCodesModal}
                                className="modal-btn modal-btn-primary"
                            >
                                {t('profile.backupCodesClose')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showBackupCodesErrorModal ? (
                <div className={`modal-overlay ${isBackupCodesErrorModalClosing ? 'closing' : ''}`} onClick={closeBackupCodesErrorModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isBackupCodesErrorModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-error" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-error">
                                <div className="modal-icon-core">
                                    <AlertCircle className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.backupCodesRegenerateFailedTitle')}</h3>
                            <p className="modal-copy">{t('profile.backupCodesRegenerateFailed')}</p>
                        </div>
                        <div className="modal-actions single">
                            <button
                                type="button"
                                onClick={closeBackupCodesErrorModal}
                                className="modal-btn modal-btn-primary"
                            >
                                {t('auth.modalAcknowledge')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showEmailErrorModal ? (
                <div className={`modal-overlay ${isEmailErrorModalClosing ? 'closing' : ''}`} onClick={closeEmailErrorModal}>
                    <div
                        className={`auth-card modal-content modal-content--compact ${isEmailErrorModalClosing ? 'closing' : ''} w-full rounded-t-[32px] rounded-b-none sm:rounded-[24px] overflow-hidden p-0 text-left`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-sheet-handle" />
                        <div className="modal-aura is-error" />
                        <div className="modal-body">
                            <div className="modal-icon-badge is-error">
                                <div className="modal-icon-core">
                                    <AlertCircle className="modal-icon-glyph w-8 h-8" />
                                </div>
                            </div>
                            <h3 className="modal-heading">{t('profile.backupCodesRegenerateFailedTitle')}</h3>
                            <p className="modal-copy">{emailErrorText}</p>
                        </div>
                        <div className="modal-actions single">
                            <button
                                type="button"
                                onClick={closeEmailErrorModal}
                                className="modal-btn modal-btn-primary"
                            >
                                {t('auth.modalAcknowledge')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {showTwoFactorSetupModal ? (
                <TwoFactorSetupModal
                    onClose={closeTwoFactorSetupModal}
                    onComplete={completeTwoFactorSetup}
                    isClosing={isTwoFactorSetupModalClosing}
                />
            ) : null}
        </div>
    );
});

export default ProfileScreen;




