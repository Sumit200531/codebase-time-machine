import { hierarchy, pack } from "d3-hierarchy";

/**
 * Stable layout: computed once over every path that ever existed, so moving
 * through time only changes what is visible, never where things are.
 */

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface StableLayout {
  readonly size: number;
  readonly files: ReadonlyMap<string, Placement>;
  readonly directories: ReadonlyMap<string, Placement>;
}

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
  value?: number;
}

export const LAYOUT_SIZE = 1000;
const MIN_FILE_WEIGHT = 4;

export function computeStableLayout(paths: readonly string[], peakLoc: ReadonlyMap<string, number>): StableLayout {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let child = node.children!.find((c) => c.name === part && (isFile ? c.children === undefined : c.children !== undefined));
      if (!child) {
        child = isFile
          ? { name: part, path: childPath, value: Math.sqrt(Math.max(MIN_FILE_WEIGHT, peakLoc.get(path) ?? 0)) }
          : { name: part, path: childPath, children: [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  const tree = hierarchy(root)
    .sum((d) => d.value ?? 0)
    .sort((a, b) => a.data.path.localeCompare(b.data.path));
  const packed = pack<TreeNode>().size([LAYOUT_SIZE, LAYOUT_SIZE]).padding(6)(tree);
  const files = new Map<string, Placement>();
  const directories = new Map<string, Placement>();
  for (const node of packed.descendants()) {
    const placement = { x: node.x, y: node.y, r: node.r };
    if (node.data.children === undefined) files.set(node.data.path, placement);
    else if (node.data.path !== "") directories.set(node.data.path, placement);
  }
  return { size: LAYOUT_SIZE, files, directories };
}
