import { AlertCircle, ArrowLeft, ChevronRight, Eye, EyeOff, Loader2, Mail, Moon, Sun, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocale, t } from '../../i18n';
import { markProfileMetaCacheDirtyByEmail } from '../../lib/localProfileCache';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODAL_CLOSE_MS = 300;
const FORGOT_SUCCESS_AUTO_CLOSE_MS = 1000;
const SEND_CODE_MIN_FEEDBACK_MS = 1000;
const SOCIAL_REDIRECT_DELAY_MS = 1000;
const PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX = 'swaparty.profile.prefetched_backup_codes';

function isReloadNavigation() {
  try {
    const nav = performance.getEntriesByType('navigation')?.[0];
    return nav?.type === 'reload';
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentThemeForRequest() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function mapApiError(errorText, mode) {
  const text = String(errorText || '').toLowerCase();
  if (text.includes('already registered')) return t('auth.errorRegisterGeneric');
  if (text.includes('invalid email or password')) return t('auth.errorLoginGeneric');
  if (text.includes('email is not verified')) return t('auth.errorLoginGeneric');
  if (text.includes('password must be at least 8')) return t('auth.errorRegisterGeneric');
  if (text.includes('invalid email')) return mode === 'register' ? t('auth.errorRegisterGeneric') : t('auth.errorLoginGeneric');
  return mode === 'register' ? t('auth.errorRegisterGeneric') : t('auth.errorLoginGeneric');
}

function mapForgotResetError(errorText) {
  const text = String(errorText || '').toLowerCase();
  if (text.includes('code') || text.includes('expired') || text.includes('attempt') || text.includes('request')) {
    return [t('auth.forgotResetErrorInvalidCode')];
  }
  return [t('auth.errNetworkRequestFailed')];
}

function isForgotResetCodeError(errorText) {
  const text = String(errorText || '').toLowerCase();
  return text.includes('code') || text.includes('expired') || text.includes('attempt') || text.includes('request');
}

function mapForgotResetFieldErrorToText(item) {
  const field = String(item?.field || '');
  const code = String(item?.code || '');
  if (field !== 'password') return '';
  if (code === 'password_too_short') return t('auth.errPasswordTooShort');
  if (code === 'password_complexity') return t('auth.errPasswordComplexity');
  if (code === 'password_invalid_chars') return t('auth.errPasswordInvalidChars');
  if (code === 'password_too_weak') return t('auth.errPasswordTooWeak');
  return '';
}

const FORGOT_PASSWORD_ERROR_PRIORITY = {
  password_too_short: 4,
  password_complexity: 5,
  password_invalid_chars: 6,
  password_too_weak: 7,
};

function sortAndMapForgotPasswordErrors(fieldErrors) {
  const sorted = Array.isArray(fieldErrors)
    ? [...fieldErrors]
      .filter((item) => String(item?.field || '') === 'password')
      .sort((a, b) => {
        const ca = String(a?.code || '');
        const cb = String(b?.code || '');
        const pa = FORGOT_PASSWORD_ERROR_PRIORITY[ca] ?? 999;
        const pb = FORGOT_PASSWORD_ERROR_PRIORITY[cb] ?? 999;
        return pa - pb;
      })
    : [];

  const mapped = sorted
    .map((item) => mapForgotResetFieldErrorToText(item))
    .filter(Boolean);

  return Array.from(new Set(mapped));
}

function normalizeUser(rawUser, fallbackEmail) {
  if (!rawUser && !fallbackEmail) return null;
  const email = rawUser?.email || fallbackEmail || '';
  const nickname = rawUser?.displayName || email.split('@')[0] || 'Guest';
  return {
    id: rawUser?.id || `tmp-${Date.now()}`,
    publicId: rawUser?.publicId || null,
    name: nickname,
    email,
    avatarUrl: rawUser?.avatarUrl || null,
    locale: rawUser?.locale || null,
  };
}

function getPrefetchedBackupCodesKeyForUser(user) {
  const idPart = String(user?.id || '').trim();
  const emailPart = String(user?.email || '').trim().toLowerCase();
  if (idPart) return `${PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX}:id:${idPart}`;
  if (emailPart) return `${PROFILE_PREFETCHED_BACKUP_CODES_KEY_PREFIX}:email:${emailPart}`;
  return '';
}

async function prefetchBackupCodesForProfile(user) {
  const cacheKey = getPrefetchedBackupCodesKeyForUser(user);
  if (!cacheKey) return;
  const codes = Array.isArray(user?.recoveryCodes) ? user.recoveryCodes.filter(Boolean) : [];
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(codes));
  } catch {
    // ignore storage failures
  }
}

function TwoFactorOtpInput({ value, onChange, onErrorClear }) {
  const inputRefs = useRef([]);
  const otpText = value.join('');

  const handleChange = (index, event) => {
    const nextChar = String(event.target.value || '').replace(/\D/g, '').slice(-1);
    const next = [...value];
    next[index] = nextChar;
    onChange(next);
    if (onErrorClear) onErrorClear();
    if (nextChar && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, event) => {
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i += 1) next[i] = pasted[i];
    onChange(next);
    if (onErrorClear) onErrorClear();
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
  };

  const handleSingleInputChange = (event) => {
    const digits = String(event.target.value || '').replace(/\D/g, '').slice(0, 6);
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < digits.length; i += 1) next[i] = digits[i];
    onChange(next);
    if (onErrorClear) onErrorClear();
  };

  return (
    <div className="w-full">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        className="h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-center text-lg font-bold tracking-[0.2em] text-gray-800 outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-blue-500 sm:hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        value={otpText}
        onChange={handleSingleInputChange}
      />
      <div className="hidden sm:flex sm:w-full sm:justify-between sm:gap-2" onPaste={handlePaste}>
        {value.map((digit, index) => (
          <input
            key={index}
            ref={(el) => { inputRefs.current[index] = el; }}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{1}"
            maxLength={1}
            className="h-12 w-11 rounded-xl border border-gray-300 bg-white text-center text-lg font-bold text-gray-800 outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={digit}
            onChange={(event) => handleChange(index, event)}
            onKeyDown={(event) => handleKeyDown(index, event)}
          />
        ))}
      </div>
    </div>
  );
}

export default function AuthScreen({
  enterAnimationVersion = 0,
  onLogin,
  initialMode = 'login',
  onModeChange,
  forgotOpen = false,
  onForgotModalChange,
  twoFactorOpen = false,
  onTwoFactorModalChange,
  isDark = false,
  toggleTheme,
}) {
  const [mode, setMode] = useState(initialMode === 'register' ? 'register' : 'login');
  const [step, setStep] = useState(forgotOpen ? 'forgot-password' : twoFactorOpen ? '2fa' : 'login');
  const [cardEntered, setCardEntered] = useState(() => isReloadNavigation() && enterAnimationVersion === 0);
  const [containerHeight, setContainerHeight] = useState('auto');
  const loginRef = useRef(null);
  const twoFaRef = useRef(null);
  const forgotRef = useRef(null);
  const loginEmailInputRef = useRef(null);
  const loginPasswordInputRef = useRef(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [socialLoading, setSocialLoading] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [modalData, setModalData] = useState({ type: 'success', title: '', content: '', details: [] });
  const [modalAction, setModalAction] = useState(null);
  const [pendingLoginUser, setPendingLoginUser] = useState(null);
  const [isModalClosing, setIsModalClosing] = useState(false);

  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isInvalidEmail, setIsInvalidEmail] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [forgotResetState, setForgotResetState] = useState('idle');
  const [forgotCodeSent, setForgotCodeSent] = useState(false);

  const [twoFactorCode, setTwoFactorCode] = useState(['', '', '', '', '', '']);
  const [twoFactorUseBackupCode, setTwoFactorUseBackupCode] = useState(false);
  const [twoFactorBackupCode, setTwoFactorBackupCode] = useState('');
  const [twoFactorError, setTwoFactorError] = useState('');
  const [twoFactorVerifying, setTwoFactorVerifying] = useState(false);
  const [twoFactorContext, setTwoFactorContext] = useState(null);

  const trimmedEmail = email.trim();
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const passwordValid = password.trim().length > 0;
  const canSubmit = emailValid && passwordValid;

  const forgotEmailValid = EMAIL_RE.test(forgotEmail.trim());
  const forgotCodeValid = forgotCode.trim().length > 0;
  const forgotPasswordValid = forgotNewPassword.trim().length > 0;
  const canSendCode = forgotEmailValid && !isSendingCode && countdown <= 0 && !isInvalidEmail;
  const canResetForgot = forgotCodeSent && forgotEmailValid && forgotCodeValid && forgotPasswordValid && !isInvalidEmail && !isResettingPassword;

  const twoFactorBackupCodeDigits = twoFactorBackupCode.replace(/\D/g, '').slice(0, 8);
  const isTwoFactorComplete = twoFactorUseBackupCode
    ? twoFactorBackupCodeDigits.length === 8
    : twoFactorCode.join('').length === 6;
  const inputBase = 'w-full rounded-2xl border border-zinc-300 bg-white/90 px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500';

  const syncLoginAutofillToState = () => {
    const emailDomValue = loginEmailInputRef.current?.value || '';
    const passwordDomValue = loginPasswordInputRef.current?.value || '';

    if (emailDomValue) {
      setEmail((prev) => prev || emailDomValue);
    }
    if (passwordDomValue) {
      setPassword((prev) => prev || passwordDomValue);
    }
  };

  const handleInputAnimationStart = (event) => {
    if (event.animationName === 'autofill-start') {
      syncLoginAutofillToState();
    }
  };

  useEffect(() => {
    if (cardEntered) return undefined;
    const frame = window.requestAnimationFrame(() => setCardEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [cardEntered]);

  useEffect(() => {
    if (enterAnimationVersion <= 0) return undefined;
    setCardEntered(false);
    const frame = window.requestAnimationFrame(() => setCardEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [enterAnimationVersion]);

  useEffect(() => {
    const next = initialMode === 'register' ? 'register' : 'login';
    if (next !== mode) setMode(next);
  }, [initialMode, mode]);

  useEffect(() => {
    if (forgotOpen) {
      setStep('forgot-password');
      return;
    }
    if (twoFactorOpen) {
      setStep('2fa');
      return;
    }
    setStep((prev) => (prev === 'forgot-password' || prev === '2fa' ? 'login' : prev));
  }, [forgotOpen, twoFactorOpen]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  useEffect(() => {
    let activeRef = loginRef.current;
    if (step === '2fa') activeRef = twoFaRef.current;
    if (step === 'forgot-password') activeRef = forgotRef.current;
    if (!activeRef) return undefined;
    const frame = window.requestAnimationFrame(() => {
      setContainerHeight(activeRef.offsetHeight);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  useEffect(() => {
    const onPageShow = () => {
      setSocialLoading(null);
      window.requestAnimationFrame(syncLoginAutofillToState);
    };

    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  const openModal = (type, title, content, action = null, details = []) => {
    setModalData({ type, title, content, details: Array.isArray(details) ? details.filter(Boolean) : [] });
    setModalAction(action);
    setIsModalClosing(false);
    setShowModal(true);
  };

  const closeModal = useCallback(() => {
    if (isModalClosing) return;
    setIsModalClosing(true);
    setTimeout(() => {
      setForgotResetState((prev) => (prev === 'error' ? 'idle' : prev));
      setShowModal(false);
      if (modalAction === 'login-success' && pendingLoginUser) {
        onLogin(pendingLoginUser);
      }
      setModalAction(null);
      setPendingLoginUser(null);
      setIsModalClosing(false);
    }, MODAL_CLOSE_MS);
  }, [isModalClosing, modalAction, onLogin, pendingLoginUser]);

  const handleModeSwitch = (nextMode) => {
    const target = nextMode === 'register' ? 'register' : 'login';
    setMode(target);
    setStep('login');
    if (typeof onForgotModalChange === 'function') onForgotModalChange(false);
    if (typeof onTwoFactorModalChange === 'function') onTwoFactorModalChange(false);
    if (typeof onModeChange === 'function') onModeChange(target);
  };

  const handleBackToLogin = useCallback(() => {
    setStep('login');
    if (typeof onForgotModalChange === 'function') onForgotModalChange(false);
    if (typeof onTwoFactorModalChange === 'function') onTwoFactorModalChange(false);
    setForgotEmail('');
    setForgotCode('');
    setForgotNewPassword('');
    setShowForgotPassword(false);
    setIsInvalidEmail(false);
    setCountdown(0);
    setIsSendingCode(false);
    setIsResettingPassword(false);
    setForgotResetState('idle');
    setForgotCodeSent(false);
    setTwoFactorCode(['', '', '', '', '', '']);
    setTwoFactorUseBackupCode(false);
    setTwoFactorBackupCode('');
    setTwoFactorError('');
    setTwoFactorVerifying(false);
    setTwoFactorContext(null);
  }, [onForgotModalChange, onTwoFactorModalChange]);

  useEffect(() => {
    if (forgotResetState !== 'success') return undefined;
    const timer = setTimeout(() => {
      handleBackToLogin();
    }, FORGOT_SUCCESS_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [forgotResetState, handleBackToLogin]);

  useEffect(() => {
    if (!showModal || isModalClosing) return undefined;
    const onKeyDown = (event) => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeModal, showModal, isModalClosing]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      if (mode === 'register') {
        const resp = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            email: trimmedEmail,
            password,
            displayName: trimmedEmail.split('@')[0] || null,
            locale: getLocale(),
            theme: getCurrentThemeForRequest(),
          }),
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok || !payload.ok) {
          openModal('error', t('auth.registerFailedTitle'), mapApiError(payload.error, 'register'));
          return;
        }
        openModal('success', t('auth.verifyEmailTitle'), t('auth.verifyEmailContent'));
        return;
      }

      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      const payload = await resp.json().catch(() => ({}));

      const needTwoFactor = Boolean(payload?.requiresTwoFactor || payload?.twoFactorRequired || payload?.need2FA);
      if (needTwoFactor) {
        if (typeof onForgotModalChange === 'function') onForgotModalChange(false);
        if (typeof onTwoFactorModalChange === 'function') onTwoFactorModalChange(true);
        setTwoFactorContext({
          token: payload?.token || payload?.twoFactorToken || payload?.ticket || null,
          challengeId: payload?.challengeId || payload?.challenge || null,
          user: payload?.user || null,
          email: trimmedEmail,
        });
        setTwoFactorUseBackupCode(false);
        setTwoFactorBackupCode('');
        setTwoFactorCode(['', '', '', '', '', '']);
        setTwoFactorError('');
        setStep('2fa');
        return;
      }

      if (!resp.ok || !payload.ok || !payload.user) {
        openModal('error', t('auth.loginFailedTitle'), mapApiError(payload.error, 'login'));
        return;
      }

      setPendingLoginUser(normalizeUser(payload.user, trimmedEmail));
      openModal('success', t('auth.loginSuccessTitle'), t('auth.loginSuccessContent'), 'login-success');
    } catch {
      openModal('error', t('auth.loginFailedTitle'), t('auth.errorLoginGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyTwoFactor = async (event) => {
    event.preventDefault();
    const code = twoFactorCode.join('');
    if (!twoFactorUseBackupCode && code.length !== 6) {
      setTwoFactorError(t('auth.twoFactorCodeInvalid'));
      return;
    }

    if (twoFactorUseBackupCode && twoFactorBackupCodeDigits.length !== 8) {
      setTwoFactorError(t('auth.twoFactorBackupCodeInvalid'));
      return;
    }

    setTwoFactorVerifying(true);
    setTwoFactorError('');

    try {
      if (!twoFactorContext?.challengeId) {
        setTwoFactorError(t('auth.twoFactorCodeMismatch'));
        return;
      }

      const requestBody = {
        challengeId: twoFactorContext.challengeId,
      };
      if (twoFactorUseBackupCode) {
        requestBody.backupCode = twoFactorBackupCodeDigits;
      } else {
        requestBody.code = code;
      }

      const resp = await fetch('/api/auth/login/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) {
        setTwoFactorError(t('auth.twoFactorCodeMismatch'));
        return;
      }
      const loginUser = normalizeUser(payload?.user || twoFactorContext?.user, twoFactorContext?.email || trimmedEmail);
      if (!loginUser) {
        setTwoFactorError(t('auth.twoFactorCodeMismatch'));
        return;
      }
      if (twoFactorUseBackupCode) {
        await prefetchBackupCodesForProfile({
          ...loginUser,
          recoveryCodes: payload?.recoveryCodes,
        });
      }
      setPendingLoginUser(loginUser);
      openModal('success', t('auth.loginSuccessTitle'), t('auth.loginSuccessContent'), 'login-success');
    } catch {
      setTwoFactorError(t('auth.twoFactorCodeMismatch'));
    } finally {
      setTwoFactorVerifying(false);
    }
  };

  const handleSendCode = async () => {
    const targetEmail = forgotEmail.trim();
    if (!EMAIL_RE.test(targetEmail)) {
      setIsInvalidEmail(true);
      setForgotCodeSent(false);
      return;
    }

    setIsSendingCode(true);
    setIsInvalidEmail(false);
    setForgotCodeSent(false);
    const startedAt = Date.now();

    const waitMinFeedback = async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < SEND_CODE_MIN_FEEDBACK_MS) {
        await sleep(SEND_CODE_MIN_FEEDBACK_MS - elapsed);
      }
    };

    try {
      const resp = await fetch('/api/auth/forgot/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: targetEmail, locale: getLocale() }),
      });
      const payload = await resp.json().catch(() => ({}));
      await waitMinFeedback();
      if (!resp.ok || !payload.ok) {
        setIsInvalidEmail(true);
        setForgotCodeSent(false);
        return;
      }
      setForgotCodeSent(true);
      setCountdown(payload.expiresInSec ? Math.min(payload.expiresInSec, 60) : 60);
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleResetPassword = async (event) => {
    event.preventDefault();
    const targetEmail = forgotEmail.trim();
    const targetCode = forgotCode.trim();
    const targetPassword = forgotNewPassword.trim();
    if (!EMAIL_RE.test(targetEmail) || !targetCode || !targetPassword || !forgotCodeSent) return;

    setIsResettingPassword(true);
    setForgotResetState('idle');

    try {
      const resp = await fetch('/api/auth/forgot/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: targetEmail, code: targetCode, newPassword: targetPassword }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload.ok) {
        setForgotResetState('error');
        if (isForgotResetCodeError(payload?.error)) {
          openModal('error', t('auth.forgotResetFailedTitle'), t('auth.forgotResetErrorInvalidCode'));
          return;
        }
        const detailItems = sortAndMapForgotPasswordErrors(payload?.fieldErrors);
        if (detailItems.length > 0) {
          openModal('error', t('auth.forgotResetFailedTitle'), t('auth.forgotResetErrorSubtitle'), null, detailItems);
          return;
        }
        const codeOrNetworkItems = mapForgotResetError(payload?.error);
        openModal('error', t('auth.forgotResetFailedTitle'), codeOrNetworkItems[0] || t('auth.forgotResetErrorInvalidCode'));
        return;
      }
      markProfileMetaCacheDirtyByEmail(targetEmail, 'forgot-password-reset');
      setForgotResetState('success');
    } catch {
      setForgotResetState('error');
      openModal('error', t('auth.forgotResetFailedTitle'), t('auth.forgotResetErrorSubtitle'), null, [t('auth.errNetworkRequestFailed')]);
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleSocialContinue = async (provider) => {
    if (socialLoading) return;
    setSocialLoading(provider);
    await sleep(SOCIAL_REDIRECT_DELAY_MS);
    window.location.href = `/api/auth/oauth/${provider}`;
  };

  return (
    <div className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 p-4 font-sans dark:from-zinc-900 dark:to-black">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] h-[40%] w-[40%] rounded-full bg-blue-500/20 blur-[100px] dark:bg-blue-700/20" />
      <div className="pointer-events-none absolute -bottom-[10%] -right-[10%] h-[40%] w-[40%] rounded-full bg-cyan-500/20 blur-[100px] dark:bg-cyan-700/20" />

      <div
        className={`relative z-10 w-full max-w-md overflow-hidden rounded-[2rem] border border-white/50 bg-white/70 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-[40px] transition-all duration-500 md:p-7 dark:border-zinc-700/50 dark:bg-zinc-900/70 dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)] ${cardEntered ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0'
          }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.22,1.18,0.36,1)' }}
      >
        <button
          type="button"
          onClick={toggleTheme}
          className="absolute right-5 top-5 z-20 rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {isDark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>

        <div className="text-center">
          <img src="/swaparty.png" alt="SWaParty" className="mx-auto mb-4 block h-auto w-14 object-contain" />
        </div>

        <div className="relative w-full transition-[height] duration-500 ease-in-out" style={{ height: containerHeight === 'auto' ? 'auto' : `${containerHeight}px` }}>
          <div
            ref={loginRef}
            className={`w-full transition-all transform-gpu ${step === 'login'
                ? 'opacity-100 translate-x-0 relative z-10 duration-300 delay-200 ease-out'
                : 'opacity-0 -translate-x-8 absolute top-0 left-0 pointer-events-none z-0 duration-200 ease-in'
              }`}
          >
            <div className="mb-8 text-center">
              <h2 className="mb-2 text-2xl font-bold text-gray-800 dark:text-gray-100">{t('auth.title')}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('auth.subtitle')}</p>
            </div>

            <div className="mb-6 flex justify-center">
              <div className="relative flex h-12 w-full rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
                <span className={`absolute left-1 top-1 h-[calc(100%-0.5rem)] w-[calc(50%-0.25rem)] rounded-lg bg-white shadow-sm transition-transform duration-200 ${mode === 'register' ? 'translate-x-full' : 'translate-x-0'} dark:bg-zinc-700`} />
                <button type="button" onClick={() => handleModeSwitch('login')} className={`elastic-press relative z-10 h-full flex-1 rounded-lg px-5 text-sm font-semibold ${mode === 'login' ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}`} disabled={submitting}>
                  {t('auth.login')}
                </button>
                <button type="button" onClick={() => handleModeSwitch('register')} className={`elastic-press relative z-10 h-full flex-1 rounded-lg px-5 text-sm font-semibold ${mode === 'register' ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}`} disabled={submitting}>
                  {t('auth.register')}
                </button>
              </div>
            </div>

            <div className="mb-4 space-y-3">
              <button type="button" className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-2xl border border-zinc-300 bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" onClick={() => handleSocialContinue('google')} disabled={Boolean(socialLoading)}>
                {socialLoading === 'google' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <GoogleLogo />
                    <span>{t('auth.continueWithGoogle')}</span>
                  </>
                )}
              </button>
              <button type="button" className="inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-2xl border border-zinc-300 bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" onClick={() => handleSocialContinue('github')} disabled={Boolean(socialLoading)}>
                {socialLoading === 'github' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <GitHubLogo />
                    <span>{t('auth.continueWithGithub')}</span>
                  </>
                )}
              </button>
            </div>

            <div className="mb-4 border-t border-zinc-300 dark:border-zinc-700" />

            <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('auth.email')}</label>
                <input
                  ref={loginEmailInputRef}
                  type="email"
                  name="email"
                  autoComplete={mode === 'register' ? 'email' : 'username'}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onAnimationStart={handleInputAnimationStart}
                  className={inputBase}
                  placeholder="you@example.com"
                  required
                  disabled={submitting}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('auth.password')}</label>
                  {mode === 'login' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setStep('forgot-password');
                        if (typeof onForgotModalChange === 'function') onForgotModalChange(true);
                        if (typeof onTwoFactorModalChange === 'function') onTwoFactorModalChange(false);
                      }}
                      className="text-sm font-semibold text-blue-600 dark:text-blue-400"
                      disabled={submitting}
                    >
                      {t('auth.forgotPassword')}
                    </button>
                  ) : null}
                </div>
                <div className="relative">
                  <input
                    ref={loginPasswordInputRef}
                    key={`password-${mode}`}
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onAnimationStart={handleInputAnimationStart}
                    className={`${inputBase} pr-11`}
                    placeholder={mode === 'register' ? t('auth.setPassword') : t('auth.enterPassword')}
                    required
                    disabled={submitting}
                  />
                  <button type="button" onClick={() => setShowPassword((prev) => !prev)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" disabled={submitting}>
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              <p className="my-2 text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                {t('auth.legalPrefix')}
                <a href="/terms" className="font-semibold text-blue-600 dark:text-blue-400">{t('auth.terms')}</a>
                {t('auth.legalJoiner')}
                <a href="/privacy" className="font-semibold text-blue-600 dark:text-blue-400">{t('auth.privacy')}</a>
                {t('auth.legalSuffix')}
              </p>

              <button type="submit" className="elastic-press inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400 disabled:text-zinc-100 dark:disabled:bg-zinc-600 dark:disabled:text-zinc-300" disabled={submitting || !canSubmit}>
                {submitting ? t('auth.pleaseWait') : mode === 'register' ? t('auth.register') : t('auth.login')}
                <ChevronRight className="h-4 w-4" />
              </button>
            </form>

          </div>

          <div
            ref={twoFaRef}
            className={`w-full transition-all transform-gpu ${step === '2fa'
                ? 'opacity-100 translate-x-0 relative z-10 duration-300 delay-200 ease-out'
                : 'opacity-0 translate-x-8 absolute top-0 left-0 pointer-events-none z-0 duration-200 ease-in'
              }`}
          >
            <div className="w-full">
              <button type="button" onClick={handleBackToLogin} className="-ml-1 mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300">
                <ArrowLeft className="h-5 w-5" />
              </button>

              <div className="mb-8 text-center">
                <h2 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t('auth.twoFactorTitle')}</h2>
                <div className="relative h-10">
                  <p
                    className={`absolute left-0 right-0 text-sm text-zinc-500 transition-all duration-300 dark:text-zinc-400 ${twoFactorUseBackupCode ? 'pointer-events-none -translate-x-4 opacity-0' : 'translate-x-0 opacity-100'
                      }`}
                  >
                    {t('auth.twoFactorOtpHint')}
                  </p>
                  <p
                    className={`absolute left-0 right-0 text-sm text-zinc-500 transition-all duration-300 dark:text-zinc-400 ${twoFactorUseBackupCode ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-4 opacity-0'
                      }`}
                  >
                    {t('auth.twoFactorBackupHint')}
                  </p>
                </div>
              </div>

              <form onSubmit={handleVerifyTwoFactor} className="space-y-3">
                <div className="relative h-14 w-full overflow-hidden transition-[height] duration-300">
                  <div
                    className={`absolute left-0 top-0.5 w-full px-2 sm:px-0 transition-all duration-300 ${twoFactorUseBackupCode ? 'pointer-events-none -translate-x-8 opacity-0' : 'translate-x-0 opacity-100'
                      }`}
                  >
                    <TwoFactorOtpInput
                      value={twoFactorCode}
                      onChange={setTwoFactorCode}
                      onErrorClear={() => setTwoFactorError('')}
                    />
                  </div>

                  <div
                    className={`absolute left-0 top-0.5 w-full px-2 transition-all duration-300 ${twoFactorUseBackupCode ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-8 opacity-0'
                      }`}
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      value={twoFactorBackupCode}
                      onChange={(event) => {
                        setTwoFactorBackupCode(event.target.value.replace(/\D/g, '').slice(0, 8));
                        setTwoFactorError('');
                      }}
                      className="h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-center text-lg font-bold tracking-[0.2em] text-gray-800 outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      autoComplete="one-time-code"
                    />
                  </div>
                </div>

                <p
                  className={`min-h-[22px] text-center text-sm font-medium transition-opacity ${twoFactorError ? 'text-rose-500 opacity-100' : 'text-transparent opacity-0'
                    }`}
                  aria-live="polite"
                >
                  {twoFactorError || ' '}
                </p>

                <button type="submit" className="elastic-press inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400 disabled:text-zinc-100 dark:disabled:bg-zinc-600 dark:disabled:text-zinc-300" disabled={!isTwoFactorComplete || twoFactorVerifying}>
                  {twoFactorVerifying ? t('auth.pleaseWait') : t('profile.twoFactorVerify')}
                  <ChevronRight className="h-4 w-4" />
                </button>
              </form>

              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setTwoFactorUseBackupCode((prev) => !prev);
                    setTwoFactorError('');
                    if (twoFactorUseBackupCode) {
                      setTwoFactorBackupCode('');
                    } else {
                      setTwoFactorCode(['', '', '', '', '', '']);
                    }
                  }}
                  className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  {twoFactorUseBackupCode ? t('auth.twoFactorUseAuthenticator') : t('auth.twoFactorUseBackup')}
                </button>
              </div>
            </div>
          </div>

          <div
            ref={forgotRef}
            className={`w-full transition-all transform-gpu ${step === 'forgot-password'
                ? 'opacity-100 translate-x-0 relative z-10 duration-300 delay-200 ease-out'
                : 'opacity-0 translate-x-8 absolute top-0 left-0 pointer-events-none z-0 duration-200 ease-in'
              }`}
          >
            <div className="w-full">
              <button type="button" onClick={handleBackToLogin} className="-ml-1 mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300">
                <ArrowLeft className="h-5 w-5" />
              </button>

              <h2 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t('auth.forgotTitle')}</h2>

              <form onSubmit={handleResetPassword} className="space-y-4" autoComplete="on">
                <div>
                  <input
                    type="email"
                    name="forgot-email"
                    autoComplete="username"
                    value={forgotEmail}
                    onChange={(event) => {
                      setForgotEmail(event.target.value);
                      setIsInvalidEmail(false);
                      setForgotResetState('idle');
                      setForgotCodeSent(false);
                      setCountdown(0);
                    }}
                    className={inputBase}
                    placeholder={t('auth.forgotEmailPlaceholder')}
                    required
                  />
                </div>

                <div className="flex gap-3">
                  <input
                    type="text"
                    name="forgot-code"
                    autoComplete="one-time-code"
                    value={forgotCode}
                    onChange={(event) => { setForgotCode(event.target.value); setForgotResetState('idle'); }}
                    className={`${inputBase} flex-1`}
                    placeholder={t('auth.forgotCodePlaceholder')}
                    required
                  />
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={!canSendCode}
                    className={`elastic-press whitespace-nowrap rounded-2xl px-4 py-3 text-sm font-semibold text-white ${isInvalidEmail ? 'bg-rose-500' : canSendCode ? 'bg-blue-600 hover:bg-blue-700' : 'bg-zinc-400'
                      } disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    {isSendingCode
                      ? t('auth.pleaseWait')
                      : isInvalidEmail
                        ? t('auth.forgotInvalidEmail')
                        : countdown > 0
                          ? t('auth.forgotSent', { sec: countdown })
                          : t('auth.forgotSendCode')}
                  </button>
                </div>

                <div className="relative">
                  <input
                    type={showForgotPassword ? 'text' : 'password'}
                    name="forgot-new-password"
                    autoComplete="new-password"
                    value={forgotNewPassword}
                    onChange={(event) => { setForgotNewPassword(event.target.value); setForgotResetState('idle'); }}
                    className={`${inputBase} pr-11`}
                    placeholder={t('auth.forgotNewPasswordPlaceholder')}
                    required
                  />
                  <button type="button" onClick={() => setShowForgotPassword((prev) => !prev)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500">
                    {showForgotPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>

                <button
                  type="submit"
                  className={`elastic-press inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400 disabled:text-zinc-100 dark:disabled:bg-zinc-600 dark:disabled:text-zinc-300 ${forgotResetState === 'success'
                      ? 'bg-emerald-600'
                      : forgotResetState === 'error'
                        ? 'bg-rose-600'
                        : 'bg-blue-600'
                    }`}
                  disabled={!canResetForgot}
                >
                  {isResettingPassword
                    ? t('auth.pleaseWait')
                    : forgotResetState === 'success'
                      ? t('auth.forgotResetSuccessBtn')
                      : forgotResetState === 'error'
                        ? t('auth.forgotResetFailedBtn')
                        : t('auth.forgotResetConfirm')}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>

      {showModal ? (
        <div className={`modal-overlay ${isModalClosing ? 'closing' : ''}`} onClick={closeModal}>
          <div className={`auth-card modal-content modal-content--compact ${isModalClosing ? 'closing' : ''}`} onClick={(event) => event.stopPropagation()}>
            <div className="modal-sheet-handle" />
            <div className={`modal-aura ${modalData.type === 'error' ? 'is-error' : 'is-success'}`} />
            <div className="modal-body">
              <div className={`modal-icon-badge ${modalData.type === 'error' ? 'is-error' : 'is-success'}`}>
                <div className="modal-icon-core">
                  {modalData.type === 'error'
                    ? (
                      modalData.title === t('auth.loginFailedTitle')
                        ? <XCircle className="modal-icon-glyph h-8 w-8" />
                        : <AlertCircle className="modal-icon-glyph h-8 w-8" />
                    )
                    : <Mail className="modal-icon-glyph h-8 w-8" />}
                </div>
              </div>
              <h3 className="modal-heading">{modalData.title}</h3>
              <p className="modal-copy">{modalData.content}</p>
            </div>
            {modalData.type === 'error' && Array.isArray(modalData.details) && modalData.details.length > 0 ? (
              <div className="modal-list-wrap">
                <ul className="space-y-2.5">
                  {modalData.details.map((item, index) => (
                    <li key={`${item}-${index}`} className="flex items-start bg-red-50/60 dark:bg-red-500/10 p-2.5 rounded-xl border border-red-100/60 dark:border-red-500/20">
                      <XCircle className="w-[18px] h-[18px] text-red-500 flex-shrink-0 mt-[1px] mr-2.5" />
                      <span className="text-[14px] text-red-800 dark:text-red-300 font-medium leading-tight">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="modal-actions single">
              <button type="button" onClick={closeModal} className="modal-btn modal-btn-primary">
                {t('auth.modalAcknowledge')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="w-5 h-5">
      <path fill="#EA4335" d="M24 9.5c3.7 0 7 1.3 9.6 3.8l7.1-7.1C36.5 2.4 30.7 0 24 0 14.6 0 6.4 5.4 2.4 13.2l8.3 6.4C12.8 13.4 17.9 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.6c0-1.6-.1-2.7-.4-4H24v8.1h12.9c-.3 2-1.9 5.1-5.5 7.1l8.5 6.6c5-4.6 7.6-11.4 7.6-17.8z" />
      <path fill="#FBBC05" d="M10.7 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-8.3-6.4C.8 16.4 0 20.1 0 24s.8 7.6 2.4 10.8l8.3-6.4z" />
      <path fill="#34A853" d="M24 48c6.7 0 12.4-2.2 16.6-6l-8.5-6.6c-2.3 1.6-5.3 2.7-8.1 2.7-6.1 0-11.2-3.9-13-9.1l-8.3 6.4C6.4 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="M12 .5C5.6.5.5 5.7.5 12.2c0 5.2 3.3 9.5 8 11.1.6.1.8-.3.8-.6v-2.2c-3.2.7-3.8-1.4-3.8-1.4-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 .1 2.1.8 2.6 1.7.4-.7.8-1.2 1.2-1.5-2.6-.3-5.2-1.3-5.2-5.8 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11 11 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.2 0 4.6-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.3v3.4c0 .4.2.8.8.6 4.7-1.6 8-6 8-11.1C23.5 5.7 18.4.5 12 .5z" />
    </svg>
  );
}
