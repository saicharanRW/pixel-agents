import { useEffect, useState } from 'react';

import { CHARACTER_SITTING_OFFSET_PX, TOOL_OVERLAY_VERTICAL_OFFSET } from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../engine/officeState.js';
import type { ToolActivity } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs (including static characters from database)
  const staticIds: number[] = [];
  for (const [id, ch] of officeState.characters) {
    if (ch.isStatic) staticIds.push(id);
  }
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id), ...staticIds];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;
        const isStatic = ch.isStatic;

        // Static characters always show their name label
        // Normal agents: only show for hovered or selected (unless always-show is on)
        if (!isStatic && !alwaysShowOverlay && !isSelected && !isHovered) return null;

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY =
          (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr;

        // Get activity text
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (isStatic) {
          activityText = ch.displayName || 'Unknown';
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            const sub = subagentCharacters.find((s) => s.id === id);
            activityText = sub ? sub.label : 'Subtask';
          }
        } else {
          activityText = getActivityText(id, agentTools, ch.isActive);
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;

        let dotColor: string | null = null;
        if (isStatic) {
          dotColor = ch.isActive ? '#4ade80' : '#f59e0b';
        } else if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--pixel-status-active)';
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : '2px solid var(--pixel-border)',
                borderRadius: 0,
                padding: isSelected ? '3px 6px 3px 8px' : '3px 8px',
                boxShadow: 'var(--pixel-shadow)',
                whiteSpace: 'nowrap',
                maxWidth: 220,
              }}
            >
              {dotColor && (
                <span
                  className={isActive && !hasPermission ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ overflow: 'hidden' }}>
                <span
                  style={{
                    fontSize: isSub ? '20px' : '22px',
                    fontStyle: isSub ? 'italic' : undefined,
                    color: 'var(--pixel-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block',
                  }}
                >
                  {activityText}
                </span>
                {isStatic && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: ch.isActive ? '#4ade80' : '#f59e0b',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {ch.isActive ? 'Working' : 'Idle'}{ch.projectName ? ` - ${ch.projectName}` : ''}
                  </span>
                )}
                {ch.folderName && (
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {ch.folderName}
                  </span>
                )}
              </div>
              {isSelected && !isSub && !isStatic && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseAgent(id);
                  }}
                  title="Close agent"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--pixel-close-text)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '26px',
                    lineHeight: 1,
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)';
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {/* Task panel for selected static characters */}
            {isStatic && isSelected && ch.tasks && ch.tasks.length > 0 && (
              <div
                style={{
                  marginTop: 4,
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border-light)',
                  borderRadius: 0,
                  padding: '6px 8px',
                  boxShadow: 'var(--pixel-shadow)',
                  maxWidth: 300,
                  minWidth: 200,
                  maxHeight: 240,
                  overflowY: 'auto',
                  pointerEvents: 'auto',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  style={{
                    fontSize: '16px',
                    color: 'var(--pixel-text-dim)',
                    marginBottom: 4,
                    borderBottom: '1px solid var(--pixel-border)',
                    paddingBottom: 3,
                  }}
                >
                  Tasks ({ch.tasks.length})
                </div>
                {ch.tasks.map((task, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '3px 0',
                      borderBottom:
                        i < ch.tasks!.length - 1 ? '1px solid var(--pixel-border)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span
                        style={{
                          fontSize: '14px',
                          color:
                            task.status === 'In Progress'
                              ? '#4ade80'
                              : task.status === 'Todo'
                                ? '#60a5fa'
                                : 'var(--pixel-text-dim)',
                          flexShrink: 0,
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background:
                            task.status === 'In Progress'
                              ? '#4ade80'
                              : task.status === 'Todo'
                                ? '#60a5fa'
                                : '#6b7280',
                          display: 'inline-block',
                        }}
                      />
                      <span
                        style={{
                          fontSize: '13px',
                          color: 'var(--pixel-accent)',
                          flexShrink: 0,
                        }}
                      >
                        {task.identifier}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '15px',
                        color: 'var(--pixel-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        paddingLeft: 10,
                      }}
                      title={task.title}
                    >
                      {task.title}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {isStatic && isSelected && (!ch.tasks || ch.tasks.length === 0) && (
              <div
                style={{
                  marginTop: 4,
                  background: 'var(--pixel-bg)',
                  border: '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  padding: '6px 10px',
                  boxShadow: 'var(--pixel-shadow)',
                  fontSize: '16px',
                  color: 'var(--pixel-text-dim)',
                }}
              >
                No tasks assigned
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
