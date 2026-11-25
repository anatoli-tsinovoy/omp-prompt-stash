import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { computed, jsx, signal } from "@oh-my-pi/pi-tui";
import type {
  KeyEvent,
  NodeAttributes,
  PasteEvent,
  Reactive,
  UiProps,
} from "@oh-my-pi/pi-tui";

type PickerProps = UiProps<"picker">;
type PickerAction = NonNullable<PickerProps["actions"]>[number];
type PickerAttributes = {
  [K in keyof PickerProps]?: Reactive<PickerProps[K]>;
} & NodeAttributes;

const PACKAGE_ID = "omp-prompt-stash";
const DEFAULT_STORE_FILE = "prompt-stash.json";
const STORE_VERSION = 1;
const DEFAULT_SHORTCUT = "ctrl+h";
const DEFAULT_DELETE_SHORTCUTS = "ctrl+r,delete";
const DEFAULT_DELETE_ALL_SHORTCUTS = "ctrl+x";
const DEFAULT_POPUP_WIDTH = 92;
const DEFAULT_LIST_ROWS = 10;

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

const KEY_ID_MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const KEY_ID_ALIASES: Record<string, string> = {
  del: "delete",
  esc: "escape",
  return: "enter",
  pageup: "pageUp",
  pagedown: "pageDown",
};
const SHIFTED_SYMBOLS: Record<string, true> = {
  "!": true,
  "@": true,
  "#": true,
  $: true,
  "%": true,
  "^": true,
  "&": true,
  "*": true,
  "(": true,
  ")": true,
  _: true,
  "+": true,
  "|": true,
  "~": true,
  "{": true,
  "}": true,
  ":": true,
  "<": true,
  ">": true,
  "?": true,
};

function normalizeKeyId(key: string): string {
  const modifiers = new Set<string>();
  let offset = 0;

  for (;;) {
    let found = false;
    for (const modifier of KEY_ID_MODIFIERS) {
      const end = offset + modifier.length;
      if (
        key.length <= end + 1 ||
        key[end] !== "+" ||
        key.slice(offset, end).toLowerCase() !== modifier
      )
        continue;
      modifiers.add(modifier);
      offset = end + 1;
      found = true;
      break;
    }
    if (!found) break;
  }

  const raw = key.slice(offset);
  const lower = raw.toLowerCase();
  const base = KEY_ID_ALIASES[lower] ?? lower;
  if (/^[A-Z]$/.test(raw)) modifiers.add("shift");
  if (
    modifiers.size === 1 &&
    modifiers.has("shift") &&
    SHIFTED_SYMBOLS[base] === true
  )
    return base;

  return `${KEY_ID_MODIFIERS.filter((modifier) => modifiers.has(modifier))
    .map((modifier) => `${modifier}+`)
    .join("")}${base}`;
}

function shortcutList(value: string): string[] {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "none") return [];
  return trimmed
    .split(",")
    .map((shortcut) => shortcut.trim())
    .filter((shortcut) => shortcut.length > 0 && shortcut !== "none")
    .map(normalizeKeyId);
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

function filterItems(items: StashItem[], query: string): StashItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) => searchable(item.text).includes(trimmed));
}

function matchesKey(event: KeyEvent, key: string): boolean {
  return (
    event.kind !== "release" && normalizeKeyId(event.id) === normalizeKeyId(key)
  );
}

function matchesAnyShortcut(
  event: KeyEvent,
  shortcuts: readonly string[],
): boolean {
  return (
    event.kind !== "release" && shortcuts.includes(normalizeKeyId(event.id))
  );
}

/** Keycap names for a shortcut id (`"ctrl+r"` → `["ctrl", "r"]`, `"escape"` → `["esc"]`). */
function pickerKeys(shortcut: string): string[] {
  const normalized = normalizeKeyId(shortcut);
  if (normalized === "+") return ["+"];
  const parts = normalized.split("+").filter((part) => part.length > 0);
  if (normalized.endsWith("++")) parts.push("+");
  return parts.map((part) => (part === "escape" ? "esc" : part));
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

/** Build picker rows with prompt previews and line-count facts. */
function pickerItems(
  results: readonly StashItem[],
  query: string,
): NonNullable<PickerProps["items"]> {
  return results.map((item) => {
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
}

async function openStashPopup(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const settings = settingsFor(ctx.cwd);
  const path = storePath(ctx, settings);
  mergeLegacyStores(ctx, path, settings);
  const initialItems = loadItems(path);
  if (initialItems.length === 0) {
    ctx.ui.notify("Prompt stash is empty", "info");
    return;
  }

  const restored = await ctx.ui.custom<string | null>(
    (_ui, _theme, _keybindings, done) => {
      const items = signal(initialItems);
      const query = signal("");
      const selected = signal(0);
      const confirmDeleteAll = signal(false);
      const results = computed(() => filterItems(items(), query()));
      const rows = computed(() => pickerItems(results(), query()));
      const selectedId = computed(() => results()[selected()]?.id ?? null);
      const actions: PickerAction[] = [
        pickerAction("restore", "Restore", ["enter"], { primary: true }),
      ];
      if (settings.deleteShortcuts.length > 0)
        actions.push(
          pickerAction("delete", "Delete", settings.deleteShortcuts),
        );
      if (settings.deleteAllShortcuts.length > 0)
        actions.push(
          pickerAction("deleteAll", "Delete all", settings.deleteAllShortcuts, {
            danger: true,
          }),
        );
      actions.push(pickerAction("close", "Close", ["escape"], { end: true }));

      const clampSelection = (): void => {
        const last = Math.max(0, results().length - 1);
        selected.set(Math.max(0, Math.min(selected(), last)));
      };

      const moveSelection = (delta: number): void => {
        const last = Math.max(0, results().length - 1);
        selected.set(Math.max(0, Math.min(selected() + delta, last)));
      };

      const deleteSelected = (): void => {
        const item = results()[selected()];
        if (!item) return;
        const next = items().filter((candidate) => candidate.id !== item.id);
        items.set(next);
        saveItems(path, next);
        clampSelection();
      };

      const clearAll = (): void => {
        items.set([]);
        saveItems(path, []);
        confirmDeleteAll.set(false);
        clampSelection();
      };

      const restoreSelected = (): void => {
        const item = results()[selected()];
        if (item) done(item.text);
      };

      const selectById = (id: string): boolean => {
        const index = results().findIndex((item) => item.id === id);
        if (index < 0) return false;
        selected.set(index);
        return true;
      };

      const handleKey = (key: KeyEvent): boolean => {
        if (key.kind === "release") return false;

        if (confirmDeleteAll()) {
          if (matchesKey(key, "enter")) {
            clearAll();
            return true;
          }
          if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
            confirmDeleteAll.set(false);
            return true;
          }
        }

        if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
          done(null);
          return true;
        }
        if (matchesKey(key, "enter")) {
          restoreSelected();
          return true;
        }
        if (matchesKey(key, "up")) {
          moveSelection(-1);
          return true;
        }
        if (matchesKey(key, "down")) {
          moveSelection(1);
          return true;
        }
        if (matchesKey(key, "-") || matchesKey(key, "pageUp")) {
          moveSelection(-settings.listRows);
          return true;
        }
        if (matchesKey(key, "=") || matchesKey(key, "pageDown")) {
          moveSelection(settings.listRows);
          return true;
        }
        if (matchesAnyShortcut(key, settings.deleteShortcuts)) {
          deleteSelected();
          return true;
        }
        if (matchesAnyShortcut(key, settings.deleteAllShortcuts)) {
          confirmDeleteAll.set(items().length > 0);
          return true;
        }
        if (matchesKey(key, "ctrl+u")) {
          query.set("");
          selected.set(0);
          return true;
        }
        if (matchesKey(key, "backspace")) {
          query.set(query().slice(0, -1));
          selected.set(0);
          return true;
        }
        if (key.text) {
          query.set(query() + key.text);
          selected.set(0);
          return true;
        }
        return false;
      };

      const handlePaste = (paste: PasteEvent): boolean => {
        query.set(query() + paste.text);
        selected.set(0);
        return true;
      };

      const handleAction = (act: string): void => {
        switch (act) {
          case "restore":
            restoreSelected();
            return;
          case "delete":
            deleteSelected();
            return;
          case "deleteAll":
            if (confirmDeleteAll()) clearAll();
            else confirmDeleteAll.set(items().length > 0);
            return;
          case "cancel":
            if (confirmDeleteAll()) {
              confirmDeleteAll.set(false);
              return;
            }
            done(null);
            return;
          case "close":
            done(null);
            return;
        }
      };

      const props = {
        title: "Prompt Stash",
        noun: "prompts",
        size: settings.popupWidth > DEFAULT_POPUP_WIDTH ? "lg" : "md",
        layout: "rows",
        preview: "none",
        query,
        placeholder: "Search stashed prompts…",
        columns: [{ id: "lines", format: "dim" }],
        items: rows,
        selected: selectedId,
        total: () => items().length,
        empty: () =>
          results().length === 0
            ? items().length === 0
              ? "Prompt stash is empty"
              : "No matching stashed prompts"
            : undefined,
        actions,
        confirm: () =>
          confirmDeleteAll()
            ? {
                text: "Delete all stashed prompts?",
                act: "deleteAll",
                label: "Delete all",
              }
            : null,
        term: { maxRows: settings.listRows, wrap: false },
        onKey: handleKey,
        onPaste: handlePaste,
        onSelect: (id: string) => {
          selectById(id);
        },
        onActivate: (id: string) => {
          if (selectById(id)) restoreSelected();
        },
        onAction: handleAction,
      } satisfies PickerAttributes;

      return jsx("picker", props);
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
    pi.registerShortcut(
      initialSettings.shortcut as Parameters<
        ExtensionAPI["registerShortcut"]
      >[0],
      {
        description: "Stash current prompt or restore from prompt stash",
        handler: async (ctx) => toggleStash(ctx),
      },
    );
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
