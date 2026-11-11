import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Every action the main process handles must also be on its allow list;
// otherwise the button that sends it fails with "Invalid application request."
test("every handled main-process action is allowed", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/main.ts"),
    "utf8",
  );
  const listStart = source.indexOf("const actions = new Set([");
  const allowed = new Set(
    [
      ...source
        .slice(listStart, source.indexOf("]);", listStart))
        .matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  const body = source.slice(source.indexOf("async function execute("));
  const handled = [
    ...body.slice(0, body.indexOf("\n}\n")).matchAll(/case "([^"]+)"/g),
  ].map((m) => m[1]);
  assert.ok(handled.length > 20);
  assert.deepEqual(
    handled.filter((a) => !allowed.has(a)),
    [],
  );
});
