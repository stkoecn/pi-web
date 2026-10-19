"use client";

import React, { useState, useEffect, useRef } from "react";

/** Background refresh cadence for the device list (visible tabs only). */
const DEVICES_POLL_MS = 15000;

export interface DeviceInfo {
  id: string;
  name: string;
  mode: "active_ssh" | "reverse_tunnel";
  remoteAddr?: string;
  status: "online" | "offline" | "connecting";
  lastSeen?: number;
}

interface Props {
  selectedDeviceId: string;
  onSelectDevice: (deviceId: string) => void;
  onOpenTerminalOnDevice?: (deviceId: string) => void;
}

export function DeviceSelector({
  selectedDeviceId,
  onSelectDevice,
  onOpenTerminalOnDevice,
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

  return (
    <div ref={dropdownRef} style={{ position: "relative", display: "inline-block", height: "100%" }}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) fetchDevices();
        }}
        title={`Current Device: ${currentDevice.name} (${currentDevice.status})`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 10px",
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

        {/* Status dot */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor:
              currentDevice.status === "online"
                ? "#22c55e"
                : currentDevice.status === "connecting"
                ? "#eab308"
                : "#ef4444",
            boxShadow:
              currentDevice.status === "online"
                ? "0 0 6px rgba(34, 197, 94, 0.6)"
                : "none",
            display: "inline-block",
            flexShrink: 0,
          }}
        />

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
              return (
                <div
                  key={device.id}
                  data-device-item={device.id}
                  role="button"
                  tabIndex={0}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "7px 12px",
                    background: isSelected ? "var(--bg-selected, rgba(255,255,255,0.08))" : "transparent",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.04))";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    onSelectDevice(device.id);
                    setOpen(false);
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
                      <span style={{ fontSize: 10, color: "var(--text-dim, #777)" }}>
                        {device.remoteAddr || (device.mode === "reverse_tunnel" ? "Reverse Tunnel" : "Direct")}
                      </span>
                    </div>
                  </div>

                  {onOpenTerminalOnDevice && (
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
                        onSelectDevice(device.id);
                        onOpenTerminalOnDevice(device.id);
                        setOpen(false);
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
              padding: "6px 12px 2px 12px",
              borderTop: "1px solid var(--border, #333)",
              fontSize: 10,
              color: "var(--text-dim, #777)",
              lineHeight: 1.4,
            }}
          >
            <div>反向隧道注册: <code>ssh -NR 0:localhost:22 tunnel@server -p 22222</code></div>
          </div>
        </div>
      )}
    </div>
  );
}
