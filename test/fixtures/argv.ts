export {};

// Records the arguments it was started with, to prove what a shell line really delivers.
await Bun.write(process.argv[2]!, JSON.stringify(process.argv.slice(3)));
