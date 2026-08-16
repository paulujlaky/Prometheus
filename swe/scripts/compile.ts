import { rmSync, writeFileSync } from "node:fs";

import { $ } from "bun";

rmSync("swe/dist", { recursive: true, force: true });

const [vite, main, preload] = await Promise.all([

  $`vite build --config vite.config.ts`.nothrow(),
  $`bun build swe/main.ts --target=node --format=cjs --external electron --outfile swe/dist/main.cjs`.nothrow(),
  $`bun build swe/preload.ts --target=node --format=cjs --external electron --outfile swe/dist/preload.cjs`.nothrow(),

]);

for (const job of [vite, main, preload]) {

  if (job.exitCode !== 0) {

    process.exit(job.exitCode ?? 1);

  }

}

writeFileSync("swe/dist/package.json", JSON.stringify({ name: "boombox", version: "0.1.0", main: "main.cjs" }));
