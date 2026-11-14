import { run } from "./index.js";

run(process.argv).catch((err: unknown) => {
  console.error(`buildrax: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
