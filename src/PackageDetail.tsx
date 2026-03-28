import { Action, ActionPanel, Detail, Icon } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useEffect, useState } from "react";

const execFileAsync = promisify(execFile);

export function PackageDetail({ id, name }: { id: string; name: string }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    execFileAsync(
      "winget",
      ["show", id, "--disable-interactivity", "--accept-source-agreements"],
      {
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
    )
      .then(({ stdout }) => setMarkdown(parseToMarkdown(stdout)))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [id]);

  if (error) {
    return (
      <Detail
        markdown={`**Error loading details**\n\n${error}`}
        navigationTitle={name}
      />
    );
  }

  return (
    <Detail
      isLoading={markdown === null}
      markdown={markdown ?? ""}
      navigationTitle={name}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title="Copy Package ID"
            content={id}
            icon={Icon.Clipboard}
          />
        </ActionPanel>
      }
    />
  );
}

function parseToMarkdown(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map(
      (l) =>
        l
          .split("\r")
          .filter((s) => s.trim())
          .pop() ?? "",
    )
    .map((l) => l.trimEnd())
    .filter((l) => !/^Found .+ \[.+\]/.test(l.trim()));

  const out: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (inBlock) out.push("");
      continue;
    }

    // Lines like "Key: Value" or "Key:" (block header)
    const kvMatch = line.match(/^(\s*)([A-Za-z][A-Za-z0-9 ]+?):\s*(.*)$/);
    if (kvMatch) {
      const [, indent, key, value] = kvMatch;
      if (indent) {
        // Indented sub-key (inside installer block etc.)
        out.push(
          value ? `- **${key.trim()}:** ${value}` : `- **${key.trim()}**`,
        );
        inBlock = false;
      } else if (!value) {
        // Top-level block header with no inline value
        out.push(`\n### ${key}`);
        inBlock = true;
      } else {
        // Top-level key: value
        if (inBlock) {
          out.push("");
          inBlock = false;
        }
        out.push(`**${key}:** ${value}  `);
      }
    } else {
      // Continuation / plain text (e.g. release notes body)
      out.push(line.startsWith("  ") ? line.trimStart() : line);
    }
  }

  return out.join("\n");
}
