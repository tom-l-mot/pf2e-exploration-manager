import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
const { id, version } = manifest;
assert.equal(manifest.compatibility, undefined);
assert.deepEqual(manifest.relationships.systems, [{ id: "pf2e", type: "system" }]);
assert.deepEqual(manifest.relationships.requires, [{ id: "lib-wrapper", type: "module" }]);
const files = ["module.json", "README.md", "scripts/main.js", "scripts/handoff.js", "scripts/automatic.js"];
const build = join(root, "build");
const archive = join(build, `${id}-${version}.zip`);
const entries = files.map((file) => `${id}/${file}`);

for (const file of files) {
  const destination = join(build, id, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, file), destination);
}

execFileSync("tar.exe", ["-a", "-cf", archive, "-C", build, ...entries]);
const actual = execFileSync("tar.exe", ["-tf", archive], { encoding: "utf8" })
  .trim().split(/\r?\n/).sort();
assert.deepEqual(actual, [...entries].sort(), "Unexpected ZIP contents.");
for (const [index, entry] of entries.entries()) {
  assert.deepEqual(
    execFileSync("tar.exe", ["-xOf", archive, entry]),
    readFileSync(join(root, files[index])),
    `ZIP content differs from source: ${entry}`,
  );
}

console.log(`Created and verified ${archive}`);
