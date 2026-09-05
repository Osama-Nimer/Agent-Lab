import path from "node:path";

export const toPosix = (p: string) => p.split(path.sep).join("/");

/** Repo-relative, POSIX. This is what goes in Evidence.file. */
export const relPath = (rootDir: string, absFile: string) =>
  toPosix(path.relative(rootDir, absFile));

export const evidence = (
  rootDir: string,
  node: { getSourceFile(): { getFilePath(): string }; getStartLineNumber(): number }
) => ({
  file: relPath(rootDir, node.getSourceFile().getFilePath()),
  line: node.getStartLineNumber(),
});
