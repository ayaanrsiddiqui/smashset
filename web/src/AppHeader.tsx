interface Props {
  eventName: string;
  /** The pool being worked, when the event has more than the one. */
  poolName: string | null;
  accountName: string;
  canSwitchPool: boolean;
  onHelp: () => void;
  onMains: () => void;
  onAccount: () => void;
  onSwitchPool: () => void;
  onSwitchEvent: () => void;
}

/**
 * The same bar on every working screen.
 *
 * It used to exist only on the search/bracket screen, so opening a set took
 * away the only thing saying which tournament, which pool, and which account
 * the report was about to go out under — on the one screen where being wrong
 * about any of those actually costs something.
 */
export function AppHeader({
  eventName,
  poolName,
  accountName,
  canSwitchPool,
  onHelp,
  onMains,
  onAccount,
  onSwitchPool,
  onSwitchEvent,
}: Props) {
  return (
    <header className="app-header">
      <div className="header-where">
        <span className="event-name">{eventName}</span>
        {poolName && <span className="pool-name">{poolName}</span>}
      </div>
      <div className="header-controls">
        <button type="button" className="help-trigger" onClick={onHelp} title="Notation guide" aria-label="Notation guide">
          ?
        </button>
        <button type="button" className="help-trigger" onClick={onMains} title="Player mains" aria-label="Player mains">
          ☺
        </button>
        {/* The account name is the control, rather than a gear beside it: it
            is the thing worth showing, and it opens the same panel. */}
        <button
          type="button"
          className="account-chip"
          onClick={onAccount}
          title="Account"
          // Both halves on purpose: the name is the useful part on screen, and
          // "Account" is what says the button opens something.
          aria-label={`Account — ${accountName}`}
        >
          {accountName}
        </button>
        {canSwitchPool && (
          <button className="settings-link" onClick={onSwitchPool}>
            switch pool
          </button>
        )}
        <button className="settings-link" onClick={onSwitchEvent}>
          switch event
        </button>
      </div>
    </header>
  );
}
