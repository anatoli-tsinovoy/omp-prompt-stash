import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { UiNode } from "@oh-my-pi/pi-tui";
import type { KeyEvent, UiProps } from "@oh-my-pi/pi-tui";
import promptStash from "../src/prompt-stash";

type StoredItem = { id: string; text: string; createdAt: string };
type StoredStore = {
  version: number;
  items: StoredItem[];
  legacyMigrationComplete?: boolean;
};
type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};
type Component = UiNode<"picker">;
type Theme = {
  fg(name: string, text: string): string;
  bg(name: string, text: string): string;
  bold(text: string): string;
};
type UiHost = {
  requestRender(): void;
  size(): { columns: number; rows: number };
  suspend<R>(run: () => Promise<R>): Promise<R>;
};
type Keybindings = {
  matches(event: KeyEvent, keybinding: string): boolean;
};
type Context = {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
  ui: FakeUi;
};
type Shortcut = {
  shortcut: string;
  handler: (ctx: Context) => Promise<void> | void;
};
type Command = {
  name: string;
  handler: (args: string[], ctx: Context) => Promise<void> | void;
};
type SessionStart = (event: unknown, ctx: Context) => Promise<void> | void;

type Fixture = {
  root: string;
  home: string;
  agent: string;
  project: string;
  api: FakeApi;
};

const environmentBeforeTest: Record<string, string | undefined> = {};
let cwdBeforeTest = "";
let fixture: Fixture;

const plainTheme: Theme = {
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  bold: (text) => text,
};

const ENTER = "enter";
const ESCAPE = "escape";
const ARROW_DOWN = "down";
const DELETE = "delete";
const BACKSPACE = "backspace";
const CTRL_X = "ctrl+x";
const KITTY_DOWN = "down";
const KITTY_ENTER = "enter";
const KITTY_B = "b";
const MODIFY_OTHER_KEYS_SHIFT_E = "shift+e";
const MODIFY_OTHER_KEYS_CTRL_R = "ctrl+r";

function inputEvent(id: string): KeyEvent {
  const text =
    id === "space"
      ? " "
      : /^shift\+[a-z]$/.test(id)
        ? id.at(-1)?.toUpperCase()
        : id.length === 1
          ? id
          : undefined;
  return { id, text, kind: "press", raw: id };
}

class FakeUi {
  editor: string;
  readonly notifications: Notification[] = [];
  readonly overlays: boolean[] = [];
  readonly renders: Readonly<UiProps<"picker">>[] = [];
  private readonly inputs: string[];
  private active: Component | undefined;
  private readonly host: UiHost;

  constructor(editor = "", inputs: string[] = []) {
    this.editor = editor;
    this.inputs = inputs;
    this.host = {
      requestRender: () => this.captureRender(),
      size: () => ({ columns: 120, rows: 40 }),
      suspend: <R>(run: () => Promise<R>) => run(),
    };
  }

  getEditorText(): string {
    return this.editor;
  }

  setEditorText(text: string): void {
    this.editor = text;
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }

  custom<T>(
    factory: (
      ui: UiHost,
      theme: Theme,
      keybindings: Keybindings,
      done: (result: T) => void,
    ) => Component,
    options?: { overlay?: boolean },
  ): Promise<T> {
    let settled = false;
    const { promise, resolve } = Promise.withResolvers<T>();
    this.overlays.push(options?.overlay === true);
    this.active = factory(
      this.host,
      plainTheme,
      { matches: () => false },
      (value) => {
        settled = true;
        resolve(value);
      },
    );
    this.captureRender();
    for (const input of this.inputs) {
      if (settled) break;
      this.active.handlers.onKey?.(inputEvent(input));
      this.captureRender();
    }
    return promise;
  }

  private captureRender(): void {
    if (this.active) this.renders.push(this.active.props());
  }
}

class FakeApi {
  readonly shortcuts: Shortcut[] = [];
  readonly commands: Command[] = [];
  readonly sessionStarts: SessionStart[] = [];

  registerShortcut(
    shortcut: string,
    spec: { description: string; handler: Shortcut["handler"] },
  ): void {
    this.shortcuts.push({ shortcut, handler: spec.handler });
  }

  registerCommand(
    name: string,
    spec: { description: string; handler: Command["handler"] },
  ): void {
    this.commands.push({ name, handler: spec.handler });
  }

  on(event: "session_start", handler: SessionStart): void {
    if (event === "session_start") this.sessionStarts.push(handler);
  }
}

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in environmentBeforeTest)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environmentBeforeTest)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function settings(values: Record<string, unknown>, cwd?: string): void {
  const path = cwd
    ? join(cwd, ".omp", "plugin-overrides.json")
    : getPluginsLockfile(fixture.home);
  writeJson(path, { settings: { "omp-prompt-stash": values } });
}

function sessionDirectory(session: string): string {
  return join(
    fixture.agent,
    "prompt-stash",
    "sessions",
    session.replace(/[^\w.-]+/g, "_"),
  );
}

function storePath(session: string, file = "prompt-stash.json"): string {
  return join(sessionDirectory(session), file);
}

function readStoreDocument(path: string): StoredStore {
  return JSON.parse(readFileSync(path, "utf8")) as StoredStore;
}

function readStore(path: string): StoredItem[] {
  return readStoreDocument(path).items;
}

function writeStore(path: string, items: StoredItem[]): void {
  writeJson(path, { version: 1, items });
}

function item(id: string, text: string, createdAt: string): StoredItem {
  return { id, text, createdAt };
}

function context(
  session: string,
  editor = "",
  inputs: string[] = [],
  cwd = fixture.project,
): Context {
  return {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => session,
      getSessionFile: () => join(fixture.agent, "sessions", `${session}.jsonl`),
    },
    ui: new FakeUi(editor, inputs),
  };
}

function install(): FakeApi {
  const api = fixture.api;
  const extensionApi = api as unknown as Parameters<typeof promptStash>[0];
  promptStash(extensionApi);
  return api;
}

function shortcut(api: FakeApi): Shortcut {
  const registered = api.shortcuts[0];
  if (!registered)
    throw new Error("Expected prompt stash shortcut to be registered");
  return registered;
}

function command(api: FakeApi): Command {
  const registered = api.commands.find(
    (candidate) => candidate.name === "prompt-stash",
  );
  if (!registered)
    throw new Error("Expected /prompt-stash command to be registered");
  return registered;
}

beforeEach(() => {
  Object.assign(environmentBeforeTest, process.env);
  cwdBeforeTest = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "omp-prompt-stash-test-"));
  const home = join(root, "home");
  const agent = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CONFIG_DIR = ".omp";
  process.env.PI_CODING_AGENT_DIR = agent;
  fixture = { root, home, agent, project, api: new FakeApi() };
});

afterEach(() => {
  if (process.cwd() !== cwdBeforeTest) process.chdir(cwdBeforeTest);
  restoreEnvironment();
  rmSync(fixture.root, { recursive: true, force: true });
  for (const key of Object.keys(environmentBeforeTest))
    delete environmentBeforeTest[key];
});

describe("prompt stash extension factory", () => {
  test("registers configured shortcut, command, and session-start migration", () => {
    settings({ shortcut: "ctrl+shift+s" });
    const api = install();

    expect(api.shortcuts.map((registered) => registered.shortcut)).toEqual([
      "ctrl+shift+s",
    ]);
    expect(api.commands.map((registered) => registered.name)).toEqual([
      "prompt-stash",
    ]);
    expect(api.sessionStarts).toHaveLength(1);
  });

  test("reads global settings from the canonical temporary-HOME lockfile", () => {
    writeJson(getPluginsLockfile(fixture.home), {
      settings: { "omp-prompt-stash": { shortcut: "ctrl+shift+s" } },
    });

    const api = install();

    expect(shortcut(api).shortcut).toBe("ctrl+shift+s");
  });

  test("stashes whitespace-only editor text exactly", async () => {
    const api = install();
    const whitespace = " \n\t ";
    const draft = context("whitespace", whitespace);

    await shortcut(api).handler(draft);

    expect(draft.ui.editor).toBe("");
    expect(readStore(storePath("whitespace"))[0]?.text).toBe(whitespace);
  });

  test("stores dot-only session IDs in a non-dot isolated child directory", async () => {
    const api = install();
    const dot = context(".", "dot prompt");
    const sibling = context("sibling", "sibling prompt");

    await shortcut(api).handler(dot);
    await shortcut(api).handler(sibling);

    const dotPath = join(
      fixture.agent,
      "prompt-stash",
      "sessions",
      "_",
      "prompt-stash.json",
    );
    expect(readStore(dotPath).map((saved) => saved.text)).toEqual([
      "dot prompt",
    ]);
    expect(readStore(storePath("sibling")).map((saved) => saved.text)).toEqual([
      "sibling prompt",
    ]);
    expect(
      existsSync(join(fixture.agent, "prompt-stash", "prompt-stash.json")),
    ).toBeFalse();
  });

  test("stashes, clears the editor, persists 0600 JSON, and isolates sessions", async () => {
    const api = install();
    const alpha = context("alpha", "first prompt");
    await shortcut(api).handler(alpha);
    const beta = context("beta", "second prompt");
    await shortcut(api).handler(beta);

    const alphaPath = storePath("alpha");
    expect(alpha.ui.editor).toBe("");
    expect(alpha.ui.notifications).toContainEqual({
      message: "Stashed prompt (1 total)",
      type: "info",
    });
    expect(readStore(alphaPath).map((saved) => saved.text)).toEqual([
      "first prompt",
    ]);
    expect(readStore(storePath("beta")).map((saved) => saved.text)).toEqual([
      "second prompt",
    ]);
    expect(statSync(alphaPath).mode & 0o777).toBe(0o600);
  });

  test("deduplicates by default and honors project overrides that disable it", async () => {
    settings({ deduplicate: true });
    const api = install();
    const defaultContext = context("default", "repeat");
    await shortcut(api).handler(defaultContext);
    defaultContext.ui.editor = "repeat";
    await shortcut(api).handler(defaultContext);
    expect(readStore(storePath("default"))).toHaveLength(1);

    settings(
      { deduplicate: false, storeFile: "project-stash.json" },
      fixture.project,
    );
    const overrideContext = context("override", "repeat");
    await shortcut(api).handler(overrideContext);
    overrideContext.ui.editor = "repeat";
    await shortcut(api).handler(overrideContext);
    expect(readStore(storePath("override", "project-stash.json"))).toHaveLength(
      2,
    );
    expect(existsSync(storePath("override"))).toBeFalse();
  });

  test("uses a sanitized store filename and recovers from malformed stores", async () => {
    settings({ storeFile: "nested/kept.json" });
    const api = install();
    const safe = context("unsafe/session", "safe prompt");
    await shortcut(api).handler(safe);
    const sanitized = storePath("unsafe/session", "kept.json");
    expect(readStore(sanitized).map((saved) => saved.text)).toEqual([
      "safe prompt",
    ]);
    expect(
      existsSync(
        join(sessionDirectory("unsafe/session"), "nested", "kept.json"),
      ),
    ).toBeFalse();

    mkdirSync(sessionDirectory("broken"), { recursive: true });
    writeFileSync(storePath("broken", "kept.json"), "not json");
    const broken = context("broken", "recovered prompt");
    await shortcut(api).handler(broken);
    expect(
      readStore(storePath("broken", "kept.json")).map((saved) => saved.text),
    ).toEqual(["recovered prompt"]);
  });

  test("merges both legacy stores without replacing current entries", async () => {
    const session = "legacy-session";
    writeStore(storePath(session), [
      item("current", "current", "2025-01-03T00:00:00.000Z"),
    ]);
    writeStore(
      join(
        fixture.home,
        ".pi",
        "agent",
        "vstack",
        "sessions",
        session,
        "prompt-stash",
        "prompt-stash.json",
      ),
      [
        item("home", "home legacy", "2025-01-02T00:00:00.000Z"),
        item("current", "replaced", "2025-01-01T00:00:00.000Z"),
      ],
    );
    writeStore(
      join(
        fixture.agent,
        "vstack",
        "sessions",
        session,
        "prompt-stash",
        "prompt-stash.json",
      ),
      [item("agent", "agent legacy", "2025-01-04T00:00:00.000Z")],
    );
    const api = install();
    await api.sessionStarts[0]?.({}, context(session));

    const merged = readStore(storePath(session));
    expect(merged.map((saved) => saved.id).sort()).toEqual([
      "agent",
      "current",
      "home",
    ]);
    expect(merged.find((saved) => saved.id === "current")?.text).toBe(
      "current",
    );
  });

  test("migrates a version-one store once and keeps deleted legacy items deleted", async () => {
    const session = "delete-migrated";
    const path = storePath(session);
    writeStore(path, []);
    writeStore(
      join(
        fixture.home,
        ".pi",
        "agent",
        "vstack",
        "sessions",
        session,
        "prompt-stash",
        "prompt-stash.json",
      ),
      [
        item("new", "new legacy", "2025-01-02T00:00:00.000Z"),
        item("old", "old legacy", "2025-01-01T00:00:00.000Z"),
      ],
    );
    const api = install();

    await api.sessionStarts[0]?.({}, context(session));
    expect(readStoreDocument(path).legacyMigrationComplete).toBeTrue();
    expect(readStore(path).map((saved) => saved.id)).toEqual(["new", "old"]);

    await command(api).handler([], context(session, "", [DELETE, ESCAPE]));
    expect(readStore(path).map((saved) => saved.id)).toEqual(["old"]);
    expect(readStoreDocument(path).legacyMigrationComplete).toBeTrue();

    await api.sessionStarts[0]?.({}, context(session));
    expect(readStore(path).map((saved) => saved.id)).toEqual(["old"]);

    await command(api).handler(
      [],
      context(session, "", [CTRL_X, ENTER, ESCAPE]),
    );
    expect(readStore(path)).toEqual([]);
    expect(readStoreDocument(path).legacyMigrationComplete).toBeTrue();

    await api.sessionStarts[0]?.({}, context(session));
    expect(readStore(path)).toEqual([]);
  });

  test("notifies for an empty popup", async () => {
    const api = install();
    const empty = context("empty");
    await command(api).handler([], empty);
    expect(empty.ui.notifications).toEqual([
      { message: "Prompt stash is empty", type: "info" },
    ]);
    expect(empty.ui.overlays).toHaveLength(0);
  });

  test("searches, navigates and pages before restoring the selected prompt", async () => {
    writeStore(storePath("picker"), [
      item("four", "fourth prompt", "2025-01-04T00:00:00.000Z"),
      item("three", "third prompt", "2025-01-03T00:00:00.000Z"),
      item("two", "second prompt", "2025-01-02T00:00:00.000Z"),
      item("one", "first prompt", "2025-01-01T00:00:00.000Z"),
    ]);
    settings({ listRows: 2 });
    const api = install();
    const picker = context("picker", "draft stays until restore", [
      "c",
      BACKSPACE,
      ARROW_DOWN,
      "=",
      ENTER,
    ]);
    await command(api).handler([], picker);

    expect(
      picker.ui.renders.some((render) =>
        render.items?.some((entry) => entry.label === "second prompt"),
      ),
    ).toBeTrue();
    expect(
      picker.ui.renders.some((render) => render.title === "Prompt Stash"),
    ).toBeTrue();
    expect(
      picker.ui.renders.some((render) =>
        render.items?.some((entry) => entry.label === "first prompt"),
      ),
    ).toBeTrue();
    expect(picker.ui.editor).toBe("first prompt");
  });

  test("navigates and restores from decoded key events", async () => {
    writeStore(storePath("kitty-navigation"), [
      item("new", "newest", "2025-01-02T00:00:00.000Z"),
      item("old", "oldest", "2025-01-01T00:00:00.000Z"),
    ]);
    const api = install();
    const picker = context("kitty-navigation", "unchanged", [
      KITTY_DOWN,
      KITTY_ENTER,
    ]);
    await command(api).handler([], picker);

    expect(picker.ui.editor).toBe("oldest");
  });

  test("uses configured deletion shortcuts from canonical key events", async () => {
    settings({ deleteShortcuts: "ctrl+r" });
    writeStore(storePath("modified-delete"), [
      item("new", "newest", "2025-01-02T00:00:00.000Z"),
      item("old", "oldest", "2025-01-01T00:00:00.000Z"),
    ]);
    const api = install();
    const picker = context("modified-delete", "unchanged", [
      MODIFY_OTHER_KEYS_CTRL_R,
      ESCAPE,
    ]);
    await command(api).handler([], picker);

    expect(
      readStore(storePath("modified-delete")).map((saved) => saved.text),
    ).toEqual(["oldest"]);
  });

  test("filters from enhanced printable input and ignores modified controls", async () => {
    settings({ deleteShortcuts: "none", deleteAllShortcuts: "none" });
    writeStore(storePath("enhanced-filter"), [
      item("beta", "Beta prompt", "2025-01-02T00:00:00.000Z"),
      item("alpha", "Alpha prompt", "2025-01-01T00:00:00.000Z"),
    ]);
    const api = install();
    const picker = context("enhanced-filter", "unchanged", [
      KITTY_B,
      MODIFY_OTHER_KEYS_SHIFT_E,
      MODIFY_OTHER_KEYS_CTRL_R,
      ENTER,
    ]);
    await command(api).handler([], picker);

    expect(picker.ui.editor).toBe("Beta prompt");
  });

  test("deletes one selected item and supports delete-all confirmation and cancellation", async () => {
    writeStore(storePath("delete"), [
      item("new", "newest", "2025-01-02T00:00:00.000Z"),
      item("old", "oldest", "2025-01-01T00:00:00.000Z"),
    ]);
    const api = install();
    const deleteOne = context("delete", "unchanged", [DELETE, ESCAPE]);
    await command(api).handler([], deleteOne);
    expect(readStore(storePath("delete")).map((saved) => saved.text)).toEqual([
      "oldest",
    ]);

    writeStore(storePath("delete"), [
      item("new", "newest", "2025-01-02T00:00:00.000Z"),
      item("old", "oldest", "2025-01-01T00:00:00.000Z"),
    ]);
    const cancel = context("delete", "unchanged", [CTRL_X, ESCAPE, ESCAPE]);
    await command(api).handler([], cancel);
    expect(
      cancel.ui.renders.some(
        (render) => render.confirm?.text === "Delete all stashed prompts?",
      ),
    ).toBeTrue();
    expect(readStore(storePath("delete"))).toHaveLength(2);

    const confirm = context("delete", "unchanged", [CTRL_X, ENTER, ESCAPE]);
    await command(api).handler([], confirm);
    expect(readStore(storePath("delete"))).toHaveLength(0);
  });

  test("cancels with Escape without changing editor text", async () => {
    writeStore(storePath("cancel"), [
      item("saved", "saved prompt", "2025-01-01T00:00:00.000Z"),
    ]);
    const api = install();
    const cancelled = context("cancel", "editor remains", [ESCAPE]);
    await command(api).handler([], cancelled);
    expect(cancelled.ui.editor).toBe("editor remains");
  });
});
