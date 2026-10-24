"use client";

import React, { useState, useEffect, useRef } from "react";

/** Background refresh cadence for the device list (visible tabs only). */
const DEVICES_POLL_MS = 15000;

/** Square size of the compact (phone) button, matching the top bar's icons. */
const COMPACT_BUTTON_SIZE = 36;

export interface DeviceInfo {
  id: string;
  name: string;
  mode: "active_ssh" | "reverse_tunnel";
  remoteAddr?: string;
  status: "online" | "offline" | "connecting";
  lastSeen?: number;
}

/**
 * Whether the switcher may move to this host.
 *
 * An offline host is pickable on purpose: picking it *is* the request to dial
 * it, and the switch only happens once the connection is up. Refusing the click
 * here would leave a sleeping machine with no way back short of Settings.
 */
export function deviceSelectable(_status: DeviceInfo["status"]): boolean {
  return true;
}

interface Props {
  selectedDeviceId: string;
  /**
   * Move to a host. It may dial first, so the dropdown stays open until the
   * answer lands: closing on the click would hide the row that says what is
   * happening, and the switch may still be refused.
   */
  onSelectDevice: (deviceId: string) => void | Promise<void>;
  onOpenTerminalOnDevice?: (deviceId: string) => void;
  onOpenSettings?: (section?: string) => void;
  /**
   * Icon-only form for the phone top bar, where the device name has no room:
   * the server glyph plus the status dot, one square button. The dropdown
   * itself is unchanged, so switching hosts on a phone reaches every device
   * and the same Terminal action.
   */
  compact?: boolean;
  /**
   * Bumped when something outside this component changed the host list, as
   * Settings › Devices does. Without it an edit or a reload would show up only
   * after the next poll.
   */
  refreshKey?: number;
  /**
   * The host a click is currently dialling. The row says so instead of
   * pretending the switch already happened: a first handshake over a WAN link
   * takes seconds, and a row that does nothing for seconds reads as broken.
   */
  connectingDeviceId?: string | null;
}

export function DeviceSelector({
  selectedDeviceId,
  onSelectDevice,
  onOpenTerminalOnDevice,
  onOpenSettings,
  compact = false,
  refreshKey = 0,
  connectingDeviceId = null,
}: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([
    { id: "localhost", name: "Local Host", mode: "active_ssh", status: "online" },
  ]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchDevices = async () => {
    try {
      const res = await fetch("/api/devices");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.devices)) {
          setDevices(data.devices);
        }
      }
    } catch (e) {
      // ignore transient fetch errors
    }
  };

  useEffect(() => {
    // Only poll while the tab is visible: a background tab kept hitting
    // /api/devices every 4 s forever, which was one of the two biggest
    // request sources in the dev server log. Coming back to the tab
    // refreshes immediately, so the badge never looks stale.
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchDevices();
    };
    refresh();
    const interval = setInterval(refresh, DEVICES_POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // An edit in Settings › Devices changed the list *now*: the poll would leave
  // the switcher stale for its whole interval, which reads as "nothing was
  // saved". The first run is the poll's own initial fetch, so it is skipped.
  const refreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKeyRef.current === refreshKey) return;
    refreshKeyRef.current = refreshKey;
    void fetchDevices();
  }, [refreshKey]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const currentDevice = devices.find((d) => d.id === selectedDeviceId) || {
    id: selectedDeviceId,
    name: selectedDeviceId,
    mode: "active_ssh" as const,
    status: "offline" as const,
  };

  const statusColor =
    currentDevice.status === "online"
      ? "#22c55e"
      : currentDevice.status === "connecting"
      ? "#eab308"
      : "#ef4444";

  return (
    <div
      ref={dropdownRef}
      data-device-selector={selectedDeviceId}
      style={{ position: "relative", display: "inline-block", height: "100%" }}
    >
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) fetchDevices();
        }}
        title={`Current Device: ${currentDevice.name} (${currentDevice.status})`}
        aria-label={`Current Device: ${currentDevice.name} (${currentDevice.status})`}
        aria-expanded={open}
        data-device-selector-button="true"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : undefined,
          gap: compact ? 0 : 6,
          height: "100%",
          padding: compact ? 0 : "0 10px",
          width: compact ? COMPACT_BUTTON_SIZE : undefined,
          background: open ? "var(--bg-selected, rgba(255,255,255,0.08))" : "none",
          border: "none",
          borderRight: "1px solid var(--border)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "var(--font-sans, inherit)",
          whiteSpace: "nowrap",
          transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.04))";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "none";
        }}
      >
        {/* Server icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
          <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
          <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
          <line x1="6" x2="6.01" y1="6" y2="6" />
          <line x1="6" x2="6.01" y1="18" y2="18" />
        </svg>

        {/* Status dot. On a phone it rides the corner of the glyph instead of
            taking a slot in the row: the icon alone would not show offline. */}
        <span
          style={{
            width: compact ? 6 : 7,
            height: compact ? 6 : 7,
            borderRadius: "50%",
            backgroundColor: statusColor,
            boxShadow: currentDevice.status === "online" ? "0 0 6px rgba(34, 197, 94, 0.6)" : "none",
            display: "inline-block",
            flexShrink: 0,
            ...(compact
              ? { position: "absolute" as const, right: 7, bottom: 7, pointerEvents: "none" as const }
              : null),
          }}
        />

        {!compact && (
          <>
            <span style={{ maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis" }}>
              {currentDevice.id === "localhost" ? "Local" : currentDevice.name || currentDevice.id}
            </span>

            {/* Caret */}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                opacity: 0.6,
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 1000,
            minWidth: 260,
            background: "var(--bg-panel, #1e1e24)",
            border: "1px solid var(--border, #333)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            padding: "6px 0",
            color: "var(--text)",
            fontFamily: "var(--font-sans, inherit)",
            fontSize: 12,
          }}
        >
          <div
            style={{
              padding: "6px 12px 8px 12px",
              borderBottom: "1px solid var(--border, #333)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 11,
              color: "var(--text-muted, #888)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            <span>SSH Devices Gateway</span>
            <span style={{ fontSize: 10, background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: 4 }}>
              :22222 (R)
            </span>
          </div>

          <div style={{ maxHeight: 240, overflowY: "auto", padding: "4px 0" }}>
            {devices.map((device) => {
              const isSelected = device.id === selectedDeviceId;
              const isOnline = device.status === "online";
              const selectable = deviceSelectable(device.status);
              const connecting = connectingDeviceId === device.id;
              return (
                <div
                  key={device.id}
                  data-device-item={device.id}
                  data-device-disabled={selectable ? undefined : "true"}
                  role="button"
                  tabIndex={selectable ? 0 : -1}
                  aria-disabled={selectable ? undefined : true}
                  title={connecting
                    ? `Connecting to ${device.name || device.id}…`
                    : isOnline
                      ? undefined
                      : `${device.name || device.id} is offline: picking it dials it first`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "7px 12px",
                    background: isSelected ? "var(--bg-selected, rgba(255,255,255,0.08))" : "transparent",
                    cursor: selectable ? "pointer" : "not-allowed",
                    opacity: selectable ? 1 : 0.5,
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected && selectable) e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.04))";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    if (!selectable) return;
                    void Promise.resolve(onSelectDevice(device.id)).then(() => setOpen(false));
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        backgroundColor: isOnline ? "#22c55e" : "#ef4444",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span style={{ fontWeight: isSelected ? 600 : 400, color: "var(--text)" }}>
                        {device.name || device.id}
                        {isSelected && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent, #6366f1)" }}>
                            (active)
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 10, color: connecting ? "var(--accent, #6366f1)" : "var(--text-dim, #777)" }}>
                        {connecting
                          ? "connecting…"
                          : device.remoteAddr || (device.mode === "reverse_tunnel" ? "Reverse Tunnel" : "Direct")}
                      </span>
                    </div>
                  </div>

                  {onOpenTerminalOnDevice && selectable && (
                    <button
                      type="button"
                      title={`Open shell on ${device.name || device.id}`}
                      style={{
                        padding: "3px 8px",
                        fontSize: 11,
                        background: "var(--bg-button, rgba(255,255,255,0.06))",
                        border: "1px solid var(--border, #444)",
                        borderRadius: 4,
                        color: "var(--text)",
                        cursor: "pointer",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void Promise.resolve(onSelectDevice(device.id)).then(() => {
                          onOpenTerminalOnDevice(device.id);
                          setOpen(false);
                        });
                      }}
                    >
                      Terminal
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border, #333)",
              fontSize: 11,
              color: "var(--text-dim, #777)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>✨ 新设备免密接入</span>
            {onOpenSettings && (
              <span
                role="button"
                tabIndex={0}
                style={{
                  color: "var(--accent, #6366f1)",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
                onClick={() => {
                  setOpen(false);
                  onOpenSettings("devices");
                }}
              >
                一键命令 →
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
