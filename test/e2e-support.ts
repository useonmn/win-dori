import { resolve } from "node:path";

export const herdrBin = Bun.which("herdr");
export const cli = resolve(import.meta.dir, "../src/cli.ts");
export const fixture = (name: string) => resolve(import.meta.dir, "fixtures", name);
export const until = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
