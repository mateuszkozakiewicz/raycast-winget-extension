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

type PackageStatus = "pending" | "upgrading" | "done" | "failed";

type UpgradePackage = {
  name: string;
  id: string;
  version: string;
  available: string;
  status: PackageStatus;
};

// Unicode ranges for double-width (CJK etc.) characters.
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3040-\u33FF\u3400-\u4DBF\u4E00-\uA4CF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE10-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/u;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\d;]*[a-zA-Z]/g;

export default function Command() {
  const { push } = useNavigation();
  const [packages, setPackages] = useState<UpgradePackage[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUpgradingRef = useRef(false);

  useEffect(() => {
    Promise.all([
      execFileAsync(
        "winget",
        [
          "list",
          "--source",
          "winget",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        { maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
      ),
      execFileAsync("winget", ["pin", "list", "--accept-source-agreements"], {
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
    ])
      .then(([{ stdout: listOut }, { stdout: pinOut }]) => {
        const upgradeable = parseWingetListOutput(listOut)
          .filter((p) => p.available)
          .map((p) => ({ ...p, status: "pending" as PackageStatus }));
        setPackages(upgradeable);
        setPinnedIds(parsePinnedIds(pinOut));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function togglePin(pkg: UpgradePackage) {
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

  async function upgradeAll() {
    if (isUpgradingRef.current) return;
    isUpgradingRef.current = true;
    setIsUpgrading(true);
    setPackages((prev) =>
      prev.map((p) => ({ ...p, status: "pending" as PackageStatus })),
    );

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Upgrading packages…",
    });

    let doneCount = 0;
    let failCount = 0;

    for (const pkg of packages) {
      setPackages((prev) =>
        prev.map((p) => (p.id === pkg.id ? { ...p, status: "upgrading" } : p)),
      );
      toast.message = pkg.name;

      const success = await runUpgrade(pkg, toast);

      if (success) {
        doneCount++;
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "done" } : p)),
        );
      } else {
        failCount++;
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed" } : p)),
        );
      }
    }

    if (failCount === 0) {
      toast.style = Toast.Style.Success;
      toast.title = `Upgraded ${doneCount} package${doneCount !== 1 ? "s" : ""}`;
      toast.message = undefined;
    } else {
      toast.style = Toast.Style.Failure;
      toast.title = `${doneCount} upgraded, ${failCount} failed`;
      toast.message = undefined;
    }

    isUpgradingRef.current = false;
    setIsUpgrading(false);
  }

  async function upgradeSingle(pkg: UpgradePackage) {
    if (isUpgradingRef.current) return;
    isUpgradingRef.current = true;
    setIsUpgrading(true);
    setPackages((prev) =>
      prev.map((p) => (p.id === pkg.id ? { ...p, status: "upgrading" } : p)),
    );

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Upgrading…",
      message: pkg.name,
    });

    const success = await runUpgrade(pkg, toast);

    if (success) {
      toast.style = Toast.Style.Success;
      toast.title = "Upgraded";
      toast.message = pkg.name;
      setPackages((prev) =>
        prev.map((p) => (p.id === pkg.id ? { ...p, status: "done" } : p)),
      );
    } else {
      setPackages((prev) =>
        prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed" } : p)),
      );
    }

    isUpgradingRef.current = false;
    setIsUpgrading(false);
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

  if (!isLoading && packages.length === 0) {
    return (
      <List>
        <List.EmptyView
          title="Everything Is Up to Date"
          description="No WinGet packages have available upgrades"
          icon={Icon.Checkmark}
        />
      </List>
    );
  }

  const doneCount = packages.filter((p) => p.status === "done").length;
  const subtitle =
    isUpgrading && doneCount > 0
      ? `${doneCount} / ${packages.length} upgraded`
      : undefined;

  return (
    <List isLoading={isLoading} navigationTitle={subtitle}>
      {packages.map((pkg, index) => (
        <List.Item
          key={`${index}-${pkg.id}`}
          title={pkg.name}
          subtitle={pkg.id}
          icon={statusIcon(pkg.status)}
          accessories={buildAccessories(pkg, pinnedIds)}
          actions={
            <ActionPanel>
              <Action
                title="Upgrade All"
                icon={Icon.ArrowClockwise}
                onAction={upgradeAll}
              />
              <Action
                title="Upgrade"
                icon={Icon.Download}
                onAction={() => upgradeSingle(pkg)}
              />
              <Action.CopyToClipboard
                title="Copy Package ID"
                content={pkg.id}
              />
              <Action
                title={pinnedIds.has(pkg.id) ? "Unpin" : "Pin"}
                icon={pinnedIds.has(pkg.id) ? Icon.PinDisabled : Icon.Pin}
                onAction={() => togglePin(pkg)}
              />
              {!pkg.id.startsWith("ARP\\") && (
                <Action
                  title="Show Details"
                  icon={Icon.Info}
                  onAction={() =>
                    push(<PackageDetail id={pkg.id} name={pkg.name} />)
                  }
                />
              )}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function runUpgrade(pkg: UpgradePackage, toast: Toast): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "winget",
      [
        "upgrade",
        "--id",
        pkg.id,
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      { windowsHide: true },
    );

    function handleLine(line: string) {
      const l = line.trim();
      if (!l) return;
      const clean = l
        .replace(ANSI_ESCAPE_RE, "")
        .replace(/[█▒ ]{4,}/g, "")
        .trim();
      if (!clean || /^[\s|/\-\\]+$/.test(clean)) return;
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

    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

function statusIcon(
  status: PackageStatus,
): { source: string; tintColor?: string } | string {
  switch (status) {
    case "upgrading":
      return { source: Icon.ArrowClockwise, tintColor: Color.Orange };
    case "done":
      return { source: Icon.Checkmark, tintColor: Color.Green };
    case "failed":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    default:
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

function buildAccessories(
  pkg: UpgradePackage,
  pinnedIds: Set<string>,
): List.Item.Accessory[] {
  const pinBadge: List.Item.Accessory[] = pinnedIds.has(pkg.id)
    ? [{ icon: Icon.Pin, tooltip: "Pinned — excluded from upgrades" }]
    : [];
  switch (pkg.status) {
    case "upgrading":
      return [
        ...pinBadge,
        { tag: `v${pkg.version}` },
        { text: { value: `↑ ${pkg.available}`, color: Color.Orange } },
      ];
    case "done":
      return [
        ...pinBadge,
        { tag: { value: `v${pkg.available}`, color: Color.Green } },
      ];
    case "failed":
      return [
        ...pinBadge,
        { tag: `v${pkg.version}` },
        { text: { value: "Failed", color: Color.Red } },
      ];
    default:
      return [
        ...pinBadge,
        { tag: `v${pkg.version}` },
        { tag: { value: `↑ ${pkg.available}`, color: Color.Green } },
      ];
  }
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

function parseWingetListOutput(rawOutput: string): {
  name: string;
  id: string;
  version: string;
  available: string;
}[] {
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
  const availableStart = headerLine.indexOf("Available");

  if (nameStart < 0 || idStart < 0 || versionStart < 0) {
    return [];
  }

  const versionEnd = availableStart >= 0 ? availableStart : -1;

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

  return lines.slice(dividerLineIndex + 1).flatMap((line) => {
    const name = sliceCol(line, nameStart, idStart);
    const id = sliceCol(line, idStart, versionStart);
    const version = sliceCol(line, versionStart, versionEnd);
    const available =
      availableStart >= 0 ? sliceCol(line, availableStart, -1) : "";
    if (!name || !id) return [];
    return [{ name, id, version, available }];
  });
}
