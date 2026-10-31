# Pi Pocket extensions

My drop-ins for [Pi Pocket](https://github.com/TannerMidd/pi-pocket): the extensions I write and use
every day, kept here as a backup and to install on another machine.

The files at the top of this repository are one Pi Pocket drop-in folder (`~/.pi-pocket/extensions/`).
Copy what you want into yours, or add this repository as a gallery index (below).

| Extension            | What it does                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `annotate`           | Draw on an image and send it: a full-screen page to circle what to change, with the note and the marked image in the message box. |
| `dictation`          | Streaming dictation for the message box: words appear as you speak, then a model of your choice corrects the text. |
| `extensions-button`  | A rail button that opens the Extensions sheet in one tap.                                                        |
| `lsp`                | Language servers for Pi: type errors after each edit, and exact answers about symbols, for 26 languages.          |
| `mcp-servers`        | Add, remove, and sign in to MCP servers, and give Pi each of their tools.                                          |
| `projects`           | Claude-style projects: a name, folders, and instructions; a session can work in more than one folder.             |

## Install

**As a gallery index** (recommended, one tap per extension):

1. Menu → Extensions → Installed, and set the index to `krittaprot/pi-pocket-extensions`.
2. Discover lists the three entries below. Install, then turn the extension on. Each one starts off.

`annotate`, `dictation`, and `lsp` have gallery entries. The other three do not, for the reasons in
[Not in the gallery yet](#not-in-the-gallery-yet); install those by hand.

**By hand:** copy `<name>.ts` and, where there is one, the folder `<name>/` (or the file `<name>.js`)
into `~/.pi-pocket/extensions/`. Then turn the extension on in Menu → Extensions.

## Not in the gallery yet

- `mcp-servers` gives Pi one tool for each tool of each server, so what it declares is different on
  every machine, and the index refuses a list of more than 100 tools. It also keeps a tool-list cache
  in `mcp-servers/cache.json`, which is not in this repository.
- `extensions-button` and `projects` have browser modules that import the app's own files by path
  (`/store.js`, `/theme.js`, `/sessions.js`). Those are internal to Pi Pocket, so the check that a
  drop-in stands on its own refuses them. They work in the version they were written for.

Please do not add these to the official index as they are.

## Files that are not here

These are made on the machine that runs the extension, and are not worth backing up:

- `mcp-servers/cache.json`: the list of each server's tools.
- `projects/state.json`: the projects, and which session is in which.
- `lsp-tools/`: the TypeScript and language servers that `lsp` installs. It needs `npm install` and
  is 48 MB. The module works without it, through the project's own TypeScript or `npx`.
- `_pocket.d.ts`: Pi Pocket's types, which `lsp.ts` imports with `import type`. A symlink to
  `node_modules/pi-pocket/types/pocket.d.ts`; Node erases the import, so it is only for the editor.
- `*.gallery.json`: where each installed drop-in came from.

## Development

Each module is one TypeScript file whose first `/** … */` comment is its description. `lsp.test.ts`
runs with `node --test lsp.test.ts` in the drop-in folder.

## License

MIT. See [LICENSE](LICENSE).
