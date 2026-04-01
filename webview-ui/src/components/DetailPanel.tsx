import type { OfficeState } from '../office/engine/officeState.js';

interface DetailPanelProps {
  officeState: OfficeState;
  onClose: () => void;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  zIndex: 50,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  maxHeight: 'calc(100% - 80px)',
  width: 320,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 10px',
  borderBottom: '2px solid var(--pixel-border)',
  flexShrink: 0,
};

export function DetailPanel({ officeState, onClose }: DetailPanelProps) {
  const selectedId = officeState.selectedAgentId;
  if (selectedId === null) return null;

  const ch = officeState.characters.get(selectedId);
  if (!ch || !ch.isStatic) return null;

  const tasks = ch.tasks ?? [];
  const isWorking = ch.isActive;

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: '24px', color: 'var(--pixel-accent)' }}>
            {ch.displayName ?? 'Unknown'}
          </div>
          <div
            style={{
              fontSize: '18px',
              color: isWorking ? '#4ade80' : '#f59e0b',
              marginTop: 2,
            }}
          >
            {isWorking ? 'Working' : 'Idle'}
            {ch.projectName ? ` — ${ch.projectName}` : ''}
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--pixel-text-dim)',
            cursor: 'pointer',
            fontSize: '24px',
            padding: '0 4px',
            alignSelf: 'flex-start',
          }}
        >
          X
        </button>
      </div>

      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--pixel-border)',
          fontSize: '20px',
          color: 'var(--pixel-text-dim)',
          flexShrink: 0,
        }}
      >
        Tasks ({tasks.length})
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
        {tasks.length === 0 && (
          <div
            style={{
              padding: '10px',
              fontSize: '18px',
              color: 'var(--pixel-text-dim)',
              textAlign: 'center',
            }}
          >
            No tasks assigned
          </div>
        )}
        {tasks.map((task, i) => (
          <div
            key={i}
            style={{
              padding: '6px 10px',
              borderBottom:
                i < tasks.length - 1 ? '1px solid var(--pixel-border)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background:
                    task.status === 'In Progress'
                      ? '#4ade80'
                      : task.status === 'Todo'
                        ? '#60a5fa'
                        : '#6b7280',
                  flexShrink: 0,
                  display: 'inline-block',
                }}
              />
              <span
                style={{
                  fontSize: '16px',
                  color: 'var(--pixel-accent)',
                  flexShrink: 0,
                }}
              >
                {task.identifier}
              </span>
              <span
                style={{
                  fontSize: '14px',
                  color:
                    task.status === 'In Progress'
                      ? '#4ade80'
                      : task.status === 'Todo'
                        ? '#60a5fa'
                        : 'var(--pixel-text-dim)',
                  marginLeft: 'auto',
                  flexShrink: 0,
                }}
              >
                {task.status}
              </span>
            </div>
            <div
              style={{
                fontSize: '18px',
                color: 'var(--pixel-text)',
                paddingLeft: 14,
                wordWrap: 'break-word',
              }}
            >
              {task.title}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
