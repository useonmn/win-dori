export {};

const [cli, kickoff] = process.argv.slice(2);
if (!cli || !kickoff) {
  console.error("usage: fake-agent <cli.ts> <kickoff>");
  process.exit(2);
}
const lane = process.env["DORI_LANE"];
if (!lane) {
  console.error("fake-agent: DORI_LANE is not set");
  process.exit(2);
}
const brief = /Read your brief at (.*) and execute it\./.exec(kickoff)?.[1];
if (!brief) {
  console.error(`fake-agent: no brief path in kickoff: ${kickoff}`);
  process.exit(2);
}

const dori = async (...argv: string[]): Promise<void> => {
  const p = Bun.spawn([process.execPath, cli, ...argv], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`dori ${argv.join(" ")} -> ${code}: ${err}`);
};

const first = (await Bun.file(brief).text()).split(/\r?\n/)[0] ?? "";
await dori("report", lane, "--text", `read brief: ${first}`);
await dori("ready", lane, "--text", "e2e lane finished", "--evidence", `file://${brief}`);
