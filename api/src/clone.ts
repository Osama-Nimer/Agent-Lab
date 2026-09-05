// Shallow clone into CLONE_DIR with a hard timeout. Re-uses an existing complete clone of the same
// URL. Clones land in a staging dir and are renamed into place only on success, so a timed-out or
// killed clone can never be mistaken for a finished repository on the next request.
import { simpleGit } from "simple-git";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { API_ROOT } from "./env.js";

const CLONE_TIMEOUT_MS = 60_000;

export async function cloneRepo(repoUrl: string): Promise<string> {
  const url = normalize(repoUrl);
  const base = path.resolve(API_ROOT, process.env.CLONE_DIR ?? "./.tmp-repos");
  await mkdir(base, { recursive: true });

  const name = url.split("/").pop()!.replace(/\.git$/, "") || "repo";
  const dest = path.join(base, `${name}-${createHash("sha1").update(url).digest("hex").slice(0, 8)}`);
  if (await exists(path.join(dest, ".git"))) return dest;

  const staging = `${dest}.partial`;
  await rm(staging, { recursive: true, force: true });

  // simple-git refuses editor variables in a custom env (they can run arbitrary commands), and some
  // shells export them — so pass the process env minus those, and never block on a prompt: no
  // terminal prompt, no credential helper, no askpass. A typo'd or private URL fails in seconds.
  const { GIT_EDITOR: _e, GIT_SEQUENCE_EDITOR: _s, GIT_ASKPASS: _a, ...childEnv } = process.env;
  const git = simpleGit({
    abort: AbortSignal.timeout(CLONE_TIMEOUT_MS),
    // `credential.helper=` (empty) DISABLES helpers. simple-git guards this key because a helper
    // value can execute commands; ours is a fixed literal, never user input, so the override is safe.
    config: ["credential.helper="],
    unsafe: { allowUnsafeCredentialHelper: true },
  }).env({ ...childEnv, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });

  try {
    await git.clone(url, staging, ["--depth", "1", "--single-branch"]);
    await rename(staging, dest);
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    const reason = /abort/i.test(msg) ? `timed out after ${CLONE_TIMEOUT_MS / 1000}s` : firstUsefulLine(msg);
    throw new Error(`Clone failed: ${reason} (${url})`);
  }
  return dest;
}

/** git's stderr is several lines; keep the one that says what went wrong. */
function firstUsefulLine(msg: string): string {
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /fatal:|error:|denied|not found|could not|authentication/i.test(l)) ?? lines[0] ?? "unknown error";
}

/** Accept https://github.com/owner/name[.git] and owner/name shorthand; reject everything else. */
function normalize(input: string): string {
  const s = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`;
  const m = s.match(/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error(`Unsupported repo URL: ${input}. Use https://github.com/owner/name`);
  return `https://${m[1]}/${m[2]}.git`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
