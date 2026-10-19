"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NewSessionContext, NewSessionTarget, ProjectChoice } from "@/lib/new-session-context";
import { focusIfLost } from "@/lib/stacked-dialog";
import { withDeviceId } from "@/lib/device-context";
import { ProjectWorktreePicker, type ProjectWorktreeControl, type ProjectWorktreePickerHandle } from "./ProjectWorktreePicker";

/** The bar's two controls. A move names the one it came from, which takes focus in the bar that replaces this one. */
export type NewSessionContextControl = ProjectWorktreeControl;

interface Props {
  context: NewSessionContext;
  /** A phone: the menus open as bottom sheets. */
  mobile: boolean;
  /** The control the move that mounted this bar came from: it takes focus once, if focus fell to the page. */
  initialFocus: NewSessionContextControl | null;
  onInitialFocusDone: () => void;
  /** Start the fresh composer over in `target`; the shell ignores a move to where it already is. */
  onPick: (target: NewSessionTarget, from: NewSessionContextControl) => void;
  /** "Use default directory": today's folder, which goes to `onPick`. */
  onUseDefaultDirectory: () => void;
  /** "Open another project…": the folder picker, which hands its folder to `onPick`. */
  onOpenFolder: (opener: HTMLElement | null) => void;
  onRefreshWorktrees: () => void;
  onCreateWorktree: (project: ProjectChoice, branch: string) => Promise<{ path: string } | { error: string }>;
  /** The gateway device this bar's session will run on; its home path differs. */
  deviceId?: string;
}

// The home folder the paths (the menus', a detached checkout's in the
// worktree button) show as ~, asked for once per page: the bar mounts again
// with every move of the fresh composer.
// One lookup per device: the home path differs per device (`/root` on a VPS),
// and the bar remounts with every move of the fresh composer.
const homeDirChecks = new Map<string, Promise<string>>();
const homeDirValues = new Map<string, string>();
function loadHomeDir(deviceId: string = "localhost"): Promise<string> {
  const cached = homeDirChecks.get(deviceId);
  if (cached) return cached;
  const promise = fetch(withDeviceId("/api/home", deviceId))
    .then((response) => response.json())
    .then((data: { home?: string }) => {
      const home = data.home ?? "";
      homeDirValues.set(deviceId, home);
      return home;
    })
    .catch(() => {
      homeDirChecks.delete(deviceId);
      return "";
    });
  homeDirChecks.set(deviceId, promise);
  return promise;
}

/**
 * The project and worktree a fresh composer starts its session in: a row of
 * its own in the empty new-session page's header, under the brand and right
 * above the composer. The files tab's picker
 * (components/ProjectWorktreePicker.tsx) laid out inline: the project's name
 * and the worktree's branch as text, its group named by the label alone (no
 * visible one: the folder icon says it). Every pick starts the composer over
 * in the new folder (the shell remounts it, carrying the draft and its model
 * picks), so this bar only reports what was chosen; the sidebar keeps the cwd.
 */
export function NewSessionContextBar({
  context,
  mobile,
  initialFocus,
  onInitialFocusDone,
  onPick,
  onUseDefaultDirectory,
  onOpenFolder,
  onRefreshWorktrees,
  onCreateWorktree,
  deviceId = "localhost",
}: Props) {
  const { t } = useI18n();
  const [homeDir, setHomeDir] = useState(() => homeDirValues.get(deviceId) ?? "");
  const pickerRef = useRef<ProjectWorktreePickerHandle>(null);
  const initialFocusRef = useRef(initialFocus);
  const onInitialFocusDoneRef = useRef(onInitialFocusDone);
  onInitialFocusDoneRef.current = onInitialFocusDone;

  useEffect(() => {
    if (homeDirValues.get(deviceId)) return;
    let cancelled = false;
    void loadHomeDir(deviceId).then((home) => {
      if (!cancelled && home) setHomeDir(home);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The control that moved the composer went away with it: its counterpart
  // here takes focus, so a keyboard user goes on from where they were.
  useEffect(() => {
    const from = initialFocusRef.current;
    if (!from) return;
    initialFocusRef.current = null;
    onInitialFocusDoneRef.current();
    const picker = pickerRef.current;
    focusIfLost(document, (from === "worktree" ? picker?.button("worktree") : null) ?? picker?.button("project") ?? null);
  }, []);

  return (
    <div className="new-session-context">
      <ProjectWorktreePicker
        handleRef={pickerRef}
        layout="inline"
        context={context}
        mobile={mobile}
        label={t("workspace.newSessionContext")}
        homeDir={homeDir}
        newWorktreeTitle={t("sidebar.newWorktreeForSession")}
        onPick={onPick}
        onUseDefaultDirectory={onUseDefaultDirectory}
        onOpenFolder={onOpenFolder}
        onRefreshWorktrees={onRefreshWorktrees}
        onCreateWorktree={onCreateWorktree}
      />
    </div>
  );
}
