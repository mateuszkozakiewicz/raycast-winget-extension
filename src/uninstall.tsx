import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  useNavigation,
} from "@raycast/api";
import { PackageDetail } from "./PackageDetail";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { useEffect, useRef, useState } from "react";

const execFileAsync = promisify(execFile);

type InstalledPackage = {
  name: string;
  id: string;
  version: string;
  available: string;
  source: string;
};

// Unicode ranges for double-width (CJK etc.) characters.
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/u;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\d;]*[a-zA-Z]/g;

export default function Command() {
  const { push } = useNavigation();
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    Promise.all([
      execFileAsync(
        "winget",
        ["list", "--accept-source-agreements", "--disable-interactivity"],
        { maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
      ),
      execFileAsync("winget", ["pin", "list", "--accept-source-agreements"], {
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
    ])
      .then(([{ stdout: listOut }, { stdout: pinOut }]) => {
        setPackages(parseWingetListOutput(listOut));
        setPinnedIds(parsePinnedIds(pinOut));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function togglePin(pkg: InstalledPackage) {
    const isPinned = pinnedIds.has(pkg.id);
    const verb = isPinned ? "remove" : "add";
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: isPinned ? "Unpinning…" : "Pinning…",
      message: pkg.name,
    });
    try {
      await execFileAsync(
        "winget",
        [
          "pin",
          verb,
          "--id",
          pkg.id,
          "--exact",
          "--source",
          "winget",
          "--accept-source-agreements",
        ],
        { maxBuffer: 1024 * 1024, encoding: "utf8" },
      );
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (isPinned) next.delete(pkg.id);
        else next.add(pkg.id);
        return next;
      });
      toast.style = Toast.Style.Success;
      toast.title = isPinned ? "Unpinned" : "Pinned";
      toast.message = pkg.name;
    } catch {
      toast.style = Toast.Style.Failure;
      toast.title = isPinned ? "Unpin failed" : "Pin failed";
      toast.message = pkg.name;
    }
  }

  async function uninstallPackage(pkg: InstalledPackage) {
    if (uninstallingId !== null) return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Uninstalling…",
      message: pkg.name,
    });

    setUninstallingId(pkg.id);

    await new Promise<void>((resolve) => {
      const proc = spawn(
        "winget",
        [
          "remove",
          "--id",
          pkg.id,
          "--silent",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        { windowsHide: true },
      );

      let cancelled = false;
      const doCancel = () => {
        cancelled = true;
        proc.kill();
        toast.style = Toast.Style.Failure;
        toast.title = "Uninstall cancelled";
        toast.message = pkg.name;
        toast.primaryAction = undefined;
        cancelRef.current = null;
        setUninstallingId(null);
      };
      cancelRef.current = doCancel;
      toast.primaryAction = { title: "Cancel", onAction: doCancel };

      function handleLine(line: string) {
        const l = line.trim();
        if (!l) return;
        const clean = l
          .replace(ANSI_ESCAPE_RE, "")
          .replace(/[█▒ ]{4,}/g, "")
          .trim();
        if (!clean) return;
        if (/^[\s|/\-\\]+$/.test(clean)) return;
        toast.message = clean;
      }

      let stdoutBuf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
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
        setUninstallingId(null);
        if (cancelled) {
          resolve();
          return;
        }
        if (code === 0) {
          toast.style = Toast.Style.Success;
          toast.title = "Uninstalled";
          toast.message = pkg.name;
          toast.primaryAction = undefined;
          setPackages((prev) => prev.filter((p) => p.id !== pkg.id));
        } else {
          toast.style = Toast.Style.Failure;
          toast.title = "Uninstall failed";
          if (!toast.message || toast.message === pkg.name) {
            toast.message = `winget exited with code ${code}`;
          }
        }
        resolve();
      });

      proc.on("error", (err) => {
        cancelRef.current = null;
        setUninstallingId(null);
        toast.style = Toast.Style.Failure;
        toast.title = "Uninstall failed";
        toast.message = err.message;
        resolve();
      });
    });
  }

  if (error) {
    return (
      <List>
        <List.EmptyView
          title="Failed to Load Packages"
          description={error}
          icon={Icon.XMarkCircle}
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter installed packages…"
    >
      {packages.map((pkg, index) => (
        <List.Item
          key={`${index}-${pkg.id}`}
          title={pkg.name}
          subtitle={pkg.id}
          icon={uninstallingId === pkg.id ? { source: Icon.CircleProgress75, tintColor: Color.Red } : undefined}
          accessories={buildAccessories(pkg, pinnedIds)}
          actions={
            <ActionPanel>
              {uninstallingId === pkg.id ? (
                <Action
                  title="Cancel"
                  icon={Icon.Stop}
                  style={Action.Style.Destructive}
                  onAction={() => cancelRef.current?.()}
                />
              ) : (
                <Action
                  title="Uninstall"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => uninstallPackage(pkg)}
                />
              )}
              {!pkg.id.startsWith("ARP\\") && pkg.source === "winget" && (
                <Action
                  title={pinnedIds.has(pkg.id) ? "Unpin" : "Pin"}
                  icon={pinnedIds.has(pkg.id) ? Icon.PinDisabled : Icon.Pin}
                  onAction={() => togglePin(pkg)}
                />
              )}
              {!pkg.id.startsWith("ARP\\") && (
                <Action
                  title="Show Details"
                  icon={Icon.Info}
                  onAction={() =>
                    push(<PackageDetail id={pkg.id} name={pkg.name} />)
                  }
                />
              )}
              <Action.CopyToClipboard
                title="Copy Package ID"
                content={pkg.id}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function normalizeSource(raw: string): string {
  if (/^msst/i.test(raw)) return "msstore";
  if (/^wing/i.test(raw)) return "winget";
  return raw;
}

function buildAccessories(
  pkg: InstalledPackage,
  pinnedIds: Set<string>,
): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  if (pkg.version.toLowerCase() !== "unknown" && pkg.version) {
    accessories.push({ tag: `v${pkg.version}` });
  }

  switch (pkg.source) {
    case "msstore":
      accessories.push({ tag: { value: "msstore", color: Color.Blue } });
      break;
    case "winget":
      accessories.push({ tag: { value: "winget", color: Color.Purple } });
      break;
    default:
      accessories.push({
        tag: { value: pkg.source || "local", color: Color.SecondaryText },
      });
  }

  if (pinnedIds.has(pkg.id)) {
    accessories.push({
      icon: Icon.Pin,
      tooltip: "Pinned — excluded from upgrades",
    });
  }

  if (pkg.available) {
    accessories.push({
      tag: { value: `↑ ${pkg.available}`, color: Color.Green },
      tooltip: `Upgrade available: ${pkg.available}`,
    });
  }

  return accessories;
}

function parsePinnedIds(rawOutput: string): Set<string> {
  const lines = rawOutput
    .split("\n")
    .map(
      (l) =>
        l
          .split("\r")
          .filter((s) => s.trim())
          .pop() ?? "",
    )
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const dividerIndex = lines.findIndex((l) => /^-+$/.test(l));
  if (dividerIndex < 1) return new Set();

  const headerLine = lines[dividerIndex - 1];
  const idStart = headerLine.indexOf("Id");
  const versionStart = headerLine.indexOf("Version");
  if (idStart < 0 || versionStart < 0) return new Set();

  return new Set(
    lines.slice(dividerIndex + 1).flatMap((line) => {
      const id = line.substring(idStart, versionStart).trim();
      return id ? [id] : [];
    }),
  );
}

function parseWingetListOutput(rawOutput: string): InstalledPackage[] {
  // Split on \n only; within each \n-line take the last non-empty \r-segment so
  // that winget's \r-based spinner frames are discarded before any processing.
  const lines = rawOutput
    .split("\n")
    .map(
      (line) =>
        line
          .split("\r")
          .filter((s) => s.trim())
          .pop() ?? "",
    )
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const dividerLineIndex = lines.findIndex((line) => /^-+$/.test(line));
  if (dividerLineIndex < 1 || dividerLineIndex + 1 >= lines.length) {
    return [];
  }

  const headerLine = lines[dividerLineIndex - 1];
  const nameStart = headerLine.indexOf("Name");
  const idStart = headerLine.indexOf("Id");
  const versionStart = headerLine.indexOf("Version");
  const availableStart = headerLine.indexOf("Available"); // -1 when column absent
  const sourceStart = headerLine.indexOf("Source"); // -1 when column absent

  if (nameStart < 0 || idStart < 0 || versionStart < 0) {
    return [];
  }

  const versionEnd =
    availableStart >= 0 ? availableStart : sourceStart >= 0 ? sourceStart : -1;

  function isWide(cp: number): boolean {
    return WIDE_CHAR_RE.test(String.fromCodePoint(cp)) || cp >= 0x20000;
  }

  function sliceCol(line: string, startCol: number, endCol: number): string {
    if (startCol < 0) return "";

    let visualCol = 0;
    let charStart = -1;
    let charEnd = line.length;

    for (let i = 0; i < line.length; ) {
      const cp = line.codePointAt(i) ?? 0;
      const w = isWide(cp) ? 2 : 1;

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

  const result: InstalledPackage[] = [];

  for (const line of lines.slice(dividerLineIndex + 1)) {
    const name = sliceCol(line, nameStart, idStart);
    const id = sliceCol(line, idStart, versionStart);
    const version = sliceCol(line, versionStart, versionEnd);
    const available =
      availableStart >= 0
        ? sliceCol(line, availableStart, sourceStart >= 0 ? sourceStart : -1)
        : "";
    const source = normalizeSource(
      sourceStart >= 0 ? sliceCol(line, sourceStart, -1) : "",
    );

    if (!name || !id) continue;

    result.push({ name, id, version, available, source });
  }

  return result;
}
