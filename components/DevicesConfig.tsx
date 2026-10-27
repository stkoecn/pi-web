"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
  ConfigSwitch,
} from "./SettingsUi";
import {
  draftFromConfig,
  draftProblem,
  draftToBody,
  emptyDraft,
  reloadSummary,
  type DeviceConfigEntry,
  type DeviceDraft,
  type DeviceReloadResponse,
  type DevicesResponse,
  type SshDiscoveredHost,
} from "./devices-config-helpers";

/**
 * The hosts this gateway serves, edited in place.
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
  /** The `~/.ssh/config` row on screen, when it is not a saved device. */
  const [selectedSshId, setSelectedSshId] = useState<string | null>(null);
  /** Index into `sshProblems` when the reader picked a line the pane cannot use. */
  const [selectedProblem, setSelectedProblem] = useState<number | null>(null);
  const [draft, setDraft] = useState<DeviceDraft | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "delete" | "reload">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyControlId, setBusyControlId] = useState<string | null>(null);
  const [pairingCommand, setPairingCommand] = useState<string>("");
  const [pairingCopied, setPairingCopied] = useState(false);
  const [envInfo, setEnvInfo] = useState<{
    loading: boolean;
    hasPi?: boolean;
    piVersion?: string;
    hasNode?: boolean;
    nodeVersion?: string;
    system?: string;
    error?: string;
  } | null>(null);
  const [installingPi, setInstallingPi] = useState(false);
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

  const fetchPairingCommand = useCallback(async (opts?: { id?: string; name?: string }) => {
    try {
      const qs = new URLSearchParams();
      if (opts?.id) qs.set("id", opts.id);
      if (opts?.name) qs.set("name", opts.name);
      const url = qs.toString() ? `/api/devices/join?${qs.toString()}` : "/api/devices/join";
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const d = await res.json();
        if (d.command) setPairingCommand(d.command);
      }
    } catch {}
  }, []);

  const copyCommand = useCallback((cmd: string) => {
    if (!cmd) return;
    navigator.clipboard?.writeText(cmd).then(() => {
      setPairingCopied(true);
      setTimeout(() => setPairingCopied(false), 2000);
    }).catch(() => {});
  }, []);

  const toggleConnection = useCallback(async (id: string, action: "connect" | "disconnect") => {
    setBusyControlId(id);
    setError(null);
    try {
      const res = await fetch("/api/devices/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const body = (await res.json()) as { success?: boolean; status?: string; error?: string };
      if (!res.ok || body.error) {
        setError(body.error ?? `Failed to ${action} device`);
      } else {
        setStatus(action === "connect" ? t("devices.status.online") : t("devices.status.offline"));
        await load();
        onDevicesChanged?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyControlId(null);
    }
  }, [load, onDevicesChanged, t]);

  const checkEnv = useCallback(async (id: string) => {
    setEnvInfo({ loading: true });
    try {
      const res = await fetch(`/api/devices/env?id=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok || body.error) {
        setEnvInfo({ loading: false, error: body.error ?? "Failed to inspect environment" });
      } else {
        setEnvInfo({
          loading: false,
          hasPi: body.hasPi,
          piVersion: body.piVersion,
          hasNode: body.hasNode,
          nodeVersion: body.nodeVersion,
          system: body.system,
        });
      }
    } catch (err: any) {
      setEnvInfo({ loading: false, error: err?.message || String(err) });
    }
  }, []);

  // Switching a host on or off is a setting, not a connection: an enabled host
  // is still only dialled when someone picks it. Turning one off drops any live
  // connection, so the switcher stops offering a machine the user closed.
  const toggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    setBusyControlId(id);
    setError(null);
    try {
      const res = await fetch("/api/devices/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: enabled ? "enable" : "disable" }),
      });
      const body = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || body.error) {
        setError(body.error ?? `Failed to ${enabled ? "enable" : "disable"} ${id}`);
      } else {
        setStatus(t(enabled ? "devices.enabled" : "devices.disabled", { name: id }));
        await load();
        onDevicesChanged?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyControlId(null);
    }
  }, [load, onDevicesChanged, t]);

  const installPi = useCallback(async (id: string) => {
    setInstallingPi(true);
    try {
      const res = await fetch("/api/devices/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "install_pi" }),
      });
      const body = await res.json();
      if (body.success) {
        setStatus(t("devices.envInstallSuccess"));
        await checkEnv(id);
      } else {
        setError(body.stderr || body.error || t("devices.envInstallFailed"));
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setInstallingPi(false);
    }
  }, [checkEnv, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const configs = data?.configs ?? [];
  const runtime = useMemo(
    () => new Map((data?.devices ?? []).map((device) => [device.id, device])),
    [data?.devices],
  );
  /**
   * The `~/.ssh/config` rows that are not devices yet.
   *
   * A saved device usually also has a stanza, so the unfiltered list would show
   * one machine twice — once as what the gateway dials, once as what ssh knows.
   * The saved row wins: it is the one that can be edited.
   */
  const sshOnlyHosts = useMemo(
    () => (data?.sshHosts ?? []).filter((host) => !configs.some((config) => config.id === host.id)),
    [configs, data?.sshHosts],
  );

  // Land on a device rather than an empty pane, the way the other panels do.
  // An `~/.ssh/config` row is also a reason to stay put: it has no draft, so
  // without this the pane would bounce straight back to the first saved device.
  useEffect(() => {
    if (addMode || draft || selectedSshId || selectedProblem !== null) return;
    if (configs.length === 0) return;
    const first = configs.find((config) => config.id === selectedId) ?? configs[0];
    setSelectedId(first.id);
    const d = draftFromConfig(first);
    setDraft(d);
    void fetchPairingCommand({ id: d.id, name: d.name });
  }, [addMode, configs, draft, fetchPairingCommand, selectedId, selectedProblem, selectedSshId]);

  const select = (config: DeviceConfigEntry) => {
    setAddMode(false);
    setSelectedSshId(null);
    setSelectedProblem(null);
    setReloadWarning(null);
    setStatus(null);
    setSelectedId(config.id);
    const d = draftFromConfig(config);
    setDraft(d);
    const live = runtime.get(config.id);
    if (live?.status === "online") {
      void checkEnv(config.id);
    } else {
      setEnvInfo(null);
    }
    void fetchPairingCommand({ id: d.id, name: d.name });
  };

  /**
   * Show a host from `~/.ssh/config` without writing it anywhere.
   *
   * These rows are not devices: they are what `ssh` already knows. Listing them
   * is the whole feature, so the pane reads them only — no save, no delete, and
   * no `devices.json` entry that would then have to be kept in step with the
   * file ssh owns. A host the gateway already dials is a real device, so it
   * opens as one.
   */
  const showSshHost = (host: SshDiscoveredHost) => {
    const existing = configs.find((config) => config.id === host.id);
    if (existing) {
      select(existing);
      return;
    }
    setAddMode(false);
    setSelectedId(null);
    setSelectedProblem(null);
    setSelectedSshId(host.id);
    setDraft(null);
    setEnvInfo(null);
    setStatus(null);
    setError(null);
    setReloadWarning(null);
  };

  /**
   * A new device is always a reverse tunnel.
   *
   * A dialled host is not typed in here any more: `~/.ssh/config` already says
   * which machines this user reaches and with which key, so the gateway reads
   * it instead. What is left for the form is the one case ssh cannot describe —
   * a machine behind NAT that dials in — and that is what "new" opens.
   */
  const startAdd = () => {
    setAddMode(true);
    setSelectedSshId(null);
    setSelectedProblem(null);
    setSelectedId(null);
    setDraft(emptyDraft());
    setEnvInfo(null);
    setStatus(null);
    setError(null);
    void fetchPairingCommand();
  };

  const problem = draft ? draftProblem(draft) : "devices.problem.id";
  /** The `~/.ssh/config` row being shown, if any. */
  // The switch points at this note, so it needs a stable id: a tooltip alone
  // never shows on a touch screen.
  const switchNoteId = useId();

  const isHostEnabled = useCallback(
    (host: SshDiscoveredHost): boolean => host.enabled ?? false,
    [],
  );

  const sshHost = selectedSshId
    ? (data?.sshHosts ?? []).find((host) => host.id === selectedSshId)
    : undefined;
  const sshProblem =
    selectedProblem === null ? undefined : data?.sshProblems?.[selectedProblem];

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/devices", {
        method: "POST",
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
            ) : configs.length === 0 && sshOnlyHosts.length === 0 && !addMode ? (
              <div className="config-sidebar-message is-empty">{t("devices.empty")}</div>
            ) : (
              <>
                {/* Two parts, because the direction is the one thing that decides
                    how a host behaves: 主动 hosts are dialled by the gateway,
                    被动 ones dial in. It is a property of the whole group, so it
                    is a heading rather than a tag repeated on every row. */}
                {sshOnlyHosts.length > 0 && (
                  <ConfigSidebarGroupLabel>{t("devices.groupActive")}</ConfigSidebarGroupLabel>
                )}
                {sshOnlyHosts.map((host) => {
                  const live = runtime.get(host.id);
                  const active = !addMode && selectedSshId === host.id;
                  return (
                    <ConfigSidebarItem
                      key={`ssh-${host.id}`}
                      active={active}
                      data-device-ssh-item={host.id}
                      onClick={() => showSshHost(host)}
                    >
                      <ConfigStatusDot
                        active={live?.status === "online"}
                        color={live?.status === "connecting" ? "#eab308" : undefined}
                      />
                      <ConfigSidebarText className="is-grow">
                        {host.name}
                      </ConfigSidebarText>
                      <span
                        className="settings-device-item-state"
                        title={host.unsupported ?? undefined}
                        style={host.unsupported ? { color: "#eab308" } : undefined}
                      >
                        {host.unsupported
                          ? host.unsupported
                          : isHostEnabled(host)
                            ? t(`devices.status.${live?.status ?? "offline"}`)
                            : t("devices.status.disabled")}
                      </span>
                    </ConfigSidebarItem>
                  );
                })}
                {(data?.sshProblems ?? []).map((problem, index) => (
                  // A stanza the pane cannot use is a row, not a footnote: it
                  // is a host the reader wrote in the file and expects to see,
                  // so it stays where it would have been and says why.
                  <ConfigSidebarItem
                    key={`ssh-problem-${problem.where}-${index}`}
                    active={selectedProblem === index}
                    data-device-ssh-problem={problem.alias ?? problem.where}
                    title={problem.reason}
                    onClick={() => {
                      setAddMode(false);
                      setSelectedId(null);
                      setSelectedSshId(null);
                      setDraft(null);
                      setStatus(null);
                      setError(null);
                      setReloadWarning(null);
                      setSelectedProblem(index);
                    }}
                  >
                    <span aria-hidden="true" className="settings-device-problem" />
                    <ConfigSidebarText className="is-grow">
                      {problem.alias ?? problem.where}
                    </ConfigSidebarText>
                    <span className="settings-device-item-state">
                      {t("devices.sshProblemShort")}
                    </span>
                  </ConfigSidebarItem>
                ))}
                {(configs.length > 0 || addMode) && (
                  <ConfigSidebarGroupLabel>{t("devices.groupReverse")}</ConfigSidebarGroupLabel>
                )}
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
                        {draft?.name || draft?.id || t("devices.untitled")}
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
            {sshProblem ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>
                      {sshProblem.alias ?? sshProblem.where}
                      <span className="settings-device-kind" data-device-kind="problem">
                        {t("devices.sshProblemShort")}
                      </span>
                    </ConfigDetailTitle>
                    <code className="config-detail-subtitle">{sshProblem.where}</code>
                  </ConfigDetailHeaderInfo>
                </ConfigDetailHeader>
                <ConfigNotice>{sshProblem.reason}</ConfigNotice>
                <ConfigNotice>{t("devices.sshProblemFix")}</ConfigNotice>
              </>
            ) : sshHost ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>
                      {sshHost.name}
                      <span className="settings-device-kind" data-device-kind="active_ssh">
                        {t("devices.kind.active_ssh")}
                      </span>
                    </ConfigDetailTitle>
                    <code className="config-detail-subtitle">
                      {sshHost.username}@{sshHost.host}:{sshHost.port}
                    </code>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {/* The same place a models.json provider keeps its switch:
                        the detail header, next to that host's own buttons. */}
                    <ConfigSwitch
                      checked={isHostEnabled(sshHost)}
                      loading={busyControlId === sshHost.id}
                      label={t("devices.enableHost", { name: sshHost.name })}
                      describedBy={switchNoteId}
                      onChange={(checked) => void toggleEnabled(sshHost.id, checked)}
                    />
                    <ConfigButton
                      size="small"
                      variant={runtime.get(sshHost.id)?.status === "online" ? "secondary" : "primary"}
                      onClick={() =>
                        void toggleConnection(
                          sshHost.id,
                          runtime.get(sshHost.id)?.status === "online" ? "disconnect" : "connect",
                        )
                      }
                      // A host that is off has nothing to dial: the switch is
                      // the only thing that may be clicked until it is on.
                      disabled={busyControlId === sshHost.id || busy !== null || !isHostEnabled(sshHost)}
                    >
                      {busyControlId === sshHost.id
                        ? (runtime.get(sshHost.id)?.status === "online" ? t("devices.disconnecting") : t("devices.connecting"))
                        : (runtime.get(sshHost.id)?.status === "online" ? t("devices.disconnect") : t("devices.connect"))}
                    </ConfigButton>
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                {sshHost.jump && sshHost.jump.length > 0 && (
                  <ConfigNotice>
                    {t("devices.sshJump", { hops: sshHost.jump.join(" → ") })}
                  </ConfigNotice>
                )}

                {/* Off by default: `~/.ssh/config` is an address book, not a list
                    of machines to serve. The note is what the switch points at,
                    because a tooltip never shows on a touch screen. */}
                <p className="settings-device-switch-note" id={switchNoteId}>
                  {isHostEnabled(sshHost) ? t("devices.enabledHint") : t("devices.disabledHint")}
                </p>
                {sshHost.unsupported && (
                  <ConfigNotice>{t("devices.sshUnsupported", { detail: sshHost.unsupported })}</ConfigNotice>
                )}
                {/* Read-only on purpose: these values come from `~/.ssh/config`,
                    and a second editable copy is how the two drift apart. */}
                <div className="settings-device-form">
                  <div className="settings-device-row">
                    <ConfigField label={t("devices.field.host")}>
                      <input
                        className="mcp-add-input settings-device-input"
                        value={sshHost.host}
                        readOnly
                        data-device-field="host"
                      />
                    </ConfigField>
                    <ConfigField label={t("devices.field.port")}>
                      <input
                        className="mcp-add-input settings-device-input"
                        value={String(sshHost.port)}
                        readOnly
                        data-device-field="port"
                      />
                    </ConfigField>
                  </div>
                  <ConfigField label={t("devices.field.username")}>
                    <input
                      className="mcp-add-input settings-device-input"
                      value={sshHost.username}
                      readOnly
                      data-device-field="username"
                    />
                  </ConfigField>
                  {sshHost.privateKeyPath && (
                    <ConfigField label={t("devices.field.privateKeyPath")}>
                      <input
                        className="mcp-add-input settings-device-input"
                        value={sshHost.privateKeyPath}
                        readOnly
                        data-device-field="privateKeyPath"
                      />
                    </ConfigField>
                  )}
                </div>
                <ConfigNotice>{t("devices.sshReadOnly")}</ConfigNotice>
              </>
            ) : !draft ? (
              <ConfigEmptyState>{t("devices.select")}</ConfigEmptyState>
            ) : (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>
                      {addMode ? t("devices.add") : draft.name || draft.id}
                      {!addMode && (
                        <span className="settings-device-kind" data-device-kind="reverse_tunnel">
                          {t("devices.kind.reverse_tunnel")}
                        </span>
                      )}
                    </ConfigDetailTitle>
                    {!addMode && (
                      <code className="config-detail-subtitle">
                        {runtime.get(draft.id)?.remoteAddr || t("devices.mode.reverse_tunnel")}
                      </code>
                    )}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {!addMode && (
                      <ConfigButton
                        size="small"
                        variant={runtime.get(draft.id)?.status === "online" ? "secondary" : "primary"}
                        onClick={() =>
                          void toggleConnection(
                            draft.id,
                            runtime.get(draft.id)?.status === "online" ? "disconnect" : "connect",
                          )
                        }
                        disabled={busyControlId === draft.id || busy !== null}
                      >
                        {busyControlId === draft.id
                          ? (runtime.get(draft.id)?.status === "online" ? t("devices.disconnecting") : t("devices.connecting"))
                          : (runtime.get(draft.id)?.status === "online" ? t("devices.disconnect") : t("devices.connect"))}
                      </ConfigButton>
                    )}
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

                {/* Remote Pi environment status notice (clean & native) */}
                {!addMode && runtime.get(draft.id)?.status === "online" && (
                  <ConfigNotice
                    action={
                      envInfo?.hasPi === false ? (
                        <ConfigButton
                          size="small"
                          variant="primary"
                          onClick={() => void installPi(draft.id)}
                          disabled={installingPi}
                        >
                          {installingPi ? t("devices.envInstalling") : t("devices.envInstall")}
                        </ConfigButton>
                      ) : (
                        <ConfigButton
                          size="small"
                          variant="ghost"
                          onClick={() => void checkEnv(draft.id)}
                          disabled={envInfo?.loading || installingPi}
                        >
                          {envInfo?.loading ? t("i18n.loading") : "刷新检测"}
                        </ConfigButton>
                      )
                    }
                  >
                    {envInfo?.loading ? (
                      <span>{t("devices.envChecking")}</span>
                    ) : envInfo?.error ? (
                      <span>检测失败: {envInfo.error}</span>
                    ) : envInfo?.hasPi ? (
                      <span>
                        pi 环境正常 ({envInfo.piVersion || "最新"}) · Node {envInfo.nodeVersion || "可用"} ({envInfo.system || "Linux"})
                      </span>
                    ) : envInfo?.hasPi === false ? (
                      <span>
                        ⚠️ {t("devices.envMissing")} (Node {envInfo.nodeVersion || "已就绪"})
                      </span>
                    ) : (
                      <span>远程连接正常</span>
                    )}
                  </ConfigNotice>
                )}

                <div className="settings-device-form">
                  {field(t("devices.field.id"), "id", { placeholder: "home-nas", disabled: !addMode })}
                  {field(t("devices.field.name"), "name", { placeholder: "Home NAS", mono: false })}
                  {field(t("devices.field.username"), "username", { placeholder: "windsing" })}
                  {field(t("devices.field.defaultCwd"), "defaultCwd", { placeholder: t("devices.defaultCwdPlaceholder") })}

                  <ConfigNotice
                    action={
                      <ConfigButton
                        size="small"
                        variant="secondary"
                        onClick={() => copyCommand(pairingCommand)}
                        disabled={!pairingCommand}
                      >
                        {pairingCopied ? t("devices.copied") : t("devices.copyCommand")}
                      </ConfigButton>
                    }
                  >
                    {t("devices.tunnelKeyAutoDesc")}
                    <code className="settings-device-command">
                      <span className="settings-device-command-label">{t("devices.tunnelCommand")}</span>
                      {pairingCommand || `curl -fsSL ${typeof window !== "undefined" ? window.location.origin : ""}/api/devices/join | bash`}
                    </code>
                  </ConfigNotice>
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
            summary={
              status ??
              (sshProblem
                ? t("devices.sshProblemShort")
                : sshHost
                  ? t("devices.sshReadOnlyShort")
                  : problem && draft
                    ? t(problem)
                    : t("devices.footerIdle"))
            }
            tone={
              status
                ? "default"
                : sshProblem || (!sshHost && problem && draft)
                  ? "warning"
                  : "default"
            }
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
