// Build script: bundle the three TS entry points with esbuild and copy static
// assets into dist/, ready to load as a temporary add-on or zip for release.

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

/** Entry points -> output files (relative to dist). */
const entries = {
  "background/index.js": "background/index.ts",
  "ui/app.js": "ui/app.ts",
  "options/options.js": "options/options.ts",
};

/** Static files copied verbatim. */
const staticAssets = [
  "manifest.json",
  "ui/app.html",
  "ui/app.css",
  "options/options.html",
  "icons/icon.svg",
];

async function copyStatic() {
  for (const asset of staticAssets) {
    const from = resolve(src, asset);
    const to = resolve(dist, asset);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const buildOptions = {
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([out, input]) => [
        out.replace(/\.js$/, ""),
        resolve(src, input),
      ]),
    ),
    outdir: dist,
    bundle: true,
    format: "esm",
    target: "firefox128",
    sourcemap: true,
    logLevel: "info",
  };

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.rebuild();
    await copyStatic();
    await ctx.watch();
    console.log("watching for changes…");
  } else {
    await esbuild.build(buildOptions);
    await copyStatic();
    console.log(`built -> ${dist}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
