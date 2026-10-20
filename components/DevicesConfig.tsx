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
  ConfigListAction,
  ConfigNotice,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
} from "./SettingsUi";
import {
  draftFromConfig,
  draftProblem,
  draftToBody,
  emptyDraft,
  isSavedId,
  reloadSummary,
  type DeviceConfigEntry,
  type DeviceDraft,
  type DeviceReloadResponse,
  type DevicesResponse,
} from "./devices-config-helpers";

/**
 * The hosts this gateway serves, edited in place.
 *
 * `devices.json` is the source of truth and the gateway reads it once at
 * startup, so every change here has to do two things: write the file, and tell
 * the pool to reconnect only what actually changed. The reload button covers
 * the other direction — the file edited by hand, or by another process.
 */
export function DevicesConfig({
  embedded,
  onClose,
  onDevicesChanged,
}: {
  embedded: boolean;
  onClose: () => void;
  onDevicesChanged?: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<DevicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "delete" | "reload">(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Set when a reload skipped entries: the list alone would not say why a host is missing. */
  const [reloadWarning, setReloadWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      const body = (await res.json()) as DevicesResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body);
      setError(body.fileError ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configs = data?.configs ?? [];
  const runtime = useMemo(
    () => new Map((data?.devices ?? []).map((device) => [device.id, device])),
    [data?.devices],
  );

  // Land on a device rather than an empty pane, the way the other panels do.
  useEffect(() => {
    if (addMode || draft) return;
    if (configs.length === 0) return;
    const first = configs.find((config) => config.id === selectedId) ?? configs[0];
    setSelectedId(first.id);
    setDraft(draftFromConfig(first));
  }, [addMode, configs, draft, selectedId]);

  const select = (config: DeviceConfigEntry) => {
    setAddMode(false);
    setReloadWarning(null);
    setStatus(null);
    setSelectedId(config.id);
    setDraft(draftFromConfig(config));
  };

  const startAdd = () => {
    setAddMode(true);
    setSelectedId(null);
    setDraft(emptyDraft());
    setStatus(null);
    setError(null);
  };

  const problem = draft ? draftProblem(draft) : "devices.problem.id";

  const save = async () => {
    if (!draft) return;
    const key = draftProblem(draft);
    if (key) {
      setError(t(key));
      return;
    }
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      // An id that already exists is an edit, whatever the form was started as:
      // the id is the key the gateway, the URL and every stored session use, so
      // "changing" it means adding a second device.
      const editing = !addMode && isSavedId(configs, draft.id);
      const res = await fetch("/api/devices", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToBody(draft)),
      });
      const body = (await res.json()) as { error?: string; warning?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setAddMode(false);
      setSelectedId(draft.id.trim());
      setStatus(body.warning ?? t("devices.saved"));
      await load();
      onDevicesChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!draft || addMode) return;
    if (!window.confirm(t("devices.deleteConfirm", { name: draft.name || draft.id }))) return;
    setBusy("delete");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/devices?id=${encodeURIComponent(draft.id)}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft(null);
      setSelectedId(null);
      setStatus(t("devices.deleted"));
      await load();
      onDevicesChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const reload = async () => {
    setBusy("reload");
    setError(null);
    setStatus(null);
    setReloadWarning(null);
    try {
      const res = await fetch("/api/devices/reload", { method: "POST" });
      const body = (await res.json()) as DeviceReloadResponse;
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const summary = reloadSummary(body.sync);
      setStatus(body.error ?? (summary === "changed"
        ? t("devices.reloadedChanged", {
          connected: String(body.sync?.connected.length ?? 0),
          removed: String(body.sync?.removed.length ?? 0),
        })
        : t("devices.reloadedUnchanged")));
      if (body.issues && body.issues.length > 0) {
        setReloadWarning(t("devices.reloadIssues", { count: String(body.issues.length) }));
      }
      // Whatever is selected may have been edited on disk: re-read it into the form.
      setDraft(null);
      setAddMode(false);
      await load();
      onDevicesChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const field = (
    label: string,
    key: keyof DeviceDraft,
    extra?: { placeholder?: string; mono?: boolean; type?: string; disabled?: boolean },
  ) => (
    <ConfigField label={label}>
      <input
        className="mcp-add-input settings-device-input"
        type={extra?.type ?? "text"}
        value={draft ? String(draft[key]) : ""}
        placeholder={extra?.placeholder}
        disabled={extra?.disabled}
        style={extra?.mono === false ? { fontFamily: "inherit" } : undefined}
        data-device-field={key}
        onChange={(event) => {
          const value = event.target.value;
          setDraft((current) => (current ? { ...current, [key]: value } : current));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
      />
    </ConfigField>
  );

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.devices")}
      subtitle={data?.configPath ?? ""}
      closeLabel={t("i18n.close")}
      onClose={onClose}
    >
      {error && <ConfigNotice>{error}</ConfigNotice>}
      {reloadWarning && <ConfigNotice>{reloadWarning}</ConfigNotice>}

      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : configs.length === 0 && !addMode ? (
              <div className="config-sidebar-message is-empty">{t("devices.empty")}</div>
            ) : (
              <>
                <ConfigSidebarGroupLabel>{t("devices.groupSaved")}</ConfigSidebarGroupLabel>
                {configs.map((config) => {
                  const live = runtime.get(config.id);
                  const active = !addMode && selectedId === config.id;
                  return (
                    <ConfigSidebarItem
                      key={config.id}
                      active={active}
                      data-device-config-item={config.id}
                      onClick={() => select(config)}
                    >
                      <ConfigStatusDot
                        active={live?.status === "online"}
                        color={live?.status === "connecting" ? "#eab308" : undefined}
                      />
                      <ConfigSidebarText className="is-grow">
                        {config.name || config.id}
                      </ConfigSidebarText>
                      <span className="settings-device-item-state">
                        {t(`devices.status.${live?.status ?? "offline"}`)}
                      </span>
                    </ConfigSidebarItem>
                  );
                })}
                {addMode && (
                  <>
                    <ConfigSidebarGroupLabel>{t("devices.groupNew")}</ConfigSidebarGroupLabel>
                    <ConfigSidebarItem active>
                      <ConfigStatusDot active={false} />
                      <ConfigSidebarText className="is-grow">
                        {draft?.name || draft?.host || t("devices.untitled")}
                      </ConfigSidebarText>
                    </ConfigSidebarItem>
                  </>
                )}
              </>
            )}
            {(data?.issues?.length ?? 0) > 0 && (
              <>
                <ConfigSidebarGroupLabel>{t("devices.groupIssues")}</ConfigSidebarGroupLabel>
                {data?.issues?.map((issue) => (
                  <div key={`${issue.index}-${issue.reason}`} className="config-sidebar-message is-error">
                    {`#${issue.index}${issue.id ? ` (${issue.id})` : ""}: ${issue.reason}`}
                  </div>
                ))}
              </>
            )}
          </ConfigSidebarList>
          <ConfigListAction onClick={startAdd} active={addMode} data-device-add="true">
            {t("devices.add")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!draft ? (
              <ConfigEmptyState>{t("devices.select")}</ConfigEmptyState>
            ) : (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>
                      {addMode ? t("devices.add") : draft.name || draft.id}
                    </ConfigDetailTitle>
                    {!addMode && (
                      <code className="config-detail-subtitle">
                        {runtime.get(draft.id)?.remoteAddr ||
                          (draft.mode === "reverse_tunnel"
                            ? t("devices.mode.reverse_tunnel")
                            : `${draft.host}:${draft.port}`)}
                      </code>
                    )}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton
                      variant="danger"
                      size="small"
                      onClick={() => void remove()}
                      disabled={addMode || busy !== null}
                    >
                      {busy === "delete" ? t("i18n.removing") : t("i18n.remove")}
                    </ConfigButton>
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                <div className="settings-device-form">
                  {field(t("devices.field.id"), "id", { placeholder: "my-vps", disabled: !addMode })}
                  {field(t("devices.field.name"), "name", { placeholder: "My VPS", mono: false })}
                  {/* Which side opens the connection decides whether the fields
                      below are even knowable, so it is asked first. */}
                  <ConfigField label={t("devices.field.mode")}>
                    <div className="settings-device-modes" data-device-field="mode">
                      {(["active_ssh", "reverse_tunnel"] as const).map((mode) => (
                        <label
                          key={mode}
                          className="settings-device-mode"
                          data-device-mode={mode}
                          data-selected={draft.mode === mode}
                        >
                          <input
                            type="radio"
                            name="device-mode"
                            checked={draft.mode === mode}
                            onChange={() => {
                              setDraft((current) => (current ? { ...current, mode } : current));
                            }}
                          />
                          <span>{t(`devices.mode.${mode}`)}</span>
                        </label>
                      ))}
                    </div>
                  </ConfigField>
                  {draft.mode === "reverse_tunnel" ? (
                    <ConfigNotice>
                      {t("devices.modeHint.reverse_tunnel")}
                      <code className="settings-device-command">
                        <span className="settings-device-command-label">{t("devices.tunnelCommand")}</span>
                        {`ssh -N -R 0:localhost:22 ${draft.id.trim() || "<id>"}@<gateway> -p 22222`}
                      </code>
                    </ConfigNotice>
                  ) : (
                    <div className="settings-device-row">
                      {field(t("devices.field.host"), "host", { placeholder: "203.0.113.10" })}
                      {field(t("devices.field.port"), "port", { placeholder: "22" })}
                    </div>
                  )}
                  {field(t("devices.field.username"), "username", { placeholder: "root" })}
                  {field(t("devices.field.privateKeyPath"), "privateKeyPath", { placeholder: "~/.ssh/id_ed25519" })}
                  <ConfigField label={t("devices.field.password")}>
                    <input
                      className="mcp-add-input settings-device-input"
                      type="password"
                      value={draft.password}
                      data-device-field="password"
                      placeholder={draft.hasPassword ? t("devices.passwordSaved") : ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => (current ? { ...current, password: value } : current));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void save();
                      }}
                    />
                  </ConfigField>
                  {field(t("devices.field.defaultCwd"), "defaultCwd", { placeholder: t("devices.defaultCwdPlaceholder") })}
                </div>

                <ConfigNotice>{t("devices.secretNote")}</ConfigNotice>
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={
          <ConfigFooterStatus
            summary={status ?? (problem && draft ? t(problem) : t("devices.footerIdle"))}
            tone={status ? "default" : problem && draft ? "warning" : "default"}
          />
        }
      >
        <ConfigButton onClick={() => void reload()} disabled={busy !== null} data-device-reload="true">
          {busy === "reload" ? t("i18n.loading") : t("devices.reload")}
        </ConfigButton>
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
        <ConfigButton
          variant="primary"
          onClick={() => void save()}
          disabled={busy !== null || !draft || Boolean(problem)}
          data-device-save="true"
        >
          {busy === "save" ? t("i18n.saving") : t("i18n.save")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
