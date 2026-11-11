import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { realSyncRetry, retryTransientSync, type SyncRetryOps } from "./fsx.ts";
import { WORKLOG_MARKER } from "./worklog-render.ts";

export const ownedOrAbsent = (path: string): boolean =>
  !existsSync(path) || readFileSync(path, "utf8").split("\n", 1)[0] === WORKLOG_MARKER;

/**
 * Write a rendered worklog.md through a temp file and rename, so a reader never sees half a file. The marker is checked
 * again right before the rename: a file someone wrote meanwhile is kept, and this publish is skipped (returns false).
 * beforeCheck runs between the temp write and that check. On Windows a rename refused while a concurrent writer or
 * reader has worklog.md open is retried.
 */
export const publishWorklog = (
  path: string,
  markdown: string,
  beforeCheck: () => void = () => {},
  retry: SyncRetryOps = realSyncRetry,
): boolean => {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, markdown, { encoding: "utf8", mode: 0o600 });
    beforeCheck();
    if (!ownedOrAbsent(path)) return false;
    retryTransientSync(() => renameSync(tmp, path), retry);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
};
