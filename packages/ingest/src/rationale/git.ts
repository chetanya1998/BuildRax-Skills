import { execFile } from "node:child_process";

export interface RawCommit {
  hash: string;
  date: string;
  subject: string;
  /** Message body without trailers (Signed-off-by, Co-Authored-By, …). */
  body: string;
  /** Changed paths, relative to the scanned folder. */
  files: string[];
}

const MAX_COMMITS = 400;

/**
 * Read local commit messages and changed paths for the scanned folder. Only `git log` runs (no
 * hooks, pager, fsmonitor or diff drivers are involved); author names and emails are not read.
 * Returns undefined when the folder is not in a git work tree or git is not installed.
 */
export async function readCommits(root: string): Promise<RawCommit[] | undefined> {
  const args = [
    "-C",
    root,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "core.abbrev=10",
    "-c",
    "log.showSignature=false",
    "--no-pager",
    "log",
    "--no-merges",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--relative",
    `--max-count=${MAX_COMMITS}`,
    "--format=%x1e%h%x1f%cs%x1f%s%x1f%b%x1d",
    "--name-only",
    "--",
    ".",
  ];
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(
      "git",
      args,
      {
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
        },
        windowsHide: true,
      },
      (err, out) => resolve(err ? undefined : out),
    );
  });
  if (stdout === undefined) return undefined;
  return parseLog(stdout);
}

const TRAILER = /^[A-Za-z][\w-]*:\s+\S/;

/** Parse the `--format` above; exported for tests. */
export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const rec of out.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, tail = ""] = rec.split("\x1d");
    const [hash, date, subject, body = ""] = head!.split("\x1f");
    if (!hash || !date || subject === undefined) continue;
    // Drop the trailer block (a last paragraph made only of `Key: value` lines).
    const paras = body.trim().split(/\n\s*\n/);
    const last = paras.at(-1)?.split("\n") ?? [];
    if (paras.length && last.length && last.every((l) => TRAILER.test(l.trim()))) paras.pop();
    commits.push({
      hash: hash.trim(),
      date: date.trim(),
      subject: subject.trim(),
      body: paras.join("\n\n").trim(),
      files: tail
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }
  return commits;
}
