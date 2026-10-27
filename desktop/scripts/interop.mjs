import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
if (process.platform !== "darwin")
  throw Error(
    "Swift interoperability checks require macOS. Golden vectors are tested on every platform.",
  );
mkdirSync("dist/tests", { recursive: true });
mkdirSync("tests/fixtures", { recursive: true });
const core = readdirSync("../Sources/OxaCore")
  .filter((x) => x.endsWith(".swift"))
  .map((x) => "../Sources/OxaCore/" + x);
const result = spawnSync(
  "swiftc",
  [
    ...core,
    "../Sources/OxaApp/CloudModels.swift",
    "../Sources/OxaApp/CloudCrypto.swift",
    "tests/interop/main.swift",
    "-o",
    "dist/tests/swift-interop",
  ],
  { stdio: "inherit" },
);
if (result.status) process.exit(result.status);
if (process.argv.includes("--generate")) {
  const run = spawnSync(
    "dist/tests/swift-interop",
    ["generate", "tests/fixtures/swift.json"],
    { stdio: "inherit" },
  );
  process.exit(run.status);
}
const run = spawnSync(
  "dist/tests/swift-interop",
  ["verify", "test-results/desktop-interop.json"],
  { stdio: "inherit" },
);
process.exit(run.status);
