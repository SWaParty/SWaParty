import { FileText, Globe, Lock, Moon, Sun } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getLocale, setLocale, t } from '../../i18n';
import { LEGAL_PAGE_PRIVACY, LEGAL_PAGE_TERMS, LEGAL_PRIVACY_PATH, LEGAL_TERMS_PATH } from '../../routes/legalRoutes';
import './LegalScreen.css';

const LANGUAGE_OPTIONS = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
];

export default function LegalScreen({ page = LEGAL_PAGE_PRIVACY, isDark = false, onToggleTheme }) {
  const isPrivacy = page === LEGAL_PAGE_PRIVACY;
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [localeState, setLocaleState] = useState(() => getLocale());
  const [renderVersion, setRenderVersion] = useState(0);
  const langMenuRef = useRef(null);

  const blocks = isPrivacy
    ? t('legal.privacy.blocks')
    : t('legal.terms.blocks');

  const contentBlocks = Array.isArray(blocks) ? blocks : [];
  const currentLocaleLabel = useMemo(
    () => LANGUAGE_OPTIONS.find((item) => item.code === localeState)?.label || localeState,
    [localeState],
  );

  useEffect(() => {
    const onDocClick = (event) => {
      if (!langMenuRef.current) return;
      if (!langMenuRef.current.contains(event.target)) {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const handleLanguageChange = (nextLocale) => {
    const ok = setLocale(nextLocale, { persist: true });
    if (!ok) return;
    setLocaleState(nextLocale);
    setLangMenuOpen(false);
    setRenderVersion((v) => v + 1);
  };

  const handleLegalNav = (event, targetPath) => {
    event.preventDefault();
    if (typeof window === 'undefined') return;
    if (window.location.pathname === targetPath) return;
    window.history.pushState({}, '', targetPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <div className="policy-page" key={renderVersion}>
      <header className="policy-header">
        <div className="policy-header-inner">
          <a href="/" className="policy-logo">SWaParty</a>
          <button
            type="button"
            className="policy-theme-btn"
            onClick={onToggleTheme}
            aria-label={isDark ? 'Switch to light' : 'Switch to dark'}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="policy-main">
        <div className="policy-container">
          <aside className="policy-sidebar">
            <nav className="policy-nav">
              <h3 className="policy-nav-title">{t('legal.navTitle')}</h3>
              <a
                href={LEGAL_PRIVACY_PATH}
                className={`policy-nav-link ${isPrivacy ? 'active' : ''}`}
                onClick={(e) => handleLegalNav(e, LEGAL_PRIVACY_PATH)}
              >
                <Lock className="w-4 h-4" />
                <span>{t('legal.privacy.nav')}</span>
              </a>
              <a
                href={LEGAL_TERMS_PATH}
                className={`policy-nav-link ${!isPrivacy ? 'active' : ''}`}
                onClick={(e) => handleLegalNav(e, LEGAL_TERMS_PATH)}
              >
                <FileText className="w-4 h-4" />
                <span>{t('legal.terms.nav')}</span>
              </a>
            </nav>

            <div className="policy-sidebar-footer">
              <div className={`policy-language ${langMenuOpen ? 'open' : ''}`} ref={langMenuRef}>
                <button
                  type="button"
                  className="policy-language-toggle"
                  aria-haspopup="true"
                  aria-expanded={langMenuOpen ? 'true' : 'false'}
                  onClick={() => setLangMenuOpen((v) => !v)}
                >
                  <span className="policy-language-label">{t('legal.languageLabel')}</span>
                  <span className="policy-language-current">{currentLocaleLabel}</span>
                  <Globe className="w-4 h-4" />
                </button>
                <div className="policy-language-menu">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.code}
                      className="policy-language-option"
                      onClick={() => handleLanguageChange(option.code)}
                      aria-checked={option.code === localeState ? 'true' : 'false'}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="policy-copyright">{t('legal.copyright')}</p>
            </div>
          </aside>

          <section className="policy-content">
            <header className="policy-section-header">
              <h2>{isPrivacy ? t('legal.privacy.title') : t('legal.terms.title')}</h2>
              <p className="policy-section-date">
                {t('legal.effectiveDateLabel')} {isPrivacy ? t('legal.privacy.effectiveDate') : t('legal.terms.effectiveDate')}
              </p>
            </header>
            <article className="policy-section-content">
              {contentBlocks.map((block, index) => (
                <section key={`${page}-block-${index}`} className="policy-block">
                  <h3>{block.heading}</h3>
                  <p>{block.text}</p>
                </section>
              ))}
            </article>
          </section>
        </div>
      </main>
    </div>
  );
}
