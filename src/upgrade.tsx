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
  source: string;
  status: PackageStatus;
  needsForce?: boolean;
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
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    Promise.all([
      execFileAsync(
        "winget",
        ["upgrade", "--disable-interactivity", "--include-pinned"],
        { maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
      ),
      execFileAsync("winget", ["pin", "list", "--disable-interactivity"], {
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" })),
    ])
      .then(([{ stdout: listOut }, { stdout: pinOut }]) => {
        const upgradeable = parseWingetListOutput(listOut)
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
      title: isPinned ? "Unpinned" : "Pinned",
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
      title: "Upgrading packages...",
    });

    let doneCount = 0;
    let failCount = 0;
    let forceCount = 0;
    let wasCancelled = false;

    try {
      for (const pkg of packages.filter((p) => !pinnedIds.has(p.id) && !p.needsForce)) {
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "upgrading" } : p)),
        );
        toast.message = pkg.name;

        const result = await runUpgrade(pkg, toast, cancelRef);

        if (result === "cancelled") {
          wasCancelled = true;
          setPackages((prev) =>
            prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed" } : p)),
          );
          break;
        } else if (result === "needs-force") {
          forceCount++;
          setPackages((prev) =>
            prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed", needsForce: true } : p)),
          );
        } else if (result) {
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

      if (!wasCancelled) {
        if (failCount === 0 && forceCount === 0) {
          toast.style = Toast.Style.Success;
          toast.title = `Upgraded ${doneCount} package${doneCount !== 1 ? "s" : ""}`;
          toast.message = undefined;
        } else if (forceCount > 0 && failCount === 0) {
          toast.style = Toast.Style.Failure;
          toast.title = `${doneCount} upgraded, ${forceCount} need --force`;
          toast.message = "Upgrade individually to force";
        } else {
          toast.style = Toast.Style.Failure;
          toast.title = `${doneCount} upgraded, ${failCount + forceCount} failed`;
          toast.message = forceCount > 0 ? `${forceCount} need --force` : undefined;
        }
      }
    } finally {
      isUpgradingRef.current = false;
      setIsUpgrading(false);
    }
  }

  async function upgradeSingle(pkg: UpgradePackage, options: { force?: boolean } = {}) {
    if (isUpgradingRef.current) return;
    isUpgradingRef.current = true;
    setIsUpgrading(true);
    setPackages((prev) =>
      prev.map((p) => (p.id === pkg.id ? { ...p, status: "upgrading", needsForce: false } : p)),
    );

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: options.force ? "Upgrading (forced)..." : "Upgrading...",
      message: pkg.name,
    });

    try {
      const result = await runUpgrade(pkg, toast, cancelRef, options);

      if (result === "cancelled") {
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed" } : p)),
        );
      } else if (result === "needs-force") {
        toast.style = Toast.Style.Failure;
        toast.title = "Modified package";
        toast.message = "Open Actions to upgrade with --force";
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed", needsForce: true } : p)),
        );
      } else if (result) {
        toast.style = Toast.Style.Success;
        toast.title = "Upgraded";
        toast.message = pkg.name;
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "done", needsForce: false } : p)),
        );
      } else {
        setPackages((prev) =>
          prev.map((p) => (p.id === pkg.id ? { ...p, status: "failed" } : p)),
        );
      }
    } finally {
      isUpgradingRef.current = false;
      setIsUpgrading(false);
    }
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

  const completedCount = packages.filter((p) => p.status === "done").length;
  const subtitle =
    isUpgrading && completedCount > 0
      ? `${completedCount} / ${packages.length} upgraded`
      : undefined;

  const pendingCount = packages.filter((p) => p.status === "pending" && !pinnedIds.has(p.id) && !p.needsForce).length;

  return (
    <List isLoading={isLoading} navigationTitle={subtitle}>
      <List.Item
        key="__upgrade_all__"
        title="Upgrade All"
        subtitle={`${pendingCount} package${pendingCount !== 1 ? "s" : ""} pending`}
        icon={Icon.ArrowClockwise}
        actions={
          <ActionPanel>
            {isUpgrading ? (
              <Action
                title="Cancel"
                icon={Icon.Stop}
                style={Action.Style.Destructive}
                onAction={() => cancelRef.current?.()}
              />
            ) : (
              <Action
                title="Upgrade All"
                icon={Icon.ArrowClockwise}
                onAction={upgradeAll}
              />
            )}
          </ActionPanel>
        }
      />
      {packages.map((pkg) => (
        <List.Item
          key={pkg.id}
          title={pkg.name}
          subtitle={pkg.id}
          icon={statusIcon(pkg.status)}
          accessories={buildAccessories(pkg, pinnedIds)}
          actions={
            <ActionPanel>
              {pkg.status === "upgrading" ? (
                <Action
                  title="Cancel"
                  icon={Icon.Stop}
                  style={Action.Style.Destructive}
                  onAction={() => cancelRef.current?.()}
                />
              ) : pinnedIds.has(pkg.id) ? (
                <Action
                  title="Unpin to Upgrade"
                  icon={Icon.Pin}
                  onAction={() => togglePin(pkg)}
                />
              ) : pkg.needsForce ? (
                <Action
                  title="Upgrade with Force"
                  icon={Icon.Download}
                  style={Action.Style.Destructive}
                  onAction={() => upgradeSingle(pkg, { force: true })}
                />
              ) : (
                <Action
                  title="Upgrade"
                  icon={Icon.Download}
                  onAction={() => upgradeSingle(pkg)}
                />
              )}
              {!isUpgrading && (
                <Action
                  title="Upgrade All"
                  icon={Icon.ArrowClockwise}
                  onAction={upgradeAll}
                />
              )}
              <Action.CopyToClipboard
                title="Copy Package ID"
                content={pkg.id}
              />
              {pkg.source === "winget" && (
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
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

const FORCE_REQUIRED_RE = /unable to remove portable package.*modified/i;

function runUpgrade(
  pkg: UpgradePackage,
  toast: Toast,
  cancelRef: { current: (() => void) | null },
  options: { force?: boolean } = {},
): Promise<boolean | "cancelled" | "needs-force"> {
  return new Promise((resolve) => {
    const proc = spawn(
      "winget",
      [
        "upgrade",
        "--id",
        pkg.id,
        ...(pkg.source ? ["--source", pkg.source] : []),
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
        ...(options.force ? ["--force"] : []),
      ],
      { windowsHide: true },
    );

    let cancelled = false;
    let needsForce = false;
    const doCancel = () => {
      cancelled = true;
      proc.kill();
      toast.style = Toast.Style.Failure;
      toast.title = "Upgrade cancelled";
      toast.message = pkg.name;
      toast.primaryAction = undefined;
      cancelRef.current = null;
    };
    cancelRef.current = doCancel;
    toast.primaryAction = { title: "Cancel", onAction: doCancel };

    function handleLine(line: string) {
      const l = line.trim();
      if (!l) return;
      if (FORCE_REQUIRED_RE.test(l)) needsForce = true;
      const clean = l
        .replace(ANSI_ESCAPE_RE, "")
        .replace(/[█▒ ]{4,}/g, "")
        .trim();
      if (!clean || /^[\s|/\-\\]+$/.test(clean)) return;
      toast.message = clean;
    }

    let stdoutBuf = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
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
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
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
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (stderrBuf.trim()) handleLine(stderrBuf);
      cancelRef.current = null;
      toast.primaryAction = undefined;
      if (cancelled) {
        resolve("cancelled");
        return;
      }
      if (code !== 0 && needsForce) {
        resolve("needs-force");
        return;
      }
      resolve(code === 0);
    });
    proc.on("error", () => {
      cancelRef.current = null;
      toast.primaryAction = undefined;
      if (!cancelled) resolve(false);
    });
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

function normalizeSource(raw: string): string {
  if (/^msst/i.test(raw)) return "msstore";
  if (/^wing/i.test(raw)) return "winget";
  return raw;
}

function truncateVersion(v: string, max = 12): string {
  return v.length > max ? v.slice(0, max) + "..." : v;
}

function buildAccessories(
  pkg: UpgradePackage,
  pinnedIds: Set<string>,
): List.Item.Accessory[] {
  const versionTag = (v: string): List.Item.Accessory => ({ tag: `v${truncateVersion(v)}` });

  const pinBadge: List.Item.Accessory[] = pinnedIds.has(pkg.id)
    ? [{ icon: Icon.Pin, tooltip: "Pinned — excluded from upgrades" }]
    : [];

  const versionKnown = pkg.version && pkg.version.toLowerCase() !== "unknown";

  const sourceAccessory = (source: string): List.Item.Accessory => {
    switch (source) {
      case "msstore":
        return { tag: { value: "msstore", color: Color.Blue } };
      case "winget":
        return { tag: { value: "winget", color: Color.Purple } };
      default:
        return {
          tag: { value: source || "local", color: Color.SecondaryText },
        };
    }
  };
  const sourceTag = sourceAccessory(pkg.source);

  switch (pkg.status) {
    case "upgrading":
      return [
        ...pinBadge,
        ...(versionKnown ? [versionTag(pkg.version)] : []),
        { tag: { value: `↑ ${truncateVersion(pkg.available)}`, color: Color.Orange } },
        sourceTag,
      ];
    case "done":
      return [
        ...pinBadge,
        ...(versionKnown ? [versionTag(pkg.version)] : []),
        { tag: { value: `↑ ${truncateVersion(pkg.available)}`, color: Color.Green } },
        sourceTag,
      ];
    case "failed":
      return [
        ...pinBadge,
        ...(versionKnown ? [versionTag(pkg.version)] : []),
        { tag: { value: `↑ ${truncateVersion(pkg.available)}`, color: Color.Red }, tooltip: pkg.needsForce ? "Modified package — open Actions to upgrade with --force" : undefined },
        sourceTag,
      ];
    default:
      return [
        ...pinBadge,
        ...(versionKnown ? [versionTag(pkg.version)] : []),
        { tag: { value: `↑ ${truncateVersion(pkg.available)}`, color: Color.Green } },
        sourceTag,
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

function parseTableSection(lines: string[]): {
  name: string;
  id: string;
  version: string;
  available: string;
  source: string;
}[] {
  const dividerIndex = lines.findIndex((l) => /^-+$/.test(l));
  if (dividerIndex < 1 || dividerIndex + 1 >= lines.length) return [];

  const headerLine = lines[dividerIndex - 1];
  const nameStart = headerLine.indexOf("Name");
  const idStart = headerLine.indexOf("Id");
  const versionStart = headerLine.indexOf("Version");
  const availableStart = headerLine.indexOf("Available");
  const sourceStart = headerLine.indexOf("Source");

  if (nameStart < 0 || idStart < 0 || versionStart < 0) return [];

  const versionEnd =
    availableStart >= 0 ? availableStart : sourceStart >= 0 ? sourceStart : -1;

  return lines.slice(dividerIndex + 1).flatMap((line) => {
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
    if (!name || !id) return [];
    return [{ name, id, version, available, source }];
  });
}

function parseWingetListOutput(rawOutput: string): {
  name: string;
  id: string;
  version: string;
  available: string;
  source: string;
}[] {
  // Normalize CRLF and in-place overwrite lines, preserving empty lines as section separators.
  // Also strip known winget informational/summary lines that are not table rows.
  const allLines = rawOutput
    .split("\n")
    .map(
      (line) =>
        line
          .split("\r")
          .filter((s) => s.trim())
          .pop() ?? "",
    )
    .map((line) => line.trim())
    .filter(
      (line) =>
        !/^\d+\s+upgrades?\s+available/i.test(line) &&
        !/^the following packages/i.test(line),
    );

  // winget upgrade output has multiple blank-line-separated sections:
  //   1. Main upgradeable packages table
  //   2. Count summary ("N upgrades available.")
  //   3. Optional notice + table for packages requiring explicit targeting
  // Parse each section independently so message lines don't become fake package rows.
  const results: {
    name: string;
    id: string;
    version: string;
    available: string;
    source: string;
  }[] = [];
  let sectionLines: string[] = [];

  for (const line of allLines) {
    if (line === "") {
      results.push(...parseTableSection(sectionLines));
      sectionLines = [];
    } else {
      sectionLines.push(line);
    }
  }
  results.push(...parseTableSection(sectionLines));

  return results;
}
