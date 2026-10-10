import { useEffect, useState } from 'react';
import { LoadingNote } from './Loading';
import { setTheme, storedTheme, type ThemeChoice } from './theme';
import type { AccountDetails } from './types';

interface Props {
  account: AccountDetails | null;
  accountError: boolean;
  onClose: () => void;
  onTopXChange: (value: number | null) => void;
  onSignOut: () => void;
  /** Present only for an admin; the server refuses the page to anyone else regardless. */
  onOpenAdmin?: () => void;
}

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AccountModal({ account, accountError, onClose, onTopXChange, onSignOut, onOpenAdmin }: Props) {
  const [theme, setThemeChoice] = useState<ThemeChoice>(storedTheme);

  function chooseTheme(choice: ThemeChoice) {
    setThemeChoice(choice);
    setTheme(choice);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="help-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="help-modal-body">
          <h2 id="account-modal-title">Account</h2>

          {accountError && <p className="error">Couldn't load your account details. Try closing and reopening this.</p>}
          {!account && !accountError && <LoadingNote>Loading your account…</LoadingNote>}

          {account && (
            <>
              <section className="account-section">
                <div className="account-identity">
                  <span className="account-name">{account.displayName}</span>
                  {account.startggSlug && (
                    <a
                      className="account-profile-link"
                      href={`https://www.start.gg/${account.startggSlug}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view start.gg profile
                    </a>
                  )}
                </div>
                <button type="button" className="account-sign-out" onClick={onSignOut}>
                  sign out
                </button>
              </section>

              <section className="account-section">
                <h3>Preferences</h3>
                <label className="account-top-x" htmlFor="account-top-x-input">
                  <span>Top</span>
                  <input
                    id="account-top-x-input"
                    type="number"
                    min={1}
                    step={1}
                    value={account.topXBo5 ?? ''}
                    placeholder="—"
                    onChange={(e) => onTopXChange(e.target.value ? Number(e.target.value) : null)}
                  />
                  <span>= Bo5</span>
                </label>
                <p className="account-top-x-hint">
                  When reporting, a set whose loser will place at or above this number auto-selects Bo5. Leave blank
                  to always guess from the round name instead.
                </p>

                <div className="account-theme" role="group" aria-label="Appearance">
                  <span className="account-theme-label">Appearance</span>
                  <div className="account-theme-options">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={theme === option.value ? 'selected' : ''}
                        aria-pressed={theme === option.value}
                        onClick={() => chooseTheme(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="account-top-x-hint">
                  Stored on this device. A bracket table outdoors wants the light one whatever the phone is set to.
                </p>
              </section>

              {onOpenAdmin && (
                <section className="account-section">
                  <h3>Admin</h3>
                  <button type="button" className="account-admin-link" onClick={onOpenAdmin}>
                    sets reported with smashset
                  </button>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
