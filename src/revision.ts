import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export interface BuildRevision {
  packageVersion: string | null;
  revision: string | null;
  dirty: boolean | null;
}

/** Best-effort checkout provenance, not an attestation of the loaded source. */
export async function readBuildRevision(root = packageRoot): Promise<BuildRevision> {
  const build: BuildRevision = { packageVersion: null, revision: null, dirty: null };
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (manifest?.name === "pi-peloton" && typeof manifest.version === "string"
      && /^[0-9][0-9A-Za-z.+-]{0,95}$/.test(manifest.version)) build.packageVersion = manifest.version;
  } catch { /* No package version available. */ }

  // Use this package's own .git (including linked worktrees), never the Pi
  // conversation's cwd, an enclosing repo, or Git overrides from its shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const { stdout } = await run("git", ["--git-dir=.git", "--work-tree=.", "--no-optional-locks",
      "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "--no-ahead-behind",
      "--untracked-files=normal", "--ignore-submodules=all"], {
      cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
      timeout: 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    });
    const lines = stdout.trimEnd().split("\n");
    const revision = /^# branch\.oid ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[0])?.[1];
    if (revision) {
      build.revision = revision;
      build.dirty = lines.some(line => !line.startsWith("#"));
    }
  } catch { /* Git is optional; don't record errors, paths, or status output. */ }
  return build;
}
