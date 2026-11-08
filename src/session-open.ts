import { sessionShell, type PaneShell } from "./shell.ts";
import { type CreateSpec, formatRef, type SessionRef, type SessionRuntime } from "./runtime/types.ts";

/**
 * openSession for a command line that depends on the new session's shell (Windows: pwsh, Windows PowerShell, cmd or
 * Git Bash quote differently): create, wait until the shell takes input, read its shell, then start `line(shell)`.
 * A failed start closes the session it created, as openSession does.
 */
export async function openForShell(
  rt: SessionRuntime,
  spec: CreateSpec,
  line: (shell: PaneShell) => string,
  fallback: PaneShell,
): Promise<SessionRef> {
  const ref = await rt.create(spec);
  try {
    await rt.ready?.(ref);
    await rt.start(ref, line(await sessionShell(rt, ref, fallback)));
  } catch (e) {
    await rt.close(ref, "session").catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`dori: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
}
