"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigNotice,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";
import { copyText } from "@/lib/clipboard";

interface RosterSession {
  id: string;
  name?: string;
  title?: string;
  description: string;
  updatedAt?: number;
  messageCount?: number;
}

interface RosterProject {
  path: string;
  alias?: string;
  description: string;
  enabled: boolean;
  disambiguatedLabel?: string;
  sessions: RosterSession[];
}

interface RosterDevice {
  deviceId: string;
  online: boolean;
  projects: RosterProject[];
}

export function TeamConfig({ embedded = false, cwd, onClose }: { embedded?: boolean; cwd?: string | null; onClose?: () => void }) {
  const { t } = useI18n();
  const [roster, setRoster] = useState<RosterDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected state
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);

  // Editing state for Project Description
  const [editingProjectDesc, setEditingProjectDesc] = useState<boolean>(false);
  const [projectDescVal, setProjectDescVal] = useState<string>("");
  const [savingProjectDesc, setSavingProjectDesc] = useState(false);

  // Editing state for Session Description
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionDescVal, setEditingSessionDescVal] = useState<string>("");
  const [savingSessionDesc, setSavingSessionDesc] = useState(false);

  const [togglingProject, setTogglingProject] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Collapse states for Enabled vs Disabled groups
  const [enabledCollapsed, setEnabledCollapsed] = useState<boolean>(false);
  const [disabledCollapsed, setDisabledCollapsed] = useState<boolean>(false);

  const fetchRoster = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const url = new URL("/api/mesh/roster", window.location.origin);
      if (cwd) url.searchParams.set("currentCwd", cwd);

      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.success && Array.isArray(data.roster)) {
        setRoster(data.roster);
        // Retain or pick default selection
        const dev = data.roster.find((d: RosterDevice) => d.deviceId === selectedDevice) || data.roster[0];
        if (dev) {
          setSelectedDevice(dev.deviceId);
          if (!selectedProjectPath || !dev.projects.some((p: RosterProject) => p.path === selectedProjectPath)) {
            if (dev.projects.length > 0) {
              setSelectedProjectPath(dev.projects[0].path);
            }
          }
        }
      } else {
        setError(data.error || "Failed to load team roster");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd, selectedDevice, selectedProjectPath]);

  useEffect(() => {
    fetchRoster();
  }, [fetchRoster]);

  const activeDeviceData = useMemo(() => {
    return roster.find((d) => d.deviceId === selectedDevice) || roster[0];
  }, [roster, selectedDevice]);

  const activeProjectData = useMemo(() => {
    if (!activeDeviceData) return null;
    return activeDeviceData.projects.find((p) => p.path === selectedProjectPath) || activeDeviceData.projects[0] || null;
  }, [activeDeviceData, selectedProjectPath]);

  const handleToggleProject = async (targetDevId: string, projectPath: string, currentEnabled: boolean) => {
    if (!cwd) return;
    setTogglingProject(`${targetDevId}:${projectPath}`);
    try {
      await fetch("/api/mesh/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_project_enabled",
          currentCwd: cwd,
          deviceId: targetDevId,
          projectPath,
          enabled: !currentEnabled,
        }),
      });
      await fetchRoster();
    } catch (e) {
      console.error("Failed to toggle project enabled status:", e);
    } finally {
      setTogglingProject(null);
    }
  };

  const handleSaveProjectDesc = async (projectPath: string) => {
    setSavingProjectDesc(true);
    try {
      await fetch("/api/mesh/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_project_description",
          deviceId: selectedDevice,
          projectPath,
          description: projectDescVal.trim(),
        }),
      });
      setEditingProjectDesc(false);
      await fetchRoster();
    } catch (e) {
      console.error("Failed to save project description:", e);
    } finally {
      setSavingProjectDesc(false);
    }
  };

  const handleSaveSessionDesc = async (sessionId: string) => {
    setSavingSessionDesc(true);
    try {
      await fetch("/api/mesh/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_session_description",
          deviceId: selectedDevice,
          sessionId,
          description: editingSessionDescVal.trim(),
        }),
      });
      setEditingSessionId(null);
      await fetchRoster();
    } catch (e) {
      console.error("Failed to save session description:", e);
    } finally {
      setSavingSessionDesc(false);
    }
  };

  const handleCopyTarget = (text: string) => {
    copyText(text).then(() => {
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch((err) => {
      console.warn("Failed to copy text:", err);
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const projectDisplayName = activeProjectData
    ? (activeProjectData.alias || activeProjectData.disambiguatedLabel || activeProjectData.path.split("/").pop() || activeProjectData.path)
    : "";

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.team")}
      subtitle={cwd ? `${cwd}/.pi/team-mesh.json` : "~/.pi/agent/team-mesh.json"}
      closeLabel={t("i18n.close")}
      onClose={onClose ?? (() => {})}
    >
      <ConfigNotice>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          多主机与会话协作网关（Team Mesh）。当前项目默认关闭对其他项目的联络，开启后项目内的 Agent 可通过内置工具 <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>list_session_contact</span> 查询可联系的会话；设置的项目及会话描述也会一并呈现给 Agent。
        </div>
      </ConfigNotice>

      {error && <ConfigNotice>{error}</ConfigNotice>}

      <ConfigSplitView>
        {/* Sidebar: Host and Project navigation grouped by Enabled vs Other (Unopened) */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading && roster.length === 0 ? (
              <div className="config-sidebar-empty">正在加载主机与项目...</div>
            ) : roster.length === 0 ? (
              <div className="config-sidebar-empty">未发现可用设备</div>
            ) : (
              (() => {
                // Group devices/projects into enabled vs disabled
                const enabledDevs = roster.map((dev) => ({
                  ...dev,
                  projects: dev.projects.filter((p) => p.enabled),
                })).filter((dev) => dev.projects.length > 0);

                const disabledDevs = roster.map((dev) => ({
                  ...dev,
                  projects: dev.projects.filter((p) => !p.enabled),
                })).filter((dev) => dev.projects.length > 0);

                const renderDevGroup = (devs: typeof roster) => {
                  return devs.map((dev) => {
                    const isDeviceSelected = selectedDevice === dev.deviceId;
                    return (
                      <div key={dev.deviceId} style={{ marginBottom: 4 }}>
                        <div
                          style={{
                            padding: "4px 12px 2px",
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--text-dim)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ fontFamily: "var(--font-mono)" }}>{dev.deviceId}</span>
                          <span style={{ fontSize: 10, fontWeight: "normal" }}>{dev.online ? "在线" : "离线"}</span>
                        </div>
                        {dev.projects.map((proj) => {
                          const isProjActive = isDeviceSelected && selectedProjectPath === proj.path;
                          const label = proj.alias || proj.disambiguatedLabel || proj.path.split("/").pop() || proj.path;
                          const toggleKey = `${dev.deviceId}:${proj.path}`;
                          const isToggling = togglingProject === toggleKey;

                          return (
                            <ConfigSidebarItem
                              key={proj.path}
                              active={isProjActive}
                              onClick={() => {
                                setSelectedDevice(dev.deviceId);
                                setSelectedProjectPath(proj.path);
                                setEditingSessionId(null);
                                setEditingProjectDesc(false);
                              }}
                            >
                              <ConfigStatusDot active={dev.online} />
                              <ConfigSidebarText className="is-grow" title={proj.path}>
                                {label}
                              </ConfigSidebarText>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-dim)",
                                  fontFamily: "var(--font-mono)",
                                  marginRight: 6,
                                }}
                              >
                                {proj.sessions.length}
                              </span>
                              {/* Direct inline toggle button in sidebar */}
                              {cwd && (
                                <button
                                  type="button"
                                  title={proj.enabled ? "点击在当前项目中关闭此项目联络" : "点击在当前项目中开启此项目联络"}
                                  disabled={isToggling}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleProject(dev.deviceId, proj.path, proj.enabled);
                                  }}
                                  style={{
                                    border: "none",
                                    background: proj.enabled
                                      ? "color-mix(in srgb, var(--accent) 18%, transparent)"
                                      : "color-mix(in srgb, var(--border) 60%, transparent)",
                                    color: proj.enabled ? "var(--accent)" : "var(--text-dim)",
                                    fontSize: 10,
                                    lineHeight: "16px",
                                    padding: "0 6px",
                                    borderRadius: 3,
                                    cursor: isToggling ? "wait" : "pointer",
                                    fontWeight: 500,
                                    flexShrink: 0,
                                    transition: "all 0.15s ease",
                                  }}
                                >
                                  {isToggling ? "..." : proj.enabled ? "关闭" : "开启"}
                                </button>
                              )}
                            </ConfigSidebarItem>
                          );
                        })}
                      </div>
                    );
                  });
                };

                return (
                  <>
                    {/* Top Section: Enabled Projects */}
                    <div
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => setEnabledCollapsed((v) => !v)}
                    >
                      <ConfigSidebarGroupLabel aside={
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span>{enabledDevs.reduce((acc, d) => acc + d.projects.length, 0)} 个项目</span>
                          <span style={{ fontSize: 10, display: "inline-block", transform: enabledCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▼</span>
                        </span>
                      }>
                        已开启联络
                      </ConfigSidebarGroupLabel>
                    </div>

                    {!enabledCollapsed && (
                      enabledDevs.length === 0 ? (
                        <div style={{ padding: "6px 14px 10px", fontSize: 11, color: "var(--text-dim)" }}>
                          暂未开启任何项目的联络
                        </div>
                      ) : (
                        renderDevGroup(enabledDevs)
                      )
                    )}

                    {/* Bottom Section: Disabled/Other Projects */}
                    <div style={{ marginTop: 12 }}>
                      <div
                        style={{ cursor: "pointer", userSelect: "none" }}
                        onClick={() => setDisabledCollapsed((v) => !v)}
                      >
                        <ConfigSidebarGroupLabel aside={
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span>{disabledDevs.reduce((acc, d) => acc + d.projects.length, 0)} 个项目</span>
                            <span style={{ fontSize: 10, display: "inline-block", transform: disabledCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▼</span>
                          </span>
                        }>
                          未开启
                        </ConfigSidebarGroupLabel>
                      </div>

                      {!disabledCollapsed && (
                        disabledDevs.length === 0 ? (
                          <div style={{ padding: "6px 14px 10px", fontSize: 11, color: "var(--text-dim)" }}>
                            所有项目均已开启
                          </div>
                        ) : (
                          renderDevGroup(disabledDevs)
                        )
                      )}
                    </div>
                  </>
                );
              })()
            )}
          </ConfigSidebarList>
        </ConfigSidebar>

        {/* Detail Panel: Project info and Session Roster */}
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {activeProjectData ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>
                      {projectDisplayName}
                      <span className="settings-device-kind" style={{ fontFamily: "var(--font-mono)" }}>
                        @{projectDisplayName}.{selectedDevice}
                      </span>
                    </ConfigDetailTitle>
                    <code className="config-detail-subtitle">{activeProjectData.path}</code>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton
                      size="small"
                      variant="secondary"
                      onClick={() => handleCopyTarget(`@[${activeProjectData.path}].${selectedDevice}`)}
                    >
                      {copiedKey === `@[${activeProjectData.path}].${selectedDevice}` ? "已复制新建目标" : "复制新建目标"}
                    </ConfigButton>
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                {/* Enable for Contact in Current Project */}
                <ConfigField
                  label={
                    <div>
                      <div>在当前项目中开启联络</div>
                      <div style={{ fontSize: 11, fontWeight: "normal", color: "var(--text-dim)", marginTop: 2 }}>
                        {cwd
                          ? "开启后，当前项目中的 Agent 调用 list_session_contact 时可发现并联系该项目的会话（保存在 .pi/team-mesh.json）"
                          : "未打开具体项目，开启状态无法写入项目配置文件"}
                      </div>
                    </div>
                  }
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <ConfigSwitch
                      label="开启联络"
                      checked={activeProjectData.enabled}
                      disabled={!cwd || togglingProject === `${selectedDevice}:${activeProjectData.path}`}
                      onChange={() => handleToggleProject(selectedDevice, activeProjectData.path, activeProjectData.enabled)}
                    />
                    <span style={{ fontSize: 13, color: activeProjectData.enabled ? "var(--text)" : "var(--text-dim)" }}>
                      {activeProjectData.enabled ? "已开启供当前项目联系" : "已关闭（默认关闭）"}
                    </span>
                  </div>
                </ConfigField>

                {/* Project Description */}
                <ConfigField
                  label={
                    <div>
                      <div>项目功能说明 (Description)</div>
                      <div style={{ fontSize: 11, fontWeight: "normal", color: "var(--text-dim)", marginTop: 2 }}>
                        公共配置，保存在网关部署主机的 ~/.pi/agent/team-mesh.json 中，供所有 Agent 查询时了解项目职责。
                      </div>
                    </div>
                  }
                >
                  {editingProjectDesc ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                      <textarea
                        value={projectDescVal}
                        onChange={(e) => setProjectDescVal(e.target.value)}
                        placeholder="例如：主前端工程，负责 Pi Web 页面和用户交互组件开发。"
                        className="config-field-input"
                        rows={3}
                        style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSaveProjectDesc(activeProjectData.path);
                          if (e.key === "Escape") setEditingProjectDesc(false);
                        }}
                      />
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ConfigButton
                          size="small"
                          variant="primary"
                          disabled={savingProjectDesc}
                          onClick={() => handleSaveProjectDesc(activeProjectData.path)}
                        >
                          保存描述
                        </ConfigButton>
                        <ConfigButton
                          size="small"
                          variant="secondary"
                          onClick={() => setEditingProjectDesc(false)}
                        >
                          取消
                        </ConfigButton>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, width: "100%" }}>
                      <span style={{ fontSize: 13, color: activeProjectData.description ? "var(--text)" : "var(--text-dim)", lineHeight: 1.5 }}>
                        {activeProjectData.description || "（未设置项目说明，点击右侧添加）"}
                      </span>
                      <ConfigButton
                        size="small"
                        variant="secondary"
                        onClick={() => {
                          setProjectDescVal(activeProjectData.description || "");
                          setEditingProjectDesc(true);
                        }}
                      >
                        {activeProjectData.description ? "修改说明" : "设置说明"}
                      </ConfigButton>
                    </div>
                  )}
                </ConfigField>

                {/* Sessions Roster */}
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                      项目会话列表 ({activeProjectData.sessions.length})
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      每个会话均可设置独立的功能说明，供 list_session_contact 读取
                    </span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1, paddingRight: 4 }}>
                    {activeProjectData.sessions.length === 0 ? (
                      <ConfigEmptyState>该项目下暂无活跃会话</ConfigEmptyState>
                    ) : (
                      activeProjectData.sessions.map((sess) => {
                        const targetAddress = `${sess.id}.${selectedDevice}`;
                        const isEditingThis = editingSessionId === sess.id;

                        return (
                          <div
                            key={sess.id}
                            style={{
                              padding: "10px 12px",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              background: "color-mix(in srgb, var(--bg-panel) 60%, transparent)",
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 500,
                                    color: "var(--text)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={sess.title || sess.name || sess.id}
                                >
                                  {sess.title || sess.name || `Session ${sess.id.slice(0, 8)}`}
                                </span>
                                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                                  ({sess.id.slice(0, 8)})
                                </span>
                              </div>
                              <ConfigButton
                                size="small"
                                variant="secondary"
                                onClick={() => handleCopyTarget(targetAddress)}
                              >
                                {copiedKey === targetAddress ? "已复制目标" : "复制目标"}
                              </ConfigButton>
                            </div>

                            {/* Session Description */}
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 4, borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>会话说明 (Description):</span>
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
                                  {targetAddress}
                                </span>
                              </div>

                              {isEditingThis ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                                  <textarea
                                    value={editingSessionDescVal}
                                    onChange={(e) => setEditingSessionDescVal(e.target.value)}
                                    placeholder="描述此会话正在进行的任务，例如：负责处理登录模块的缺陷排查"
                                    className="config-field-input"
                                    rows={2}
                                    style={{ width: "100%", fontSize: 12, resize: "vertical", fontFamily: "inherit" }}
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSaveSessionDesc(sess.id);
                                      if (e.key === "Escape") setEditingSessionId(null);
                                    }}
                                  />
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <ConfigButton
                                      size="small"
                                      variant="primary"
                                      disabled={savingSessionDesc}
                                      onClick={() => handleSaveSessionDesc(sess.id)}
                                    >
                                      保存描述
                                    </ConfigButton>
                                    <ConfigButton
                                      size="small"
                                      variant="secondary"
                                      onClick={() => setEditingSessionId(null)}
                                    >
                                      取消
                                    </ConfigButton>
                                  </div>
                                </div>
                              ) : (
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                                  <span style={{ fontSize: 12, color: sess.description ? "var(--text)" : "var(--text-dim)", lineHeight: 1.4 }}>
                                    {sess.description || "未设置说明"}
                                  </span>
                                  <button
                                    type="button"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      padding: 0,
                                      fontSize: 11,
                                      color: "var(--accent)",
                                      cursor: "pointer",
                                      textDecoration: "underline",
                                      flexShrink: 0,
                                    }}
                                    onClick={() => {
                                      setEditingSessionId(sess.id);
                                      setEditingSessionDescVal(sess.description || "");
                                    }}
                                  >
                                    {sess.description ? "修改" : "添加说明"}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            ) : (
              <ConfigEmptyState>请在左侧选择一个项目查看详情</ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter>
        <ConfigFooterStatus
          summary={loading ? "正在同步花名册与设置..." : `共发现 ${roster.reduce((acc, d) => acc + d.projects.length, 0)} 个项目`}
        />
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
