import { createContext, useContext } from "react";
import type { NoticeActionKind, NoticeView } from "../../backend/sync/noticeActions";
import type { ReapplyResult } from "../../backend/sync/leftBehind";
import type { EngineState, LeftBehindView } from "../../backend/sync/SyncEngine";

/** What the GitHub tree reads from <SyncHost> (design section 11): the
 * engine's state as it stands (status, pendingCount, deviceSaveFailed, the
 * counts to review, a damaged file, a gone epoch, a restore under way),
 * syncNow, and, added by stage 7, the notices and the changes a restore
 * left behind, with what can be done about them. "Forget this device" (#8)
 * and restore (#9) use syncNow. */
export interface SyncStateValue extends EngineState {
  /** Newest first, each with what its actions would write now. */
  notices: NoticeView[];
  /** This device's own groups first (D18), then other devices'. */
  leftBehind: LeftBehindView[];
  syncNow(): Promise<void>;
  noticeAction(key: string, kind: NoticeActionKind): Promise<void>;
  dismissNotice(key: string): Promise<void>;
  reapply(id: string): Promise<ReapplyResult>;
  discard(id: string): Promise<void>;
}

export const SyncContext = createContext<SyncStateValue | null>(null);

/** The sync state of the <SyncHost> above. Throws outside one. */
export function useSyncState(): SyncStateValue {
  const value = useContext(SyncContext);
  if (value === null) throw new Error("useSyncState() needs a <SyncHost> above it");
  return value;
}
