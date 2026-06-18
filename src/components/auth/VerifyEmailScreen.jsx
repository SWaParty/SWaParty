import { AlertCircle, ArrowRight, CheckCircle2, Loader2, PartyPopper } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { setLocale, t } from '../../i18n';
import './VerifyEmailScreen.css';

function normalizeLangTag(rawTag) {
  const tag = String(rawTag || '').trim().toLowerCase();
  if (!tag) return null;
  if (tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-CN';
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'zh-TW';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return null;
}

export default function VerifyEmailScreen() {
  const [status, setStatus] = useState('verifying');
  const [busy, setBusy] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get('token') || '';
  const lang = normalizeLangTag(params.get('lang'));

  useEffect(() => {
    if (lang) setLocale(lang, { persist: false });
  }, [lang]);

  const runVerify = async () => {
    if (!token) {
      setStatus('error');
      return;
    }
    setBusy(true);
    setStatus('verifying');
    try {
      const resp = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = await resp.json().catch(() => ({}));
      if (resp.ok && payload?.ok) {
        setStatus('success');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    runVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGoToApp = () => {
    window.location.href = '/';
  };

  return (
    <div className="verify-page">
      <div className="verify-orb verify-orb-left" />
      <div className="verify-orb verify-orb-right" />

      <div className="verify-brand">
        <PartyPopper className="w-6 h-6" />
        <span>SWaParty</span>
      </div>

      <div className="verify-card">
        <div className={`verify-topbar ${status === 'error' ? 'error' : 'normal'}`} />

        <div className="verify-body">
          {status === 'verifying' ? (
            <div className="verify-block">
              <div className="verify-icon-circle verify-icon-circle-info">
                <Loader2 className="w-10 h-10 verify-spin" />
              </div>
              <h2 className="verify-title">{t('verify.verifyingTitle')}</h2>
              <p className="verify-text">{t('verify.verifyingText')}</p>
            </div>
          ) : status === 'success' ? (
            <div className="verify-block">
              <div className="verify-icon-circle verify-icon-circle-success">
                <CheckCircle2 className="w-12 h-12" />
                <div className="verify-ping" />
              </div>
              <h2 className="verify-title">{t('verify.successTitle')}</h2>
              <p className="verify-text">
                {t('verify.successTextPrefix')} <strong>SWaParty</strong> {t('verify.successTextSuffix')}
              </p>
              <button type="button" className="verify-primary-btn verify-btn-group" onClick={handleGoToApp}>
                {t('verify.goToApp')}
                <ArrowRight className="w-5 h-5 verify-btn-arrow" />
              </button>
            </div>
          ) : (
            <div className="verify-block">
              <div className="verify-icon-circle verify-icon-circle-error">
                <AlertCircle className="w-12 h-12" />
              </div>
              <h2 className="verify-title">{t('verify.errorTitle')}</h2>
              <p className="verify-text">{t('verify.errorText')}</p>
              <button type="button" className="verify-secondary-btn" onClick={runVerify} disabled={busy}>
                {busy ? t('auth.pleaseWait') : t('verify.retry')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="verify-footer">{t('verify.footer')}</div>
    </div>
  );
}
