import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import {
  extractPrintableText,
  matchesKey as matchesTuiKey,
} from "@oh-my-pi/pi-tui";
import type {
  DescribeContext,
  KeyId,
  NativeNode,
  NativeUiEvent,
  TUI,
} from "@oh-my-pi/pi-tui";

type PickerNode = Extract<NativeNode, { k: "picker" }>;
type PickerProps = NonNullable<PickerNode["p"]>;
type PickerAction = NonNullable<PickerProps["actions"]>[number];

const PACKAGE_ID = "omp-prompt-stash";
const DEFAULT_STORE_FILE = "prompt-stash.json";
const STORE_VERSION = 1;
const DEFAULT_SHORTCUT = "ctrl+h";
const DEFAULT_DELETE_SHORTCUTS = "ctrl+r,delete";
const DEFAULT_DELETE_ALL_SHORTCUTS = "ctrl+x";
const DEFAULT_POPUP_WIDTH = 92;
const DEFAULT_LIST_ROWS = 10;
const PADDING_X = 2;
const PADDING_Y = 1;
const FRAME = { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" } as const;
const ELLIPSIS = "…";

interface StashItem {
  id: string;
  text: string;
  createdAt: string;
}

interface StashStore {
  version: number;
  items: StashItem[];
  legacyMigrationComplete?: boolean;
}

interface PromptStashSettings {
  shortcut: string;
  deleteShortcuts: string[];
  deleteAllShortcuts: string[];
  storeFile: string;
  deduplicate: boolean;
  popupWidth: number;
  listRows: number;
}

function homeDir(): string {
  return process.env.HOME || homedir();
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : getAgentDir();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pluginSettingsFrom(path: string): Record<string, unknown> {
  const root = readJsonRecord(path);
  const settings = root.settings;
  if (!isRecord(settings)) return {};
  const plugin = settings[PACKAGE_ID];
  return isRecord(plugin) ? plugin : {};
}

function getPluginSettings(cwd: string): Record<string, unknown> {
  return {
    ...pluginSettingsFrom(getPluginsLockfile(homeDir())),
    ...pluginSettingsFrom(join(cwd, ".omp", "plugin-overrides.json")),
  };
}

function settingString(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function settingBoolean(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

function settingNumber(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = raw[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shortcutList(value: string): string[] {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "none") return [];
  return trimmed
    .split(",")
    .map((shortcut) => shortcut.trim())
    .filter((shortcut) => shortcut.length > 0 && shortcut !== "none");
}

function sanitizeStoreFile(value: string): string {
  const file = basename(value.trim());
  return !file || file === "." || file === ".." ? DEFAULT_STORE_FILE : file;
}

function settingsFor(cwd: string): PromptStashSettings {
  const raw = getPluginSettings(cwd);
  const shortcut = settingString(
    raw,
    "shortcut",
    DEFAULT_SHORTCUT,
  ).toLowerCase();
  return {
    shortcut,
    deleteShortcuts: shortcutList(
      settingString(raw, "deleteShortcuts", DEFAULT_DELETE_SHORTCUTS),
    ),
    deleteAllShortcuts: shortcutList(
      settingString(raw, "deleteAllShortcuts", DEFAULT_DELETE_ALL_SHORTCUTS),
    ),
    storeFile: sanitizeStoreFile(
      settingString(raw, "storeFile", DEFAULT_STORE_FILE),
    ),
    deduplicate: settingBoolean(raw, "deduplicate", true),
    popupWidth: Math.max(
      40,
      Math.floor(settingNumber(raw, "popupWidth", DEFAULT_POPUP_WIDTH)),
    ),
    listRows: Math.max(
      1,
      Math.floor(settingNumber(raw, "listRows", DEFAULT_LIST_ROWS)),
    ),
  };
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^\w.-]+/g, "_");
  if (!safe) return "session";
  if (safe === ".") return "_";
  if (safe === "..") return "__";
  return safe;
}

function sessionIdForContext(ctx: ExtensionContext): string {
  const id = ctx.sessionManager.getSessionId();
  if (id && id.trim()) return id;
  const file = ctx.sessionManager.getSessionFile();
  if (file) return basename(file, ".jsonl");
  return `ephemeral-${process.pid}`;
}

function storeDir(ctx: ExtensionContext): string {
  return join(
    agentDir(),
    "prompt-stash",
    "sessions",
    safeFileName(sessionIdForContext(ctx)),
  );
}

function storePath(
  ctx: ExtensionContext,
  settings: PromptStashSettings,
): string {
  return join(storeDir(ctx), settings.storeFile);
}

function legacyStorePaths(
  ctx: ExtensionContext,
  settings: PromptStashSettings,
): string[] {
  const session = safeFileName(sessionIdForContext(ctx));
  return [
    join(
      homeDir(),
      ".pi",
      "agent",
      "vstack",
      "sessions",
      session,
      "prompt-stash",
      settings.storeFile,
    ),
    join(
      agentDir(),
      "vstack",
      "sessions",
      session,
      "prompt-stash",
      settings.storeFile,
    ),
  ];
}

function loadStore(path: string): StashStore {
  if (!existsSync(path)) return { version: STORE_VERSION, items: [] };
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<StashStore>;
    if (!Array.isArray(parsed.items))
      return { version: STORE_VERSION, items: [] };
    return {
      version: STORE_VERSION,
      items: parsed.items
        .filter((item): item is StashItem => {
          return Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as StashItem).id === "string" &&
            typeof (item as StashItem).text === "string" &&
            typeof (item as StashItem).createdAt === "string",
          );
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      legacyMigrationComplete: parsed.legacyMigrationComplete === true,
    };
  } catch {
    return { version: STORE_VERSION, items: [] };
  }
}

function loadItems(path: string): StashItem[] {
  return loadStore(path).items;
}

function saveItems(
  path: string,
  items: StashItem[],
  legacyMigrationComplete = loadStore(path).legacyMigrationComplete === true,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}`;
  const store: StashStore = {
    version: STORE_VERSION,
    items,
    ...(legacyMigrationComplete ? { legacyMigrationComplete: true } : {}),
  };
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

function mergeLegacyStores(
  ctx: ExtensionContext,
  targetPath: string,
  settings: PromptStashSettings,
): void {
  const targetStore = loadStore(targetPath);
  if (targetStore.legacyMigrationComplete) return;

  const byId = new Map(targetStore.items.map((item) => [item.id, item]));
  for (const legacyPath of legacyStorePaths(ctx, settings)) {
    if (!existsSync(legacyPath)) continue;
    for (const item of loadItems(legacyPath)) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }

  saveItems(
    targetPath,
    [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    true,
  );
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stashPrompt(
  ctx: ExtensionContext,
  text: string,
  settings: PromptStashSettings,
): number {
  const path = storePath(ctx, settings);
  mergeLegacyStores(ctx, path, settings);
  const now = new Date().toISOString();
  const loaded = loadItems(path);
  const existing = settings.deduplicate
    ? loaded.filter((item) => item.text !== text)
    : loaded;
  const items = [{ id: makeId(), text, createdAt: now }, ...existing];
  saveItems(path, items);
  return items.length;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function takeEscapeSequence(text: string, index: number): string | undefined {
  if (text.charCodeAt(index) !== 0x1b) return undefined;
  const next = text[index + 1];
  if (next === "[") {
    let end = index + 2;
    while (end < text.length && !/[@-~]/.test(text[end])) end += 1;
    return text.slice(index, Math.min(text.length, end + 1));
  }
  if (next === "]") {
    const bel = text.indexOf("\x07", index + 2);
    const st = text.indexOf("\x1b\\", index + 2);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    return end === -1
      ? text.slice(index)
      : text.slice(index, end + (end === st ? 2 : 1));
  }
  return text.slice(index, Math.min(text.length, index + 2));
}

function visibleWidth(text: string): number {
  return Array.from(stripAnsi(text)).length;
}

function truncateToWidth(
  text: string,
  width: number,
  ellipsis = ELLIPSIS,
): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const suffixWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, width - suffixWidth);
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) === 0x1b) {
      const sequence = takeEscapeSequence(text, i);
      if (sequence) {
        out += sequence;
        i += sequence.length;
        continue;
      }
    }
    const char = Array.from(text.slice(i))[0];
    if (!char) break;
    if (used + 1 > budget) break;
    out += char;
    used += 1;
    i += char.length;
  }
  return `${out}${ellipsis}`;
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function lineCount(text: string): number {
  return Math.max(1, text.split(/\r\n|\r|\n/).length);
}

function previewText(text: string): string {
  const first = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? "(empty prompt)";
}

function searchable(text: string): string {
  return text.toLowerCase();
}

function panelLine(content: string, width: number): string {
  return padAnsi(content, width);
}

function selectedLine(theme: Theme, content: string, width: number): string {
  return theme.bg("selectedBg", padAnsi(theme.fg("text", content), width));
}

function popupContentWidth(width: number): number {
  return Math.max(1, width - 2 - PADDING_X * 2);
}

function framePopup(
  lines: string[],
  width: number,
  theme: Theme,
  title = "",
  right = "",
): string[] {
  if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));

  const border = (text: string) => theme.fg("borderAccent", text);
  const contentWidth = popupContentWidth(width);
  const blank = `${border(FRAME.v)}${" ".repeat(width - 2)}${border(FRAME.v)}`;
  const top = () => {
    if (!title)
      return `${border(FRAME.tl)}${border(FRAME.h.repeat(width - 2))}${border(FRAME.tr)}`;
    const rightPlain = right ? ` ${right} ` : "";
    const titleBudget = Math.max(1, width - 2 - visibleWidth(rightPlain) - 1);
    const titlePlain = ` ${truncateToWidth(title, Math.max(1, titleBudget - 2), ELLIPSIS)} `;
    const fill = Math.max(
      1,
      width - 2 - visibleWidth(titlePlain) - visibleWidth(rightPlain),
    );
    return `${border(FRAME.tl)}${theme.bold(titlePlain)}${border(FRAME.h.repeat(fill))}${right ? theme.fg("dim", rightPlain) : ""}${border(FRAME.tr)}`;
  };
  const framed = [top()];

  for (let i = 0; i < PADDING_Y; i += 1) framed.push(blank);
  for (const line of lines) {
    framed.push(
      `${border(FRAME.v)}${" ".repeat(PADDING_X)}${padAnsi(line, contentWidth)}${" ".repeat(PADDING_X)}${border(FRAME.v)}`,
    );
  }
  for (let i = 0; i < PADDING_Y; i += 1) framed.push(blank);
  framed.push(
    `${border(FRAME.bl)}${border(FRAME.h.repeat(width - 2))}${border(FRAME.br)}`,
  );
  return framed.map((line) => truncateToWidth(line, width, ""));
}

function filterItems(items: StashItem[], query: string): StashItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) => searchable(item.text).includes(trimmed));
}

function matchesKey(data: string, key: string): boolean {
  const normalized = key.toLowerCase();
  const keyId =
    normalized === "del"
      ? "delete"
      : normalized === "pageup"
        ? "pageUp"
        : normalized === "pagedown"
          ? "pageDown"
          : normalized;
  return matchesTuiKey(data, keyId as KeyId);
}

function matchesAnyShortcut(
  data: string,
  shortcuts: readonly string[],
): boolean {
  return shortcuts.some((shortcut) => matchesKey(data, shortcut));
}

function shortcutLabel(shortcut: string): string {
  switch (shortcut.toLowerCase()) {
    case "delete":
    case "del":
      return "Del";
    default:
      return shortcut;
  }
}

function shortcutHint(shortcuts: readonly string[]): string | undefined {
  return shortcuts.length > 0
    ? shortcuts.map(shortcutLabel).join("/")
    : undefined;
}

function handleSuspend(tui: TUI): void {
  if (process.platform === "win32") return;
  const onResume = (): void => {
    tui.start();
    tui.requestRender(true);
  };
  process.once("SIGCONT", onResume);
  tui.stop();
  try {
    process.kill(0, "SIGTSTP");
  } catch {
    process.removeListener("SIGCONT", onResume);
    tui.start();
    tui.requestRender(true);
  }
}

interface PopupKeybindings {
  matches?(data: string, action: "app.display.reset" | "app.suspend"): boolean;
}

function matchesAction(
  keybindings: PopupKeybindings,
  data: string,
  action: "app.display.reset" | "app.suspend",
  fallback: string,
): boolean {
  return keybindings.matches?.(data, action) ?? matchesKey(data, fallback);
}

function renderSearchLine(query: string, width: number, theme: Theme): string {
  const prefix = "> ";
  const content = truncateToWidth(`${prefix}${query}`, width, "");
  return theme.bg("toolPendingBg", padAnsi(content, width));
}

/** Keycap names for a shortcut id (`"ctrl+r"` → `["ctrl", "r"]`, `"escape"` → `["esc"]`). */
function pickerKeys(shortcut: string): string[] {
  const normalized = shortcut.toLowerCase() === "del" ? "delete" : shortcut;
  return normalized
    .split("+")
    .filter((part) => part.length > 0)
    .map((part) => (part === "escape" ? "esc" : part));
}

function pickerAction(
  id: string,
  label: string,
  shortcuts: readonly string[],
  extra: Omit<PickerAction, "id" | "label" | "keys"> = {},
): PickerAction {
  const first = shortcuts[0];
  return first
    ? { id, label, keys: pickerKeys(first), ...extra }
    : { id, label, ...extra };
}

/** Case-insensitive occurrences of `query` in `label` as UTF-16 [from, to) ranges. */
function queryHits(label: string, query: string): [number, number][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = label.toLowerCase();
  const hits: [number, number][] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  )
    hits.push([at, at + needle.length]);
  return hits;
}

/**
 * The stash as Tern's native `picker` sheet: Tern draws the frame, search
 * field, rows and action bar; keys stay this extension's.
 */
function stashPicker(
  items: readonly StashItem[],
  results: readonly StashItem[],
  selectedId: string | null,
  query: string,
  confirmDeleteAll: boolean,
  settings: PromptStashSettings,
): PickerNode {
  const rows = results.map((item) => {
    const label = previewText(item.text);
    const count = lineCount(item.text);
    const hits = queryHits(label, query);
    return {
      id: item.id,
      label,
      facts: { lines: `~${count} ${count === 1 ? "line" : "lines"}` },
      ...(hits.length > 0 ? { hits } : {}),
      title: item.createdAt,
    };
  });
  const actions: PickerAction[] = [
    pickerAction("restore", "Restore", ["enter"], { primary: true }),
  ];
  if (settings.deleteShortcuts.length > 0)
    actions.push(pickerAction("delete", "Delete", settings.deleteShortcuts));
  if (settings.deleteAllShortcuts.length > 0)
    actions.push(
      pickerAction("deleteAll", "Delete all", settings.deleteAllShortcuts, {
        danger: true,
      }),
    );
  actions.push(pickerAction("close", "Close", ["escape"], { end: true }));
  return {
    k: "picker",
    p: {
      title: "Prompt Stash",
      noun: "prompts",
      size: "md",
      layout: "rows",
      preview: "none",
      query,
      placeholder: "Search stashed prompts…",
      columns: [{ id: "lines", format: "dim" }],
      items: rows,
      selected: selectedId,
      total: items.length,
      empty:
        items.length === 0
          ? "Prompt stash is empty"
          : "No matching stashed prompts",
      actions,
      confirm: confirmDeleteAll
        ? {
            text: "Delete all stashed prompts?",
            act: "deleteAll",
            label: "Delete all",
          }
        : null,
    },
  };
}

async function openStashPopup(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const settings = settingsFor(ctx.cwd);
  const path = storePath(ctx, settings);
  mergeLegacyStores(ctx, path, settings);
  let items = loadItems(path);
  if (items.length === 0) {
    ctx.ui.notify("Prompt stash is empty", "info");
    return;
  }

  const restored = await ctx.ui.custom<string | null>(
    (tui, theme, keybindings, done) => {
      let query = "";
      let selected = 0;
      let scroll = 0;
      let focused = true;
      let confirmDeleteAll = false;

      const filtered = () => filterItems(items, query);
      const clampSelection = () => {
        const count = filtered().length;
        if (count === 0) {
          selected = 0;
          scroll = 0;
          return;
        }
        selected = Math.max(0, Math.min(selected, count - 1));
        if (selected < scroll) scroll = selected;
        if (selected >= scroll + settings.listRows)
          scroll = selected - settings.listRows + 1;
        scroll = Math.max(
          0,
          Math.min(scroll, Math.max(0, count - settings.listRows)),
        );
      };

      const deleteSelected = () => {
        const item = filtered()[selected];
        if (!item) return;
        items = items.filter((candidate) => candidate.id !== item.id);
        saveItems(path, items);
        clampSelection();
        tui.requestRender();
      };

      const clearAll = () => {
        items = [];
        saveItems(path, items);
        confirmDeleteAll = false;
        clampSelection();
        tui.requestRender();
      };

      const restoreSelected = () => {
        const item = filtered()[selected];
        if (!item) return;
        done(item.text);
      };

      const render = (width: number): string[] => {
        const panelWidth = Math.min(
          width,
          Math.max(40, Math.floor(settings.popupWidth)),
        );
        const innerWidth = popupContentWidth(panelWidth);
        const results = filtered();
        clampSelection();

        const lines: string[] = [];
        lines.push(
          panelLine(renderSearchLine(query, innerWidth, theme), innerWidth),
        );
        lines.push(panelLine("", innerWidth));

        if (results.length === 0) {
          lines.push(
            panelLine(
              theme.fg("dim", "No matching stashed prompts"),
              innerWidth,
            ),
          );
        } else {
          for (const [visibleIndex, item] of results
            .slice(scroll, scroll + settings.listRows)
            .entries()) {
            const index = scroll + visibleIndex;
            const count = lineCount(item.text);
            const countText = `~${count} ${count === 1 ? "line" : "lines"}`;
            const countWidth = visibleWidth(countText);
            const rowWidth = innerWidth;
            const itemPad = " ";
            const previewWidth = Math.max(
              1,
              rowWidth - visibleWidth(itemPad) - countWidth - 1,
            );
            const preview = truncateToWidth(
              previewText(item.text),
              previewWidth,
              "",
            );
            const styledPreview =
              index === selected ? theme.bold(preview) : preview;
            const styledCount =
              index === selected
                ? theme.fg("text", countText)
                : theme.fg("dim", countText);
            const gap = " ".repeat(
              Math.max(
                1,
                rowWidth -
                  visibleWidth(itemPad) -
                  visibleWidth(preview) -
                  countWidth,
              ),
            );
            const row = `${itemPad}${styledPreview}${gap}${styledCount}`;
            lines.push(
              index === selected
                ? selectedLine(theme, row, innerWidth)
                : panelLine(row, innerWidth),
            );
          }
        }

        const emptyRows = Math.max(
          0,
          settings.listRows -
            Math.max(1, Math.min(results.length, settings.listRows)),
        );
        for (let i = 0; i < emptyRows; i += 1)
          lines.push(panelLine("", innerWidth));

        lines.push(panelLine("", innerWidth));
        const footerParts = [
          `${theme.fg("warning", "-/=")} ${theme.fg("dim", "page")}`,
        ];
        const deleteHint = shortcutHint(settings.deleteShortcuts);
        if (deleteHint)
          footerParts.push(
            `${theme.fg("warning", deleteHint)} ${theme.fg("dim", "delete")}`,
          );
        const deleteAllHint = shortcutHint(settings.deleteAllShortcuts);
        if (deleteAllHint)
          footerParts.push(
            `${theme.fg("warning", deleteAllHint)} ${theme.fg("dim", "delete all")}`,
          );
        const status = confirmDeleteAll
          ? theme.fg("warning", "delete all stashed prompts?")
          : footerParts.join(theme.fg("dim", " · "));
        lines.push(panelLine(status, innerWidth));

        const frame = framePopup(
          lines,
          panelWidth,
          theme,
          "Prompt Stash",
          `${items.length} saved`,
        );
        const left = " ".repeat(
          Math.max(0, Math.floor((width - panelWidth) / 2)),
        );
        return frame.map((line) =>
          truncateToWidth(`${left}${line}`, width, ""),
        );
      };

      let nativeMemo:
        | {
            items: readonly StashItem[];
            query: string;
            selectedId: string | null;
            confirmDeleteAll: boolean;
            node: PickerNode;
          }
        | undefined;

      const describe = (cx: DescribeContext): NativeNode | null => {
        if (!cx.supports("picker")) return null;
        clampSelection();
        const results = filtered();
        const selectedId = results[selected]?.id ?? null;
        if (
          nativeMemo &&
          nativeMemo.items === items &&
          nativeMemo.query === query &&
          nativeMemo.selectedId === selectedId &&
          nativeMemo.confirmDeleteAll === confirmDeleteAll
        )
          return nativeMemo.node;
        const node = stashPicker(
          items,
          results,
          selectedId,
          query,
          confirmDeleteAll,
          settings,
        );
        nativeMemo = { items, query, selectedId, confirmDeleteAll, node };
        return node;
      };

      const selectById = (id: string): boolean => {
        const index = filtered().findIndex((item) => item.id === id);
        if (index < 0) return false;
        selected = index;
        clampSelection();
        return true;
      };

      const handleNativeEvent = (event: NativeUiEvent): void => {
        if (event.key.replaceAll("^", "") !== "") return;
        if (event.type === "select") {
          selectById(event.item);
          return;
        }
        if (event.type === "activate") {
          if (selectById(event.item)) restoreSelected();
          return;
        }
        if (event.type !== "action") return;
        switch (event.act) {
          case "restore":
            restoreSelected();
            return;
          case "delete":
            deleteSelected();
            return;
          case "deleteAll":
            if (confirmDeleteAll) clearAll();
            else confirmDeleteAll = items.length > 0;
            return;
          case "cancel":
            if (confirmDeleteAll) {
              confirmDeleteAll = false;
              return;
            }
            done(null);
            return;
          case "close":
            done(null);
            return;
        }
      };

      return {
        get focused(): boolean {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
        },
        handleInput(data: string) {
          if (matchesAction(keybindings, data, "app.display.reset", "alt+l")) {
            tui.resetDisplay();
            tui.requestRender(true);
            return;
          }
          if (matchesAction(keybindings, data, "app.suspend", "ctrl+z")) {
            handleSuspend(tui);
            return;
          }

          if (confirmDeleteAll) {
            if (matchesKey(data, "return") || matchesKey(data, "enter")) {
              clearAll();
              return;
            }
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
              confirmDeleteAll = false;
              tui.requestRender();
              return;
            }
          }

          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            done(null);
            return;
          }
          if (matchesKey(data, "return") || matchesKey(data, "enter")) {
            restoreSelected();
            return;
          }
          if (matchesKey(data, "up")) {
            selected -= 1;
            clampSelection();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "down")) {
            selected += 1;
            clampSelection();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "-") || matchesKey(data, "pageUp")) {
            selected -= settings.listRows;
            clampSelection();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "=") || matchesKey(data, "pageDown")) {
            selected += settings.listRows;
            clampSelection();
            tui.requestRender();
            return;
          }
          if (matchesAnyShortcut(data, settings.deleteShortcuts)) {
            deleteSelected();
            return;
          }
          if (matchesAnyShortcut(data, settings.deleteAllShortcuts)) {
            confirmDeleteAll = items.length > 0;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "ctrl+u")) {
            query = "";
            selected = 0;
            clampSelection();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "backspace")) {
            query = query.slice(0, -1);
            selected = 0;
            clampSelection();
            tui.requestRender();
            return;
          }
          const printableText = extractPrintableText(data);
          if (printableText) {
            query += printableText;
            selected = 0;
            clampSelection();
            tui.requestRender();
          }
        },
        invalidate() {
          nativeMemo = undefined;
        },
        render,
        nativeSheet: (cx: DescribeContext) => cx.supports("picker"),
        describe,
        handleNativeEvent,
      };
    },
    { overlay: true },
  );

  if (restored !== null) {
    ctx.ui.setEditorText(restored);
  }
}

let stashShortcutOpen = false;

async function toggleStash(ctx: ExtensionContext): Promise<void> {
  if (stashShortcutOpen) return;
  const settings = settingsFor(ctx.cwd);
  const text = ctx.ui.getEditorText() ?? "";
  if (text.length > 0) {
    const count = stashPrompt(ctx, text, settings);
    ctx.ui.setEditorText("");
    ctx.ui.notify(`Stashed prompt (${count} total)`, "info");
    return;
  }

  stashShortcutOpen = true;
  try {
    await openStashPopup(ctx);
  } finally {
    stashShortcutOpen = false;
  }
}

export default function promptStash(pi: ExtensionAPI): void {
  const initialSettings = settingsFor(process.cwd());
  if (initialSettings.shortcut !== "none") {
    pi.registerShortcut(initialSettings.shortcut as KeyId, {
      description: "Stash current prompt or restore from prompt stash",
      handler: async (ctx) => toggleStash(ctx),
    });
  }

  pi.registerCommand("prompt-stash", {
    description: "Open the per-session prompt stash popup",
    handler: async (_args, ctx) => openStashPopup(ctx),
  });
  pi.on("session_start", (_event, ctx) => {
    const settings = settingsFor(ctx.cwd);
    mergeLegacyStores(ctx, storePath(ctx, settings), settings);
  });
}
