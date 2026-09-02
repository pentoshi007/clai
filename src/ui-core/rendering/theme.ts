
import type { ThemeHint } from "../bootstrap/capabilities.js";

export interface Theme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
  readonly statusBackground: string;
  readonly selection: string;
  readonly rowA: string;
  readonly rowB: string;
  readonly chip: string;
  readonly mode: string;
  readonly success: string;
  readonly successBg: string;
  readonly failedBg: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly aqua: string;
  readonly white: string;
  readonly response: string;
  readonly activity: string;
  readonly activityBg: string;
  readonly spinner: string;
  readonly queued: string;
  readonly chipTeal: string;
  readonly chipIndigo: string;
  readonly prompt: string;
  readonly thinking: string;
  readonly thinkingDim: string;
  readonly thinkingBg: string;
  readonly inputBorder: string;
  readonly userBorder: string;
  readonly toolBorder: string;
  readonly toolOutput: string;
  readonly modalBorder: string;
  readonly diffAdd: string;
  readonly diffDel: string;
  readonly diffGutter: string;
  readonly diffAddBg: string;
  readonly diffDelBg: string;
  readonly synKeyword: string;
  readonly synString: string;
  readonly synComment: string;
  readonly synNumber: string;
  readonly synFunction: string;
  readonly synType: string;
  readonly synProperty: string;
  readonly synOperator: string;
  readonly synRegex: string;
}

const DARK_THEME: Theme = {
  background: "#0b0e14",
  foreground: "#F8FAFC",
  muted: "#94A3B8",
  accent: "#5cc8ff",
  border: "#22D3EE",
  statusBackground: "#11151c",
  selection: "#2563EB",
  rowA: "#1E293B",
  rowB: "#0F172A",
  chip: "#334155",
  mode: "#B45309",
  success: "#4ADE80",
  successBg: "#166534",
  failedBg: "#991B1B",
  magenta: "#FF55FF",
  cyan: "#67E8F9",
  aqua: "#2EEBFF",
  white: "#FFFFFF",
  response: "#4ADE80",
  activity: "#FACC15",
  activityBg: "#854D0E",
  spinner: "#E879F9",
  queued: "#854D0E",
  chipTeal: "#0E7490",
  chipIndigo: "#3730A3",
  prompt: "#B45309",
  thinking: "#A78BFA",
  thinkingDim: "#8B79C4",
  thinkingBg: "#171225",
  inputBorder: "#2EEBFF",
  userBorder: "#f5b351",
  toolBorder: "#3B82F6",
  toolOutput: "#7DD3FC",
  modalBorder: "#22D3EE",
  diffAdd: "#4ADE80",
  diffDel: "#F87171",
  diffGutter: "#64748B",
  diffAddBg: "#12261a",
  diffDelBg: "#2a1414",
  synKeyword: "#569CD6",
  synString: "#CE9178",
  synComment: "#6A9955",
  synNumber: "#B5CEA8",
  synFunction: "#DCDCAA",
  synType: "#4EC9B0",
  synProperty: "#9CDCFE",
  synOperator: "#D4D4D4",
  synRegex: "#D16969",
};

const LIGHT_THEME: Theme = {
  background: "#fdfdfd",
  foreground: "#1c1f24",
  muted: "#6b7280",
  accent: "#0969da",
  border: "#0891B2",
  statusBackground: "#f0f2f4",
  selection: "#0969da",
  rowA: "#eef2f7",
  rowB: "#f8fafc",
  chip: "#e2e8f0",
  mode: "#B45309",
  success: "#16A34A",
  successBg: "#14532d",
  failedBg: "#7f1d1d",
  magenta: "#D946EF",
  cyan: "#0891b2",
  aqua: "#0891B2",
  white: "#FFFFFF",
  response: "#15803d",
  activity: "#a16207",
  activityBg: "#92400E",
  spinner: "#a21caf",
  queued: "#854D0E",
  chipTeal: "#0e7490",
  chipIndigo: "#4338ca",
  prompt: "#b45309",
  thinking: "#7c3aed",
  thinkingDim: "#9a72e0",
  thinkingBg: "#F5F0FF",
  inputBorder: "#06B6D4",
  userBorder: "#f5b351",
  toolBorder: "#2563eb",
  toolOutput: "#0369a1",
  modalBorder: "#0891B2",
  diffAdd: "#15803d",
  diffDel: "#dc2626",
  diffGutter: "#94a3b8",
  diffAddBg: "#dcfce7",
  diffDelBg: "#fee2e2",
  synKeyword: "#0000ff",
  synString: "#a31515",
  synComment: "#008000",
  synNumber: "#098658",
  synFunction: "#795e26",
  synType: "#267f99",
  synProperty: "#001080",
  synOperator: "#000000",
  synRegex: "#811f3f",
};

export function themeFor(hint: ThemeHint): Theme {
  return hint === "light" ? LIGHT_THEME : DARK_THEME;
}
