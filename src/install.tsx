import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  showToast,
  useNavigation,
} from "@raycast/api";
import { PackageDetail } from "./PackageDetail";
import { execFile, spawn } from "node:child_process";
import { useEffect, useMemo, useRef, useState } from "react";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type WingetSearchResult = {
  name: string;
  id: string;
  version: string;
  source: string;
};

const MIN_QUERY_LENGTH = 1;

// Unicode ranges for double-width (CJK etc.) characters.
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/u;

// Matches ANSI escape sequences emitted by winget (e.g. colour codes, cursor moves).
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\d;]*[a-zA-Z]/g;

export default function Command() {
  const { push } = useNavigation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WingetSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const searchIdRef = useRef(0);

  const trimmedQuery = query.trim();
  const canSearch = trimmedQuery.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setLastSearchedQuery("");
    }
  }, [canSearch]);

  async function installPackage(id: string) {
    if (installingId !== null) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Installing…",
      message: id,
    });

    setInstallingId(id);

    await new Promise<void>((resolve) => {
      const proc = spawn(
        "winget",
        [
          "install",
          "--id",
          id,
          "--exact",
          "--disable-interactivity",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ],
        { windowsHide: true },
      );

      let cancelled = false;
      const doCancel = () => {
        cancelled = true;
        proc.kill();
        toast.style = Toast.Style.Failure;
        toast.title = "Installation cancelled";
        toast.message = id;
        toast.primaryAction = undefined;
        cancelRef.current = null;
        setInstallingId(null);
      };
      cancelRef.current = doCancel;
      toast.primaryAction = { title: "Cancel", onAction: doCancel };

      let uacHinted = false;

      function handleLine(line: string) {
        const l = line.trim();
        if (!l) return;

        // Strip ANSI escape codes and progress bar characters winget emits.
        const clean = l
          .replace(ANSI_ESCAPE_RE, "")
          .replace(/[█▒ ]{4,}/g, "")
          .trim();
        if (!clean) return;

        // Ignore winget's CLI spinner frames (|, /, -, \) emitted while waiting.
        if (/^[\s|/\-\\]+$/.test(clean)) return;

        toast.message = clean;

        // After winget launches the installer subprocess it goes silent while
        // waiting for UAC — warn the user once so they know to look for a prompt.
        if (
          !uacHinted &&
          /starting package install|launching installer/i.test(clean)
        ) {
          uacHinted = true;
          toast.title = "Waiting for UAC prompt…";
          toast.message = "Check for an administrator permission dialog";
        }
      }

      let stdoutBuf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        // Split on \n; within each \n-line also split on bare \r (spinner overwrites).
        // A bare \r means the next segment overwrites the previous one on the terminal,
        // so we keep only the last \r-segment — that's what would actually be visible.
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        lines
          .map(
            (l) =>
              l
                .split("\r")
                .filter((s) => s.trim())
                .pop() ?? "",
          )
          .forEach(handleLine);
      });

      let stderrBuf = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        lines
          .map(
            (l) =>
              l
                .split("\r")
                .filter((s) => s.trim())
                .pop() ?? "",
          )
          .forEach(handleLine);
      });

      proc.on("close", (code) => {
        cancelRef.current = null;
        setInstallingId(null);
        if (cancelled) {
          resolve();
          return;
        }
        if (code === 0) {
          toast.style = Toast.Style.Success;
          toast.title = "Installed";
          toast.message = id;
        } else {
          toast.style = Toast.Style.Failure;
          toast.title = "Installation failed";
          // Keep last streamed message as context, or fall back to exit code.
          if (!toast.message || toast.message === id) {
            toast.message = `winget exited with code ${code}`;
          }
        }
        resolve();
      });

      proc.on("error", (err) => {
        cancelRef.current = null;
        setInstallingId(null);
        toast.style = Toast.Style.Failure;
        toast.title = "Installation failed";
        toast.message = err.message;
        resolve();
      });
    });
  }

  async function runSearch() {
    if (!canSearch || trimmedQuery === lastSearchedQuery) {
      return;
    }

    setIsLoading(true);
    setLastSearchedQuery(trimmedQuery);
    const searchId = ++searchIdRef.current;

    try {
      const { includeMsStore } = getPreferenceValues<{
        includeMsStore: boolean;
      }>();
      const sourceArgs = includeMsStore ? [] : ["--source", "winget"];
      const { stdout, stderr } = await execFileAsync(
        "winget",
        [
          "search",
          "--name",
          trimmedQuery,
          ...sourceArgs,
          "--disable-interactivity",
        ],
        {
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const parsed = parseWingetSearchOutput(stdout);

      if (searchIdRef.current !== searchId) return;

      if (stderr?.trim()) {
        await showToast({
          style: Toast.Style.Failure,
          title: "winget returned warnings",
          message: stderr.trim(),
        });
      }

      setResults(parsed);
    } catch (error) {
      if (searchIdRef.current !== searchId) return;
      // winget exits non-zero with a specific message when no packages match.
      // Treat that as an empty result rather than a failure.
      const stdout = (error as { stdout?: string }).stdout ?? "";
      if (/no package found matching input criteria/i.test(stdout)) {
        setResults([]);
        return;
      }
      setResults([]);
      await showToast({
        style: Toast.Style.Failure,
        title: "Search failed",
        message: getErrorMessage(error),
      });
    } finally {
      if (searchIdRef.current === searchId) setIsLoading(false);
    }
  }

  const searchTriggerItem =
    canSearch && !isLoading && trimmedQuery !== lastSearchedQuery ? (
      <List.Item
        key="__search_trigger__"
        title={`Search for "${trimmedQuery}"`}
        icon={Icon.MagnifyingGlass}
        actions={
          <ActionPanel>
            <Action
              title="Search"
              icon={Icon.MagnifyingGlass}
              onAction={runSearch}
            />
          </ActionPanel>
        }
      />
    ) : null;

  const emptyView = useMemo(() => {
    if (!canSearch) {
      return (
        <List.EmptyView
          title="Search WinGet Packages"
          description="Type a package name and press Enter to search"
          icon={Icon.MagnifyingGlass}
        />
      );
    }

    if (isLoading) {
      return (
        <List.EmptyView
          title="Searching..."
          description={`winget search ${trimmedQuery}`}
          icon={Icon.Clock}
        />
      );
    }

    if (lastSearchedQuery && results.length === 0) {
      return (
        <List.EmptyView
          title="No Packages Found"
          description={`No WinGet packages matched '${lastSearchedQuery}'`}
          icon={Icon.XMarkCircle}
        />
      );
    }

    return null;
  }, [canSearch, isLoading, lastSearchedQuery, results.length, trimmedQuery]);

  return (
    <List
      isLoading={isLoading}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Type a package name and press Enter"
      throttle={false}
    >
      {searchTriggerItem}
      {emptyView}
      {results.map((item, index) => (
        <List.Item
          key={`${index}-${item.id}`}
          title={item.name}
          subtitle={item.id}
          icon={installingId === item.id ? { source: Icon.CircleProgress75, tintColor: Color.Blue } : undefined}
          accessories={buildAccessories(item)}
          actions={
            <ActionPanel>
              {installingId === item.id ? (
                <Action
                  title="Cancel"
                  icon={Icon.Stop}
                  style={Action.Style.Destructive}
                  onAction={() => cancelRef.current?.()}
                />
              ) : (
                <Action
                  title="Install"
                  icon={Icon.Download}
                  onAction={() => installPackage(item.id)}
                />
              )}
              <Action
                title="Show Details"
                icon={Icon.Info}
                onAction={() =>
                  push(<PackageDetail id={item.id} name={item.name} />)
                }
              />
              <Action.CopyToClipboard
                title="Copy Package ID"
                content={item.id}
              />
              <Action
                title="Copy Install Command"
                icon={Icon.Clipboard}
                onAction={() => {
                  const command = `winget install --id ${item.id} --exact`;
                  Clipboard.copy(command);
                  showToast({
                    style: Toast.Style.Success,
                    title: "Install command copied",
                  });
                }}
              />
              <Action
                title="Run New Search"
                icon={Icon.ArrowClockwise}
                onAction={runSearch}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function parseWingetSearchOutput(rawOutput: string): WingetSearchResult[] {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const dividerLineIndex = lines.findIndex((line) => /^-+$/.test(line));
  if (dividerLineIndex < 1 || dividerLineIndex + 1 >= lines.length) {
    return [];
  }

  const headerLine = lines[dividerLineIndex - 1];
  const nameStart = headerLine.indexOf("Name");
  const idStart = headerLine.indexOf("Id");
  const versionStart = headerLine.indexOf("Version");
  const matchStart = headerLine.indexOf("Match"); // -1 when column is absent
  const sourceStart = headerLine.indexOf("Source"); // -1 when column is absent

  if (nameStart < 0 || idStart < 0 || versionStart < 0) {
    return [];
  }

  // Version ends at Match column, or Source column, or end of line — whichever comes first.
  const versionEnd =
    matchStart >= 0 ? matchStart : sourceStart >= 0 ? sourceStart : -1;

  // Slice a column from a data row using the visual column positions derived
  // from the header (which is always ASCII, so char index == visual column).
  // CJK characters are double-width: they occupy 2 visual columns per char,
  // so plain substring() would be off for rows containing them.
  // endCol = -1 means "rest of line". startCol < 0 returns "".
  function sliceCol(line: string, startCol: number, endCol: number): string {
    if (startCol < 0) return "";

    let visualCol = 0;
    let charStart = -1;
    let charEnd = line.length;

    for (let i = 0; i < line.length; ) {
      const cp = line.codePointAt(i) ?? 0;
      const w =
        WIDE_CHAR_RE.test(String.fromCodePoint(cp)) || cp >= 0x20000 ? 2 : 1;

      if (charStart < 0 && visualCol >= startCol) charStart = i;
      if (endCol >= 0 && visualCol >= endCol) {
        charEnd = i;
        break;
      }

      visualCol += w;
      i += cp > 0xffff ? 2 : 1;
    }

    if (charStart < 0) return "";
    return line.substring(charStart, charEnd).trim();
  }

  const dataLines = lines.slice(dividerLineIndex + 1);
  const parsed: WingetSearchResult[] = [];

  for (const line of dataLines) {
    const name = sliceCol(line, nameStart, idStart);
    const id = sliceCol(line, idStart, versionStart);
    const version = sliceCol(line, versionStart, versionEnd) || "Unknown";
    const source = normalizeSource(
      sourceStart >= 0 ? sliceCol(line, sourceStart, -1) : "",
    );

    if (!name || !id) continue;

    parsed.push({ name, id, version, source });
  }

  return parsed;
}

function normalizeSource(raw: string): string {
  if (/^msst/i.test(raw)) return "msstore";
  if (/^wing/i.test(raw)) return "winget";
  return raw;
}

function buildAccessories(item: WingetSearchResult): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  if (item.version.toLowerCase() !== "unknown") {
    accessories.push({ tag: `v${item.version}` });
  }

  switch (item.source) {
    case "msstore":
      accessories.push({ tag: { value: "msstore", color: Color.Blue } });
      break;
    case "winget":
      accessories.push({ tag: { value: "winget", color: Color.Purple } });
      break;
    default:
      if (item.source)
        accessories.push({
          tag: { value: item.source, color: Color.SecondaryText },
        });
  }

  return accessories;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
