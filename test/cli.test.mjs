import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "filesense-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, cwd) {
  return execFileAsync(process.execPath, [cliPath, ...args], { cwd });
}

test("init creates config, ignore, schemas, and root index", async () => {
  await withTempDir(async (dir) => {
    const { stdout } = await runCli(["init", dir, "--json"]);
    const payload = JSON.parse(stdout);

    assert.equal(payload.action, "init");
    assert.ok(payload.summary.indexesWritten >= 1);
    assert.ok(await readFile(path.join(dir, ".filesrc.json"), "utf8"));
    assert.ok(await readFile(path.join(dir, ".filesignore"), "utf8"));
    assert.ok(await readFile(path.join(dir, "schemas", "FILES.schema.json"), "utf8"));
    assert.ok(await readFile(path.join(dir, "FILES.json"), "utf8"));
  });
});

test("sync and check report healthy JSON summaries", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "README.md"), "# Fixture\n", "utf8");
    await runCli(["init", dir, "--json"]);

    const sync = JSON.parse((await runCli(["sync", dir, "--json"])).stdout);
    assert.equal(sync.directoriesScanned, 1);
    assert.ok(sync.indexesWritten >= 0);

    const check = JSON.parse((await runCli(["check", dir, "--json"])).stdout);
    assert.equal(check.checkedDirectories, 1);
    assert.deepEqual(check.missingIndexes, []);
    assert.deepEqual(check.staleIndexes, []);
    assert.deepEqual(check.invalidIndexes, []);
    assert.deepEqual(check.invalidNotes, []);
    assert.deepEqual(check.missingSchemas, []);
  });
});

test("query returns the directory index and optional notes", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "src.ts"), "export const value = 1;\n", "utf8");
    await runCli(["init", dir, "--json"]);
    await runCli(["summarize", dir, "--json"]);

    const query = JSON.parse((await runCli(["query", dir, "--json"])).stdout);

    assert.equal(query.rootRelativePath, ".");
    assert.ok(query.index.children.some((entry) => entry.name === "src.ts"));
    assert.ok(query.notes);
  });
});

test("summarize writes heuristic notes", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
    await runCli(["init", dir, "--json"]);

    const summary = JSON.parse((await runCli(["summarize", dir, "--json"])).stdout);
    const notes = JSON.parse(await readFile(path.join(dir, "FILES.notes.json"), "utf8"));

    assert.equal(summary.directoriesScanned, 1);
    assert.ok(summary.notesWritten >= 0);
    assert.ok(notes.directory_purpose.length > 0);
  });
});

test("sync hashes file contents with stable sha1 output", async () => {
  await withTempDir(async (dir) => {
    const content = "large fixture\n".repeat(10_000);
    await writeFile(path.join(dir, "large.txt"), content, "utf8");
    await runCli(["init", dir, "--json"]);

    const index = JSON.parse(await readFile(path.join(dir, "FILES.json"), "utf8"));
    const entry = index.children.find((child) => child.name === "large.txt");

    assert.match(entry.hash, /^sha1:[a-f0-9]{40}$/);
  });
});

test("rejects invalid .filesrc.json values", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".filesrc.json"), JSON.stringify({ exclude: "node_modules" }), "utf8");

    await assert.rejects(
      runCli(["sync", dir, "--json"]),
      (error) => error.stderr.includes("exclude must be an array of strings")
    );
  });
});

test("check reports stale indexes when file metadata changes", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "tracked.txt"), "before\n", "utf8");
    await runCli(["init", dir, "--json"]);
    await writeFile(path.join(dir, "tracked.txt"), "after content is longer\n", "utf8");

    const check = JSON.parse((await runCli(["check", dir, "--json"])).stdout);

    assert.deepEqual(check.staleIndexes, ["."]);
  });
});

test("sync applies .filesignore rules to files and directories", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".filesignore"), "ignored.txt\nskipped/\n", "utf8");
    await writeFile(path.join(dir, "kept.txt"), "kept\n", "utf8");
    await writeFile(path.join(dir, "ignored.txt"), "ignored\n", "utf8");
    await mkdir(path.join(dir, "skipped"));
    await writeFile(path.join(dir, "skipped", "nested.txt"), "nested\n", "utf8");

    await runCli(["init", dir, "--json"]);
    const index = JSON.parse(await readFile(path.join(dir, "FILES.json"), "utf8"));

    assert.ok(index.children.some((entry) => entry.name === "kept.txt"));
    assert.ok(!index.children.some((entry) => entry.name === "ignored.txt"));
    assert.ok(!index.children.some((entry) => entry.name === "skipped"));
  });
});

test("accepts valid partial .filesrc.json values", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".filesrc.json"), JSON.stringify({ recursive: false, exclude: ["ignored.txt"] }), "utf8");
    await writeFile(path.join(dir, "kept.txt"), "kept\n", "utf8");
    await writeFile(path.join(dir, "ignored.txt"), "ignored\n", "utf8");

    await runCli(["sync", dir, "--json"]);
    const index = JSON.parse(await readFile(path.join(dir, "FILES.json"), "utf8"));

    assert.ok(index.children.some((entry) => entry.name === "kept.txt"));
    assert.ok(!index.children.some((entry) => entry.name === "ignored.txt"));
  });
});
