import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { realSyncRetry, retryTransientSync, type SyncRetryOps } from "./fsx.ts";
import { WORKLOG_MARKER } from "./worklog-render.ts";

// On Windows an editor may have saved the file with CRLF line ends; its first line still carries our marker.
export const ownedOrAbsent = (path: string, windows: boolean): boolean => {
  if (!existsSync(path)) return true;
  const first = readFileSync(path, "utf8").split("\n", 1)[0]!;
  return (windows ? first.replace(/\r$/, "") : first) === WORKLOG_MARKER;
};

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
    if (!ownedOrAbsent(path, retry.windows)) return false;
    retryTransientSync(() => renameSync(tmp, path), retry);
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
};
