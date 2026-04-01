import { useCallback, useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { vscode } from '../vscodeApi.js';
import { SettingsModal } from './SettingsModal.js';

interface PersonInfo {
  id: number;
  name: string;
  isWorking: boolean;
  project: string;
}

function getStaticPeople(os: OfficeState): PersonInfo[] {
  const people: PersonInfo[] = [];
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
    });
  }
  return people;
}

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  workspaceFolders: WorkspaceFolder[];
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  roomNames: string[];
  hiddenRooms: Set<string>;
  onToggleRoom: (room: string) => void;
  officeState: OfficeState;
  agentsTick: number;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
};

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
};

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
};

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  workspaceFolders,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  roomNames,
  hiddenRooms,
  onToggleRoom,
  officeState,
  agentsTick,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRoomsOpen, setIsRoomsOpen] = useState(false);
  const [isTeamOpen, setIsTeamOpen] = useState(false);
  const [teamPeople, setTeamPeople] = useState<PersonInfo[]>([]);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const [hoveredFolder, setHoveredFolder] = useState<number | null>(null);
  const [hoveredBypass, setHoveredBypass] = useState<number | null>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);

  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  // Re-read characters when agentsTick changes or team panel opens
  useEffect(() => {
    if (isTeamOpen) {
      setTeamPeople(getStaticPeople(officeState));
    }
  }, [isTeamOpen, agentsTick, officeState]);

  const toggleTeam = useCallback(() => setIsTeamOpen((prev) => !prev), []);

  const teamWorking = teamPeople.filter((p) => p.isWorking);
  const teamIdle = teamPeople.filter((p) => !p.isWorking);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onOpenClaude();
    }
  };

  const handleAgentRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsFolderPickerOpen(false);
    setIsBypassMenuOpen((v) => !v);
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    vscode.postMessage({ type: 'openClaude', folderPath: folder.path, bypassPermissions });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      vscode.postMessage({ type: 'openClaude', bypassPermissions });
    }
  };

  return (
    <div style={panelStyle}>
      <div ref={folderPickerRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onContextMenu={handleAgentRightClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 12px',
            background:
              hovered === 'agent' || isFolderPickerOpen || isBypassMenuOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isBypassMenuOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              padding: 4,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 180,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            <button
              onClick={() => handleBypassSelect(false)}
              onMouseEnter={() => setHoveredBypass(0)}
              onMouseLeave={() => setHoveredBypass(null)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: '24px',
                color: 'var(--pixel-text)',
                background: hoveredBypass === 0 ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                cursor: 'pointer',
              }}
            >
              Normal
            </button>
            <div style={{ height: 1, margin: '4px 0', background: 'var(--pixel-border)' }} />
            <button
              onClick={() => handleBypassSelect(true)}
              onMouseEnter={() => setHoveredBypass(1)}
              onMouseLeave={() => setHoveredBypass(null)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: '24px',
                color: 'var(--pixel-warning-text)',
                background: hoveredBypass === 1 ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                border: 'none',
                borderRadius: 0,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: '16px' }}>⚡</span> Bypass Permissions
            </button>
          </div>
        )}
        {isFolderPickerOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 160,
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            {workspaceFolders.map((folder, i) => (
              <button
                key={folder.path}
                onClick={() => handleFolderSelect(folder)}
                onMouseEnter={() => setHoveredFolder(i)}
                onMouseLeave={() => setHoveredFolder(null)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: '22px',
                  color: 'var(--pixel-text)',
                  background: hoveredFolder === i ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      {roomNames.length > 0 && (
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setIsRoomsOpen((v) => !v)}
            onMouseEnter={() => setHovered('rooms')}
            onMouseLeave={() => setHovered(null)}
            style={
              isRoomsOpen
                ? { ...btnActive }
                : {
                    ...btnBase,
                    background:
                      hovered === 'rooms' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                  }
            }
            title="Toggle room visibility"
          >
            Rooms
          </button>
          {isRoomsOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 4,
                background: 'var(--pixel-bg)',
                border: '2px solid var(--pixel-border)',
                borderRadius: 0,
                boxShadow: 'var(--pixel-shadow)',
                minWidth: 180,
                maxHeight: 300,
                overflowY: 'auto',
                zIndex: 'var(--pixel-controls-z)',
              }}
            >
              {roomNames.map((room) => {
                const visible = !hiddenRooms.has(room);
                return (
                  <button
                    key={room}
                    onClick={() => onToggleRoom(room)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      gap: 8,
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: '20px',
                      color: visible ? 'var(--pixel-text)' : 'var(--pixel-text-dim)',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 0,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      opacity: visible ? 1 : 0.5,
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 14,
                        height: 14,
                        border: '2px solid var(--pixel-border)',
                        background: visible ? 'var(--pixel-accent)' : 'transparent',
                        flexShrink: 0,
                      }}
                    />
                    {room}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <button
          onClick={toggleTeam}
          onMouseEnter={() => setHovered('team')}
          onMouseLeave={() => setHovered(null)}
          style={
            isTeamOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background:
                    hovered === 'team' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Show team status"
        >
          Team
        </button>
        {isTeamOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              minWidth: 220,
              maxHeight: 300,
              overflowY: 'auto',
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            <div
              style={{
                padding: '4px 10px',
                fontSize: '20px',
                fontWeight: 'bold',
                borderBottom: '1px solid var(--pixel-border)',
                color: '#50fa7b',
              }}
            >
              Working ({teamWorking.length})
            </div>
            {teamWorking.length === 0 && (
              <div
                style={{
                  padding: '3px 10px',
                  fontSize: '18px',
                  color: 'var(--pixel-text-dim)',
                }}
              >
                No one working
              </div>
            )}
            {teamWorking.map((p, i) => (
              <div
                key={`w-${p.id}-${p.project}-${i}`}
                style={{
                  padding: '3px 10px',
                  fontSize: '18px',
                  color: 'var(--pixel-text)',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>{p.name}</span>
                {p.project && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      background: 'rgba(255,255,255,0.06)',
                      padding: '1px 5px',
                      borderRadius: 0,
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    {p.project}
                  </span>
                )}
              </div>
            ))}
            <div
              style={{
                padding: '4px 10px',
                fontSize: '20px',
                fontWeight: 'bold',
                borderBottom: '1px solid var(--pixel-border)',
                color: '#ffb86c',
                marginTop: 2,
              }}
            >
              Idle ({teamIdle.length})
            </div>
            {teamIdle.length === 0 && (
              <div
                style={{
                  padding: '3px 10px',
                  fontSize: '18px',
                  color: 'var(--pixel-text-dim)',
                }}
              >
                No one idle
              </div>
            )}
            {teamIdle.map((p, i) => (
              <div
                key={`i-${p.id}-${p.project}-${i}`}
                style={{
                  padding: '3px 10px',
                  fontSize: '18px',
                  color: 'var(--pixel-text)',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>{p.name}</span>
                {p.project && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      background: 'rgba(255,255,255,0.06)',
                      padding: '1px 5px',
                      borderRadius: 0,
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    {p.project}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background:
                    hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
          alwaysShowOverlay={alwaysShowOverlay}
          onToggleAlwaysShowOverlay={onToggleAlwaysShowOverlay}
          externalAssetDirectories={externalAssetDirectories}
          watchAllSessions={watchAllSessions}
          onToggleWatchAllSessions={onToggleWatchAllSessions}
        />
      </div>
    </div>
  );
}
