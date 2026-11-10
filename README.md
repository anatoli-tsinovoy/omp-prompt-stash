# OMP Prompt Stash

`omp-prompt-stash` keeps a private, per-session list of prompts that you can save from and restore to the Oh My Pi editor. It is useful for parking a draft while you work on another prompt without submitting, changing, or sharing it.

## Requirements

- [Oh My Pi](https://github.com/can1357/oh-my-pi) 17.2.9 or later

## Install

Install the public plugin:

```sh
omp plugin install github:anatoli-tsinovoy/omp-prompt-stash
```

Start a new OMP session after installing or changing the global shortcut.

## Use

### Stash and restore

The default global shortcut is `Ctrl+H`:

- With text in the editor, it saves that text to the current session's stash, clears the editor, and shows the saved-item count.
- With an empty editor, it opens the stash picker. Select an item and press `Enter` to restore its full text to the editor.

Use `/prompt-stash` to open the current session's picker directly. It does not submit a prompt.

If the current session has no saved prompts, opening the picker shows an informational notification instead.

### Picker keyboard controls

| Keys                                                 | Action                                               |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `Enter`                                              | Restore the selected prompt into the editor          |
| `Esc` or `Ctrl+C`                                    | Close the picker without changing the editor         |
| `Up` / `Down`                                        | Move the selection                                   |
| `-` / `=` or `PageUp` / `PageDown`                   | Move by one configured page of rows                  |
| Type text                                            | Filter saved prompts by case-insensitive text match  |
| `Backspace`                                          | Remove one character from the filter                 |
| `Ctrl+U`                                             | Clear the filter                                     |
| `Ctrl+R` or `Delete`                                 | Delete the selected saved prompt by default          |
| `Ctrl+X`                                             | Ask to delete every saved prompt by default          |
| `Enter` while confirming delete-all                  | Delete every saved prompt                            |
| `Esc` or `Ctrl+C` while confirming delete-all        | Keep every saved prompt and return to the picker     |
| OMP display-reset shortcut (default `Alt+L`)         | Reset the display and redraw the picker              |
| OMP suspend shortcut (default `Ctrl+Z`, non-Windows) | Suspend the terminal UI; resume to redraw the picker |

The delete and delete-all keys are configurable. The picker displays its active delete hints.

In [Tern](https://docs.stencil.so/tern/), the picker is drawn as Tern's native picker sheet (search field, rows, and Restore/Delete/Delete all/Close buttons) instead of terminal rows; `popupWidth` and `listRows` apply only to the terminal-row picker. Keys work the same in both.

## Settings

Settings are stored under the package key `omp-prompt-stash`. Put global settings in:

```text
~/.omp/plugins/omp-plugins.lock.json
```

inside its `settings` object:

```json
{
  "settings": {
    "omp-prompt-stash": {
      "shortcut": "ctrl+h",
      "deleteShortcuts": "ctrl+r,delete",
      "deleteAllShortcuts": "ctrl+x",
      "storeFile": "prompt-stash.json",
      "deduplicate": true,
      "popupWidth": 92,
      "listRows": 10
    }
  }
}
```

For a project-only override, create or update `.omp/plugin-overrides.json` in that project's working directory using the same nesting. Project values override only the corresponding global values, so unspecified values continue to use their global value or default:

```json
{
  "settings": {
    "omp-prompt-stash": {
      "deduplicate": false,
      "listRows": 20
    }
  }
}
```

| Setting              | Type and default              | Effect                                                                                                                                                                  |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shortcut`           | string, `"ctrl+h"`            | Global stash/restore shortcut. Set to `"none"` to disable it. Restart OMP after changing it.                                                                            |
| `deleteShortcuts`    | string, `"ctrl+r,delete"`     | Comma-separated picker shortcuts for deleting the selected item. Set to `"none"` to disable. The defaults intentionally avoid `Ctrl+D`, which is OMP's global TUI exit. |
| `deleteAllShortcuts` | string, `"ctrl+x"`            | Comma-separated picker shortcuts that request deletion of all items. Set to `"none"` to disable.                                                                        |
| `storeFile`          | string, `"prompt-stash.json"` | File name used inside the session's prompt-stash directory. Path components are ignored, so this cannot place data outside that directory.                              |
| `deduplicate`        | boolean, `true`               | When saving a prompt, removes older saved entries with the same text.                                                                                                   |
| `popupWidth`         | number, `92` (minimum `40`)   | Preferred visual width of the centered picker panel.                                                                                                                    |
| `listRows`           | number, `10` (minimum `1`)    | Number of visible saved-prompt rows before the picker scrolls.                                                                                                          |

Shortcut names are case-insensitive and must use OMP key identifiers. Comma-separated shortcut lists ignore empty entries and `none` entries; `none` by itself disables the list. Empty or wrong-typed settings fall back to their defaults, and numeric values are rounded down to their stated minimums.

## Storage and privacy

Stashes are isolated by OMP session. By default, each session is stored at:

```text
~/.omp/agent/prompt-stash/sessions/<session>/prompt-stash.json
```

When OMP sets `PI_CODING_AGENT_DIR`, that active agent directory replaces `~/.omp/agent`; `PI_CONFIG_DIR` controls the OMP configuration root when no active agent directory is set. `<session>` is derived from OMP's session ID (or its session filename when necessary) and is sanitized for a safe directory name.

The plugin creates its stash directories with mode `0700` and writes the JSON store atomically with mode `0600`. The saved content is local prompt text, including any sensitive material you place in the editor. It is not sent by this plugin to a network service, but protect your account and filesystem accordingly. Delete individual entries or use delete-all when the content is no longer needed.

### Legacy data migration

On the first session start or before the first stash read or write, the plugin scans these old locations for the same session and configured store filename:

```text
~/.pi/agent/vstack/sessions/<session>/prompt-stash/<storeFile>
<active-agent-dir>/vstack/sessions/<session>/prompt-stash/<storeFile>
```

After that scan, the current store records that legacy migration is complete, so deleted entries cannot be re-imported later. Records are merged by item ID, duplicates are not copied, and the legacy files are left untouched.

## Update and uninstall

Reinstall from GitHub to update the plugin:

```sh
omp plugin install github:anatoli-tsinovoy/omp-prompt-stash
```

Remove the plugin:

```sh
omp plugin uninstall omp-prompt-stash
```

Uninstalling removes the plugin registration; it does not delete your per-session prompt-stash data. Remove saved entries in the picker, or delete the storage directory yourself, only when you intentionally want to discard them.

## Local development

Link a checkout while developing:

```sh
git clone https://github.com/anatoli-tsinovoy/omp-prompt-stash.git
cd omp-prompt-stash
bun install
omp plugin link .
```

Edits in the linked checkout are used by OMP. Start a new OMP session and use `Ctrl+H` or `/prompt-stash` to exercise the plugin. To return to the public release, install it again with the GitHub install command above.

## Non-destructive behavior

The plugin only saves editor text when you explicitly stash it, restores a selected saved item into the editor, and removes saved items only through its delete actions. It does not submit prompts, alter conversations, modify project files, or delete legacy stash files.

## License

[MIT](LICENSE)
