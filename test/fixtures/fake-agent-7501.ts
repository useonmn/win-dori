export {};

// fake-agent-7501.sh for Windows (no sh there): reports its status the way hc reads it (OSC 7501) and echoes input.
// Record: ESC ] 7501 ; state=<word>:app=<app> ESC \\. Idle at start; working for 2 s after each line it reads (the line
// is echoed), then idle again. Arguments (a kickoff prompt) are echoed once.
const report = (state: string) => process.stdout.write(`\x1b]7501;state=${state}:app=fake\x1b\\`);
const args = process.argv.slice(2);
if (args.length > 0) process.stdout.write(`kickoff: ${args.join(" ")}\n`);
report("idle");
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  for (let i = buffered.search(/\r?\n/); i >= 0; i = buffered.search(/\r?\n/)) {
    const line = buffered.slice(0, i);
    buffered = buffered.slice(buffered[i] === "\r" ? i + 2 : i + 1);
    report("working");
    process.stdout.write(`echo: ${line}\n`);
    await Bun.sleep(2000);
    report("idle");
  }
}
