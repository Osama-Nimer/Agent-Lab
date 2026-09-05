import { Project } from "ts-morph";
import path from "node:path";
import { toPosix } from "./util.js";

export function loadProject(rootDir: string) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths([
    path.posix.join(toPosix(rootDir), "**/*.ts"),
    "!" + path.posix.join(toPosix(rootDir), "**/node_modules/**"),
    "!" + path.posix.join(toPosix(rootDir), "**/dist/**"),
    "!" + path.posix.join(toPosix(rootDir), "**/*.d.ts"),
  ]);
  return project;
}
