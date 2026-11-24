import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBuildRevision } from "../src/revision.ts";

const manifest = JSON.stringify({ name: "pi-peloton", version: "0.1.0" });
const noGit = { packageVersion: "0.1.0", revision: null, dirty: null };

test("provenance reports a package version even without Git metadata", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), manifest);
  assert.deepEqual(await readBuildRevision(root), noGit);
});

test("provenance captures checkout HEAD and dirtiness without attributing an enclosing repo", async t => {
  if (spawnSync("git", ["--version"]).error) { t.skip("Git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "peloton-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  await mkdir(source);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", source, ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await writeFile(join(source, "package.json"), manifest);
  git("add", "package.json");
  git("-c", "user.name=Peloton test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Test package");
  const revision = git("rev-parse", "HEAD");
  const clean = { ...noGit, revision, dirty: false };
  git("worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  assert.deepEqual(await readBuildRevision(source), clean);
  assert.deepEqual(await readBuildRevision(worktree), clean);
  await writeFile(join(worktree, "package.json"), `${manifest}\n`);
  assert.deepEqual(await readBuildRevision(worktree), { ...clean, dirty: true });
  const nested = join(source, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "package.json"), manifest);
  assert.deepEqual(await readBuildRevision(source), { ...clean, dirty: true });
  assert.deepEqual(await readBuildRevision(nested), noGit);
});
