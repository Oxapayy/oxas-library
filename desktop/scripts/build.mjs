import { build } from "esbuild";
import { mkdir, copyFile, readdir, readFile } from "node:fs/promises";
let cloud = {};
try {
  cloud = JSON.parse(await readFile("../Config/Cloud.local.json", "utf8"));
} catch {}
const cloudURL = process.env.OXA_CLOUD_URL || cloud.url || "";
const cloudKey = process.env.OXA_CLOUD_PUBLIC_KEY || cloud.publishableKey || "";
if (cloudURL && (!cloudURL.startsWith("https://") || !cloudKey))
  throw Error("Use an HTTPS account endpoint and a public client key.");
if (
  /sb_secret_|service_role/.test(cloudKey) ||
  (cloudKey.startsWith("eyJ") &&
    JSON.parse(Buffer.from(cloudKey.split(".")[1], "base64url")).role !==
      "anon")
)
  throw Error("Only a publishable/anonymous client key is permitted.");
if (process.env.OXA_REQUIRE_CLOUD === "1" && (!cloudURL || !cloudKey))
  throw Error("Hosted build requires private client configuration.");
const define = {
  __OXA_CLOUD_URL__: JSON.stringify(cloudURL),
  __OXA_CLOUD_PUBLIC_KEY__: JSON.stringify(cloudKey),
};
await mkdir("dist/tests", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron"],
  target: "node24",
  define,
});
await build({
  entryPoints: ["src/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
  target: "node24",
  define,
});
await build({
  entryPoints: ["src/renderer.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: "dist/renderer.js",
  target: "chrome140",
});
for (const file of ["index.html", "app.css"])
  await copyFile("src/" + file, "dist/" + file);
// Preserve the full notices of every installed production dependency, including
// those bundled into main/renderer. Electron ships its own Chromium notices.
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
let notices =
  "Oxa’s Library — desktop dependency notices\n\nApplication code: MIT. Electron and Chromium notices are also included with the runtime.\n";
for (const [directory, record] of Object.entries(lock.packages)) {
  if (!directory.startsWith("node_modules/") || record.dev) continue;
  const files = await readdir(directory);
  for (const file of files.filter((name) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
  )) {
    notices +=
      "\n\n" +
      directory.replace(/^node_modules\//, "") +
      " " +
      record.version +
      " — " +
      file +
      "\n\n" +
      (await readFile(directory + "/" + file, "utf8")).replace(/\r\n/g, "\n");
  }
}
await (
  await import("node:fs/promises")
).writeFile("assets/THIRD-PARTY-NOTICES.txt", notices);
for (const file of (await readdir("tests")).filter((x) =>
  x.endsWith(".test.ts"),
))
  await build({
    entryPoints: ["tests/" + file],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/tests/" + file.replace(".ts", ".cjs"),
    target: "node24",
    external: ["electron"],
    define: {
      __OXA_CLOUD_URL__: JSON.stringify("https://example.invalid"),
      __OXA_CLOUD_PUBLIC_KEY__: JSON.stringify("fixture-public-key"),
    },
  });
