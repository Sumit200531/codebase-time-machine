import type { RepoView } from "../lib/repo-view.ts";
import { formatDate, formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

/** Accessible alternative to the visual maps: every file at this point, as a table. */
export function FileTable({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const churn = view.churn(step);
  const files = [...view.snapshot(step).values()].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <caption>{formatNumber(files.length)} files at {formatDate(view.step(step).committedAt)}</caption>
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Lines</th>
            <th scope="col">Changes</th>
            <th scope="col">Born</th>
            <th scope="col">Last changed</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.lineage}>
              <th scope="row">
                <button className="link" onClick={() => store.set({ selection: { kind: "file", lineage: file.lineage } })}>
                  {file.path}
                </button>
              </th>
              <td>{file.loc === null ? "—" : formatNumber(file.loc)}</td>
              <td>{churn.get(file.lineage) ?? 0}</td>
              <td>{formatDate(view.step(file.bornStep).committedAt)}</td>
              <td>{formatDate(view.step(file.lastChangedStep).committedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
