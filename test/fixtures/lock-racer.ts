import { acquire, release } from "../../src/loop.ts";
import { Store } from "../../src/store.ts";

// One contender for the loop lock in its own process: races on "go", holds what it won until stdin closes.
const d = { store: new Store(process.argv[2]!), now: Date.now };
const stdin = Bun.stdin.stream().getReader();
console.log("READY");
await stdin.read();
const lock = acquire(d);
console.log(JSON.stringify(lock));
while (!(await stdin.read()).done);
if ("nonce" in lock) release(d, lock.nonce);
