import { useCallback, useEffect, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';

interface PersonInfo {
  id: number;
  name: string;
  isWorking: boolean;
  project: string;
  tasks: Array<{ title: string; identifier: string; status: string; priority: number }>;
}

interface TeamPanelProps {
  officeState: OfficeState;
  /** Trigger re-reads when agents change */
  agentsTick: number;
}

function getStaticPeople(os: OfficeState): PersonInfo[] {
  const people: PersonInfo[] = [];
  // Deduplicate by id+project (same person can appear in multiple projects)
  const seen = new Set<string>();
  for (const [id, ch] of os.characters) {
    if (!ch.isStatic) continue;
    const key = `${id}-${ch.projectName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      id,
      name: ch.displayName ?? `Agent ${id}`,
      isWorking: ch.isActive,
      project: ch.projectName ?? '',
      tasks: ch.tasks ?? [],
    });
  }
  return people;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 50,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  maxHeight: 'calc(100% - 80px)',
  width: 280,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const toggleBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 50,
  padding: '4px 10px',
  fontSize: '20px',
  background: 'var(--pixel-bg)',
  color: 'var(--pixel-text)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  cursor: 'pointer',
  boxShadow: 'var(--pixel-shadow)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 10px',
  borderBottom: '2px solid var(--pixel-border)',
  fontSize: '22px',
  color: 'var(--pixel-text)',
  flexShrink: 0,
};

const sectionHeaderStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '20px',
  fontWeight: 'bold',
  borderBottom: '1px solid var(--pixel-border)',
  flexShrink: 0,
};

const listStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex: 1,
  padding: 0,
  margin: 0,
};

const personStyle: React.CSSProperties = {
  padding: '3px 10px',
  fontSize: '18px',
  color: 'var(--pixel-text)',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const projectBadgeStyle: React.CSSProperties = {
  fontSize: '16px',
  color: 'var(--pixel-text-dim)',
  background: 'rgba(255,255,255,0.06)',
  padding: '1px 5px',
  borderRadius: 0,
  border: '1px solid rgba(255,255,255,0.1)',
};

export function TeamPanel({ officeState, agentsTick }: TeamPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [people, setPeople] = useState<PersonInfo[]>([]);

  // Re-read characters when agentsTick changes or panel opens
  useEffect(() => {
    if (isOpen) {
      setPeople(getStaticPeople(officeState));
    }
  }, [isOpen, agentsTick, officeState]);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const working = people.filter((p) => p.isWorking);
  const idle = people.filter((p) => !p.isWorking);

  if (!isOpen) {
    return (
      <button style={toggleBtnStyle} onClick={toggle} title="Show team status">
        Team
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>Team Status</span>
        <button
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--pixel-text-dim)',
            cursor: 'pointer',
            fontSize: '22px',
            padding: '0 4px',
          }}
          onClick={toggle}
          title="Close"
        >
          X
        </button>
      </div>

      <div style={listStyle}>
        {/* Working section */}
        <div style={{ ...sectionHeaderStyle, color: '#50fa7b' }}>
          Working ({working.length})
        </div>
        {working.length === 0 && (
          <div style={{ ...personStyle, color: 'var(--pixel-text-dim)' }}>No one working</div>
        )}
        {working.map((p, i) => (
          <div key={`w-${p.id}-${p.project}-${i}`} style={personStyle}>
            <span>{p.name}</span>
            {p.project && <span style={projectBadgeStyle}>{p.project}</span>}
          </div>
        ))}

        {/* Idle section */}
        <div style={{ ...sectionHeaderStyle, color: '#ffb86c', marginTop: 2 }}>
          Idle ({idle.length})
        </div>
        {idle.length === 0 && (
          <div style={{ ...personStyle, color: 'var(--pixel-text-dim)' }}>No one idle</div>
        )}
        {idle.map((p, i) => (
          <div key={`i-${p.id}-${p.project}-${i}`} style={personStyle}>
            <span>{p.name}</span>
            {p.project && <span style={projectBadgeStyle}>{p.project}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
