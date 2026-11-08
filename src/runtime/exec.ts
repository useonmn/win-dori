// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

import { resolveCommand } from "../run.ts";

/** `refused`: spawnExec would not run the argv (resolveCommand refused it for a .cmd shim): nothing was sent. */
export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly refused?: true;
};
export type Exec = (cmd: string, argv: readonly string[]) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv) => {
  // On Windows an npm .cmd shim is run through node or a safely quoted cmd.exe line (see run.ts), or refused.
  const resolved = resolveCommand([cmd, ...argv]);
  if ("refused" in resolved) return { code: 126, stdout: "", stderr: resolved.refused, refused: true };
  const proc = Bun.spawn([...resolved.argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(resolved.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. */
export class ToolError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: ExecResult,
    tool: string,
  ) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}
