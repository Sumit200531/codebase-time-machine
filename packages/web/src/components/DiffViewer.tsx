import { useState } from "react";
import type { FilePatch, PatchLine } from "@ctm/collector";
import { tokenize } from "../lib/highlight.ts";

type Mode = "unified" | "split";

function Code({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((token, i) =>
        token.kind === "plain" ? token.text : (
          <span key={i} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

/** Pair deletions with following additions so split view lines up changed lines side by side. */
function splitRows(lines: readonly PatchLine[]): [PatchLine | null, PatchLine | null][] {
  const rows: [PatchLine | null, PatchLine | null][] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push([dels[i] ?? null, adds[i] ?? null]);
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.type === "del") dels.push(line);
    else if (line.type === "add") adds.push(line);
    else {
      flush();
      rows.push([line, line]);
    }
  }
  flush();
  return rows;
}

export function DiffViewer({ files, truncated }: { files: readonly FilePatch[]; truncated: boolean }) {
  const [mode, setMode] = useState<Mode>("unified");
  const [index, setIndex] = useState(0);
  const file = files[Math.min(index, files.length - 1)];
  if (!file) return <p className="muted">This commit changes no file contents.</p>;
  const label = (f: FilePatch) => (f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : (f.newPath ?? f.oldPath ?? "?"));

  return (
    <div className="diff">
      <div className="diff-toolbar">
        <label>
          <span className="visually-hidden">File</span>
          <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
            {files.map((f, i) => (
              <option key={i} value={i}>
                {label(f)}
              </option>
            ))}
          </select>
        </label>
        <div role="radiogroup" aria-label="Diff layout" className="segmented">
          {(["unified", "split"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "is-active" : ""} onClick={() => setMode(m)}>
              {m === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
      </div>
      {file.binary && <p className="muted">Binary file: no line diff.</p>}
      {!file.binary && file.hunks.length === 0 && <p className="muted">Renamed without content changes.</p>}
      <div className="diff-scroll">
        {file.hunks.map((hunk, h) => (
          <table key={h} className={`diff-table mode-${mode}`}>
            <caption>{hunk.header}</caption>
            <tbody>
              {mode === "unified"
                ? hunk.lines.map((line, i) => (
                    <tr key={i} className={`line-${line.type}`}>
                      <td className="ln">{line.oldLine ?? ""}</td>
                      <td className="ln">{line.newLine ?? ""}</td>
                      <td className="sign" aria-label={line.type === "add" ? "added" : line.type === "del" ? "removed" : undefined}>
                        {line.type === "add" ? "+" : line.type === "del" ? "−" : ""}
                      </td>
                      <td className="code">
                        <Code text={line.text} />
                      </td>
                    </tr>
                  ))
                : splitRows(hunk.lines).map(([left, right], i) => (
                    <tr key={i}>
                      <td className="ln">{left?.oldLine ?? ""}</td>
                      <td className={`code ${left ? `line-${left.type}` : "line-empty"}`}>{left && <Code text={left.text} />}</td>
                      <td className="ln">{right?.newLine ?? ""}</td>
                      <td className={`code ${right ? `line-${right.type}` : "line-empty"}`}>{right && <Code text={right.text} />}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        ))}
      </div>
      {truncated && <p className="muted">This patch was too large to include in full; later files are omitted.</p>}
    </div>
  );
}
