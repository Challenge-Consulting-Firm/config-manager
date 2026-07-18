import type { DiffLine } from "@config-manager/shared";

interface Props {
  lines: DiffLine[];
  stats: { added: number; removed: number; unchanged: number };
}

/**
 * A dependency-free side-by-side-ish unified diff renderer.
 * Added lines are green, removed lines are red, context lines are muted.
 */
export function DiffViewer({ lines, stats }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs">
        <div className="flex gap-4">
          <span className="text-emerald-700">+{stats.added}</span>
          <span className="text-red-700">-{stats.removed}</span>
          <span className="text-slate-500">= {stats.unchanged}</span>
        </div>
      </div>
      <div className="mono max-h-[75vh] overflow-auto text-xs leading-5">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={rowCls(l.type)}>
                <td className="w-10 select-none border-r border-slate-100 px-2 text-right text-slate-400">
                  {l.oldNumber ?? ""}
                </td>
                <td className="w-10 select-none border-r border-slate-100 px-2 text-right text-slate-400">
                  {l.newNumber ?? ""}
                </td>
                <td className="w-6 select-none px-2 text-center text-slate-400">
                  {marker(l.type)}
                </td>
                <td className="whitespace-pre-wrap break-all px-2">
                  {l.text || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rowCls(type: DiffLine["type"]): string {
  switch (type) {
    case "added":
      return "bg-emerald-50";
    case "removed":
      return "bg-red-50";
    default:
      return "";
  }
}

function marker(type: DiffLine["type"]): string {
  switch (type) {
    case "added":
      return "+";
    case "removed":
      return "-";
    default:
      return " ";
  }
}
