import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { expandTilde, escapeRegex } from "./helpers.js";

/** Resolve the search directory and partial name from a prefix string. */
function resolveSearchDir(
  prefix: string,
  baseCwd: string,
): { searchDir: string; partialName: string } | null {
  const expanded = expandTilde(prefix || "");
  const isTrailingSlash = expanded.endsWith("/");
  let searchDir: string;
  let partialName: string;
  if (isTrailingSlash || expanded === "" || expanded === ".") {
    let dirPath = expanded.slice(0, -1) || ".";
    dirPath = expandTilde(dirPath);
    searchDir = isAbsolute(dirPath) ? dirPath : resolve(baseCwd, dirPath);
    partialName = "";
  } else {
    searchDir = isAbsolute(expanded)
      ? dirname(expanded)
      : resolve(baseCwd, dirname(expanded) || ".");
    partialName = basename(expanded);
  }
  try {
    const dirStat = statSync(searchDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    return null;
  }
  return { searchDir, partialName };
}

/** List directory entries, filtering to directories matching the partial name. */
function listMatchingDirs(searchDir: string, partialName: string): string[] | null {
  let entries: string[];
  try {
    entries = readdirSync(searchDir);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const name of entries) {
    if (partialName && !name.toLowerCase().startsWith(partialName.toLowerCase())) {
      continue;
    }
    try {
      const entryStat = statSync(join(searchDir, name));
      if (!entryStat.isDirectory()) continue;
    } catch {
      continue;
    }
    matches.push(name);
  }
  return matches;
}

/** Build the completion value for a directory entry. */
function buildCompletionValue(name: string, searchDir: string, prefix: string): string {
  const expanded = expandTilde(prefix || "");
  if (isAbsolute(expanded) || prefix.startsWith("~")) {
    let value = join(searchDir, name);
    if (prefix.startsWith("~") && process.env.HOME) {
      value = value.replace(new RegExp(`^${escapeRegex(process.env.HOME)}`), "~");
    }
    return value;
  }
  if (expanded.endsWith("/")) {
    return prefix + name;
  }
  const dirPart = dirname(prefix || "");
  return dirPart === "." ? name : join(dirPart, name);
}

/** Provide directory tab-completion for the /cwd command. */
export function getDirectoryCompletions(
  prefix: string,
  baseCwd: string,
): AutocompleteItem[] | null {
  const resolved = resolveSearchDir(prefix, baseCwd);
  if (!resolved) return null;
  const { searchDir, partialName } = resolved;
  const matches = listMatchingDirs(searchDir, partialName);
  if (!matches || matches.length === 0) return null;
  return matches.map((name) => ({
    label: name,
    value: buildCompletionValue(name, searchDir, prefix),
  }));
}
