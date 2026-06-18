import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Copy, Check, ArrowLeft } from 'lucide-react';
import { useCallback } from 'react';
import { t } from '../../i18n';

function formatTotpSecret(secret) {
  const groups = String(secret || '').replace(/\s+/g, '').match(/.{1,4}/g) || [];
  return groups;
}

function OtpInput({ value, onChange, error, disabled }) {
  const inputsRef = useRef([]);

  const handleChange = (event, index) => {
    const val = event.target.value.replace(/\D/g, '');
    if (!val) return;
    const nextValue = value.split('');
    nextValue[index] = val.charAt(val.length - 1);
    onChange(nextValue.join('').slice(0, 6));
    if (index < 5) inputsRef.current[index + 1]?.focus();
  };

  const handleKeyDown = (event, index) => {
    if (event.key === 'Backspace') {
      const nextValue = value.split('');
      if (nextValue[index]) {
        nextValue[index] = '';
        onChange(nextValue.join(''));
      } else if (index > 0) {
        nextValue[index - 1] = '';
        onChange(nextValue.join(''));
        inputsRef.current[index - 1]?.focus();
      }
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) inputsRef.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < 5) inputsRef.current[index + 1]?.focus();
  };

  const handlePaste = (event) => {
    event.preventDefault();
    const pastedData = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pastedData) return;
    onChange(pastedData);
    const focusIndex = Math.min(pastedData.length, 5);
    inputsRef.current[focusIndex]?.focus();
  };

  return (
    <div className="flex flex-col items-center w-full">
      <div className="flex justify-center w-full gap-2 sm:gap-3 px-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <input
            key={index}
            ref={(el) => {
              inputsRef.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={value[index] || ''}
            onChange={(event) => handleChange(event, index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onPaste={handlePaste}
            disabled={disabled}
            className={`w-12 h-14 sm:w-14 sm:h-16 text-center text-[26px] font-semibold rounded-[16px] transition-all outline-none bg-[#F2F2F7] dark:bg-[#1C1C1E] text-gray-900 dark:text-white caret-blue-500 focus:bg-white dark:focus:bg-[#2C2C2E] border-2 border-transparent focus:border-blue-500 shadow-sm focus:shadow-[0_4px_16px_rgba(0,122,255,0.15)] disabled:opacity-50 ${
              error
                ? '!bg-red-50 !border-red-500 text-red-600 dark:!bg-red-950/30'
                : ''
            }`}
          />
        ))}
      </div>
      <p
        className={`mt-5 min-h-[20px] text-[14px] font-medium transition-opacity ${
          error ? 'text-red-500 opacity-100' : 'text-transparent opacity-0'
        }`}
        aria-live="polite"
      >
        {error || ' '}
      </p>
    </div>
  );
}

export default function TwoFactorSetupModal({ onClose, onComplete, isClosing }) {
  const [step, setStep] = useState(1);
  const [showManualKey, setShowManualKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isPreparing, setIsPreparing] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [setupData, setSetupData] = useState({ secret: '', qrCodeUrl: '' });

  useEffect(() => {
    let alive = true;
    const prepare = async () => {
      setIsPreparing(true);
      setError('');
      try {
        const resp = await fetch('/api/auth/profile/2fa/setup', {
          method: 'POST',
          credentials: 'include',
        });
        const payload = await resp.json().catch(() => ({}));
        if (!alive) return;
        if (!resp.ok || !payload?.ok || !payload?.secret) {
          setError(payload?.error || t('profile.twoFactorCodeMismatch'));
          return;
        }
        setSetupData({
          secret: payload.secret,
          qrCodeUrl: payload.qrCodeUrl || '',
        });
      } catch {
        if (alive) setError(t('profile.twoFactorCodeMismatch'));
      } finally {
        if (alive) setIsPreparing(false);
      }
    };

    prepare();
    return () => {
      alive = false;
    };
  }, []);

  const handleCopy = async () => {
    if (!setupData.secret) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const handleNext = useCallback(async () => {
    if (isPreparing || isVerifying) return;
    if (step === 1) {
      setStep(2);
      return;
    }
    if (code.length < 6) {
      setError(t('profile.twoFactorCodeInvalid'));
      return;
    }

    setIsVerifying(true);
    setError('');
    try {
      const resp = await fetch('/api/auth/profile/2fa/enable', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok || !payload?.ok) {
        setError(t('profile.twoFactorCodeMismatch'));
        return;
      }
      onComplete({ recoveryCodes: payload?.recoveryCodes || [] });
    } catch {
      setError(t('profile.twoFactorCodeMismatch'));
    } finally {
      setIsVerifying(false);
    }
  }, [code, isPreparing, isVerifying, onComplete, step]);

  const handlePrev = () => {
    if (isVerifying) return;
    if (step === 2) {
      setStep(1);
      setError('');
      return;
    }
    onClose();
  };

  useEffect(() => {
    if (isClosing) return undefined;
    const onKeyDown = (event) => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      handleNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleNext, isClosing]);

  return (
    <div
      className={`modal-overlay ${isClosing ? 'closing' : ''}`}
      onClick={onClose}
    >
      <div
        className={`modal-content modal-content--form ${isClosing ? 'closing' : ''} bg-white dark:bg-[#111112] w-full max-w-full rounded-t-[32px] rounded-b-none sm:rounded-[32px] flex flex-col relative overflow-hidden`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-sheet-handle" />
        <div className="modal-aura is-info" />
        <div className="absolute inset-0 pointer-events-none rounded-t-[32px] sm:rounded-[32px] shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] z-20" />

        <div className="pt-6 sm:pt-10 px-6 sm:px-10 relative z-10 flex flex-col items-center w-full" style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
          <div className="w-[64px] h-[64px] mb-4 rounded-[18px] bg-[#F0F7FF] dark:bg-blue-900/20 flex items-center justify-center shadow-[inset_0_0_0_1px_rgba(0,122,255,0.05),0_8px_20px_rgba(0,122,255,0.12)] dark:shadow-[0_8px_20px_rgba(0,122,255,0.15)] relative">
            <div className="absolute inset-0 bg-gradient-to-b from-white/60 to-transparent dark:from-white/5 rounded-[18px]" />
            <ShieldCheck className="modal-icon-glyph w-7 h-7 text-[#007AFF] dark:text-[#0A84FF]" strokeWidth={2} />
          </div>

          <h3 className="text-[22px] font-bold tracking-tight text-gray-900 dark:text-white mb-2">
            {t('profile.twoFactorSetupTitle')}
          </h3>

          <div className="w-full relative flex items-start justify-center mt-2">
            <div className="w-full h-[220px] relative">
              <div className={`absolute inset-0 w-full flex flex-col items-center transition-all duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${step === 1 ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-16 pointer-events-none'}`}>
                <div className={`absolute inset-0 flex flex-col items-center transition-all duration-400 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${showManualKey ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'}`}>
                  <p className="text-[14px] text-gray-500 dark:text-[#A1A1AA] text-center leading-[1.6] mb-5 max-w-[300px] mx-auto">
                    {t('profile.twoFactorStep1Hint')}
                  </p>

                  <div className="relative z-30 p-3 bg-white dark:bg-white rounded-[20px] shadow-[0_8px_24px_rgba(0,0,0,0.04)] border border-gray-100 dark:border-transparent mb-5 w-[124px] h-[124px] flex items-center justify-center">
                    {setupData.qrCodeUrl ? (
                      <img
                        src={setupData.qrCodeUrl}
                        alt="2FA QR"
                        className="w-[100px] h-[100px] object-contain"
                        style={{ imageRendering: 'pixelated' }}
                      />
                    ) : (
                      <div className="w-[100px] h-[100px] rounded-xl bg-gray-100" />
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowManualKey(true)}
                    className="text-[14px] font-medium text-[#007AFF] dark:text-[#0A84FF] transition-colors"
                    disabled={isPreparing}
                  >
                    {t('profile.twoFactorCannotScan')}
                  </button>
                </div>

                <div className={`absolute inset-0 flex flex-col items-center transition-all duration-400 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${!showManualKey ? 'opacity-0 scale-105 pointer-events-none' : 'opacity-100 scale-100'}`}>
                  <p className="text-[14px] text-gray-500 dark:text-[#A1A1AA] text-center leading-[1.6] mb-6 max-w-[300px] mx-auto">
                    {t('profile.twoFactorStep1ManualHint')}
                  </p>

                  <div className="w-full bg-[#F2F2F7] dark:bg-[#1C1C1E] rounded-[20px] p-2 flex items-center justify-between mb-6">
                    <code className="text-[15px] font-mono font-medium text-gray-800 dark:text-gray-200 tracking-[0.1em] pl-2">
                      <span className="inline-grid grid-cols-4 gap-x-3 gap-y-1.5 text-center">
                        {formatTotpSecret(setupData.secret).map((group, index) => (
                          <span key={`${group}-${index}`} className="min-w-[44px]">
                            {group}
                          </span>
                        ))}
                      </span>
                    </code>
                    <button
                      type="button"
                      onClick={handleCopy}
                      disabled={!setupData.secret}
                      className={`p-3 rounded-2xl transition-all shadow-sm ${copied ? 'bg-green-50 text-[#34C759] dark:bg-green-500/10' : 'bg-white dark:bg-[#2C2C2E] text-gray-600 dark:text-gray-300'} disabled:opacity-50`}
                    >
                      {copied ? <Check size={18} strokeWidth={2.5} /> : <Copy size={18} />}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowManualKey(false)}
                    className="text-[14px] font-medium text-[#007AFF] dark:text-[#0A84FF] transition-colors flex items-center gap-1.5"
                  >
                    <ArrowLeft size={16} />
                    {t('profile.twoFactorUseQR')}
                  </button>
                </div>
              </div>

              <div className={`absolute inset-0 w-full flex flex-col items-center justify-center transition-all duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${step === 2 ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-16 pointer-events-none'}`}>
                <p className="text-[14px] text-gray-500 dark:text-[#A1A1AA] text-center leading-[1.6] mb-8">
                  {t('profile.twoFactorStep3Hint')}
                </p>
                <OtpInput
                  value={code}
                  onChange={(val) => {
                    setCode(val);
                    if (error) setError('');
                  }}
                  error={error}
                  disabled={isVerifying}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 w-full mt-4">
            <button
              type="button"
              onClick={handlePrev}
              disabled={isPreparing || isVerifying}
              className="flex-1 py-[14px] rounded-2xl font-semibold text-[15px] transition-all active:scale-[0.98] bg-[#F2F2F7] text-gray-700 dark:bg-[#1C1C1E] dark:text-gray-300 disabled:opacity-50"
            >
              {step === 2 ? t('profile.twoFactorPrev') : t('profile.twoFactorCancel')}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={isPreparing || isVerifying || (step === 2 && code.length !== 6)}
              className="flex-1 py-[14px] rounded-2xl font-semibold text-[15px] transition-all active:scale-[0.98] bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.2)] dark:bg-[#0A84FF] disabled:opacity-50"
            >
              {isPreparing ? t('auth.pleaseWait') : isVerifying ? t('auth.pleaseWait') : step === 2 ? t('profile.twoFactorVerify') : t('profile.twoFactorNext')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
