import { FuzzyCell } from './FuzzyCell';
import type { Stage } from './types';

interface Props {
  stages: Stage[];
  value: Stage | null;
  active: boolean;
  onCommit: (item: Stage) => void;
  onCancel: () => void;
  onFocusRequest: () => void;
}

/**
 * Collapsed by default — most TOs don't bother recording stages. Expands
 * into the normal fuzzy stage picker once focused (via keyboard or click),
 * and stays expanded once a stage is actually set.
 */
export function StageToggle({ stages, value, active, onCommit, onCancel, onFocusRequest }: Props) {
  const expanded = active || value != null;

  if (!expanded) {
    return (
      <button
        type="button"
        className="stage-toggle-collapsed"
        onClick={(e) => {
          e.stopPropagation();
          onFocusRequest();
        }}
      >
        ▸ stage
      </button>
    );
  }

  return (
    <div className="stage-toggle-expanded">
      <FuzzyCell
        items={stages}
        value={value}
        placeholder="type a stage…"
        active={active}
        onCommit={onCommit}
        onCancel={onCancel}
        onFocusRequest={onFocusRequest}
      />
    </div>
  );
}
