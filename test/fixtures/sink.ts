export {};

// The cat of the upstream e2e test: holds the pane on stdin so typed lines are shown, not run. In pwsh cat would be Get-Content.
console.log("SINK_READY");
await Bun.stdin.text();
