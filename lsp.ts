/**
 * Language servers for Pi: type errors after each edit, and exact answers about symbols
 * (definitions, references, hover, workspace symbols) for 26 languages.
 *
 * Servers start on first use, one per project root, and stop after an idle time. A light server
 * starts when Pi reads a file, so the first edit already has diagnostics; a heavy one waits to be
 * asked. The owner sets the behaviour in Menu → Extensions, and per-server overrides as JSON.
 *
 * `lsp-tools/` holds a TypeScript for projects that have none, and the servers installed with
 * `autoInstall`; the module works without it, through the project's TypeScript or `npx`.
 * `node --test lsp.test.ts` runs the tests beside this file.
 */
import { execFile, spawn } from "node:child_process";
import { access, constants as fsConstants, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Web } from "./_pocket.d.ts";

interface Candidate {
    readonly command: string;
    readonly args: readonly string[];
    /** A runner that fetches the server when it starts, such as `npx` or `uvx`: tried last. */
    readonly wrapper?: boolean;
}

interface InstallHint {
    readonly kind: "npm" | "uv" | "manual";
    readonly package?: string;
    readonly note?: string;
}

interface ServerSpec {
    readonly id: string;
    readonly label: string;
    readonly extensions: readonly string[];
    readonly roots: readonly string[];
    readonly candidates: readonly Candidate[];
    /** `read`: start when Pi reads a matching file. `demand`: only when a tool asks. */
    readonly start: "read" | "demand";
    readonly install?: InstallHint;
    /** Runs before the server starts: what it needs to know, or where a tool lives. */
    readonly beforeStart?: (root: string) => Promise<{
        initializationOptions?: Record<string, unknown>;
        env?: Record<string, string>;
    }>;
}

const LANGUAGE_IDS: Record<string, string> = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".cc": "cpp",
    ".c++": "cpp",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".hxx": "cpp",
    ".h++": "cpp",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".zsh": "shellscript",
    ".ksh": "shellscript",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".lua": "lua",
    ".zig": "zig",
    ".zon": "zig",
    ".nix": "nix",
    ".tf": "terraform",
    ".tfvars": "terraform",
    ".rb": "ruby",
    ".rake": "ruby",
    ".gemspec": "ruby",
    ".ru": "ruby",
    ".php": "php",
    ".svelte": "svelte",
    ".vue": "vue",
    ".astro": "astro",
    ".prisma": "prisma",
    ".typ": "typst",
    ".typc": "typst",
    ".dart": "dart",
    ".swift": "swift",
    ".objc": "objective-c",
    ".objcpp": "objective-cpp",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    ".edn": "clojure",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".hs": "haskell",
    ".lhs": "haskell",
    ".gleam": "gleam",
    ".sql": "sql",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".json": "json",
    ".jsonc": "jsonc",
};

/**
 * The servers, in the order a file's servers are tried: the first one that is installed answers.
 * Commands and requirements follow OpenCode's built-in table, with the servers that need a VS Code
 * extension left out.
 */
const SERVERS: readonly ServerSpec[] = [
    {
        id: "typescript",
        label: "tsserver",
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        roots: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
        candidates: [
            { command: "typescript-language-server", args: ["--stdio"] },
            {
                command: "npx",
                args: [
                    "-y",
                    "-p",
                    "typescript",
                    "-p",
                    "typescript-language-server",
                    "typescript-language-server",
                    "--stdio",
                ],
                wrapper: true,
            },
        ],
        start: "read",
        install: { kind: "npm", package: "typescript-language-server" },
        beforeStart: async (root) => {
            const path = (await projectTypescript(root)) ?? (await fallbackTypescriptPath());

            return path === undefined ? {} : { initializationOptions: { tsserver: { path } } };
        },
    },
    {
        id: "python",
        label: "pyright",
        extensions: [".py", ".pyi"],
        roots: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", ".git"],
        candidates: [
            { command: "basedpyright-langserver", args: ["--stdio"] },
            { command: "pyright-langserver", args: ["--stdio"] },
            { command: "uvx", args: ["--from", "basedpyright", "basedpyright-langserver", "--stdio"], wrapper: true },
            { command: "pylsp", args: [] },
        ],
        start: "read",
        install: { kind: "manual", note: "uvx fetches basedpyright by itself on first use" },
    },
    {
        id: "bash",
        label: "bash-language-server",
        extensions: [".sh", ".bash", ".zsh", ".ksh"],
        roots: [".git", ".shellcheckrc"],
        candidates: [
            { command: "bash-language-server", args: ["start"] },
            { command: "npx", args: ["-y", "bash-language-server", "start"], wrapper: true },
        ],
        start: "read",
        install: { kind: "npm", package: "bash-language-server" },
    },
    {
        id: "yaml",
        label: "yaml-language-server",
        extensions: [".yaml", ".yml"],
        roots: [".git", ".yamllint", ".yamllint.yml"],
        candidates: [
            { command: "yaml-language-server", args: ["--stdio"] },
            { command: "npx", args: ["-y", "yaml-language-server", "--stdio"], wrapper: true },
        ],
        start: "read",
        install: { kind: "npm", package: "yaml-language-server" },
    },
    {
        id: "lua",
        label: "lua-language-server",
        extensions: [".lua"],
        roots: [".luarc.json", ".git"],
        candidates: [{ command: "lua-language-server", args: [] }],
        start: "read",
        install: { kind: "manual", note: "brew install lua-language-server" },
    },
    {
        id: "php",
        label: "intelephense",
        extensions: [".php"],
        roots: ["composer.json", ".git"],
        candidates: [
            { command: "intelephense", args: ["--stdio"] },
            { command: "npx", args: ["-y", "intelephense", "--stdio"], wrapper: true },
        ],
        start: "read",
        install: { kind: "npm", package: "intelephense" },
    },
    {
        id: "ruby",
        label: "ruby-lsp",
        extensions: [".rb", ".rake", ".gemspec", ".ru"],
        roots: ["Gemfile", ".ruby-version", ".git"],
        candidates: [{ command: "ruby-lsp", args: [] }],
        start: "read",
        install: { kind: "manual", note: "gem install ruby-lsp" },
    },
    {
        id: "zig",
        label: "zls",
        extensions: [".zig", ".zon"],
        roots: ["build.zig", ".git"],
        candidates: [{ command: "zls", args: [] }],
        start: "read",
        install: { kind: "manual", note: "brew install zls" },
    },
    {
        id: "nix",
        label: "nixd",
        extensions: [".nix"],
        roots: ["flake.nix", ".git"],
        candidates: [{ command: "nixd", args: [] }],
        start: "read",
        install: { kind: "manual", note: "nix profile install nixpkgs#nixd" },
    },
    {
        id: "terraform",
        label: "terraform-ls",
        extensions: [".tf", ".tfvars"],
        roots: [".terraform", ".git"],
        candidates: [{ command: "terraform-ls", args: ["serve"] }],
        start: "demand",
        install: { kind: "manual", note: "brew install terraform-ls" },
    },
    {
        id: "svelte",
        label: "svelteserver",
        extensions: [".svelte"],
        roots: ["svelte.config.js", "package.json"],
        candidates: [
            { command: "svelteserver", args: ["--stdio"] },
            { command: "npx", args: ["-y", "svelte-language-server", "--stdio"], wrapper: true },
        ],
        start: "demand",
        install: { kind: "npm", package: "svelte-language-server" },
    },
    {
        id: "vue",
        label: "vue-language-server",
        extensions: [".vue"],
        roots: ["vue.config.js", "vite.config.ts", "package.json"],
        candidates: [
            { command: "vue-language-server", args: ["--stdio"] },
            { command: "npx", args: ["-y", "@vue/language-server", "--stdio"], wrapper: true },
        ],
        start: "demand",
        install: { kind: "npm", package: "@vue/language-server" },
    },
    {
        id: "astro",
        label: "astro-ls",
        extensions: [".astro"],
        roots: ["astro.config.mjs", "astro.config.ts", "package.json"],
        candidates: [
            { command: "astro-ls", args: ["--stdio"] },
            { command: "npx", args: ["-y", "@astrojs/language-server", "--stdio"], wrapper: true },
        ],
        start: "demand",
        install: { kind: "npm", package: "@astrojs/language-server" },
    },
    {
        id: "prisma",
        label: "prisma-language-server",
        extensions: [".prisma"],
        roots: ["schema.prisma", "package.json"],
        candidates: [
            { command: "prisma-language-server", args: ["--stdio"] },
            { command: "npx", args: ["-y", "@prisma/language-server", "--stdio"], wrapper: true },
        ],
        start: "demand",
        install: { kind: "npm", package: "@prisma/language-server" },
    },
    {
        id: "typst",
        label: "tinymist",
        extensions: [".typ", ".typc"],
        roots: ["typst.toml", ".git"],
        candidates: [{ command: "tinymist", args: ["lsp"] }],
        start: "demand",
        install: { kind: "manual", note: "brew install tinymist" },
    },
    {
        id: "ocaml",
        label: "ocamllsp",
        extensions: [".ml", ".mli"],
        roots: ["dune-project", ".git"],
        candidates: [{ command: "ocamllsp", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "opam install ocaml-lsp-server" },
    },
    {
        id: "gleam",
        label: "gleam",
        extensions: [".gleam"],
        roots: ["gleam.toml", ".git"],
        candidates: [{ command: "gleam", args: ["lsp"] }],
        start: "demand",
        install: { kind: "manual", note: "brew install gleam" },
    },
    {
        id: "dart",
        label: "dart",
        extensions: [".dart"],
        roots: ["pubspec.yaml", ".git"],
        candidates: [{ command: "dart", args: ["language-server"] }],
        start: "demand",
        install: { kind: "manual", note: "install the Dart SDK" },
    },
    {
        id: "go",
        label: "gopls",
        extensions: [".go"],
        roots: ["go.mod", "go.work", ".git"],
        candidates: [{ command: "gopls", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "go install golang.org/x/tools/gopls@latest" },
    },
    {
        id: "clangd",
        label: "clangd",
        extensions: [".c", ".h", ".cpp", ".cxx", ".cc", ".c++", ".hpp", ".hh", ".hxx", ".h++"],
        roots: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".clangd", ".git"],
        candidates: [{ command: "clangd", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "brew install llvm" },
    },
    {
        id: "rust",
        label: "rust-analyzer",
        extensions: [".rs"],
        roots: ["Cargo.toml", "Cargo.lock", ".git"],
        candidates: [{ command: "rust-analyzer", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "rustup component add rust-analyzer" },
    },
    {
        id: "swift",
        label: "sourcekit-lsp",
        extensions: [".swift", ".objc", ".objcpp"],
        roots: ["Package.swift", ".git"],
        candidates: [{ command: "sourcekit-lsp", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "comes with Xcode on macOS" },
    },
    {
        id: "java",
        label: "jdtls",
        extensions: [".java"],
        roots: ["pom.xml", "build.gradle", "settings.gradle", ".git"],
        candidates: [{ command: "jdtls", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "brew install jdtls" },
    },
    {
        id: "kotlin",
        label: "kotlin-language-server",
        extensions: [".kt", ".kts"],
        roots: ["settings.gradle", "build.gradle", "build.gradle.kts", ".git"],
        candidates: [{ command: "kotlin-language-server", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "brew install kotlin-language-server" },
    },
    {
        id: "clojure",
        label: "clojure-lsp",
        extensions: [".clj", ".cljs", ".cljc", ".edn"],
        roots: ["deps.edn", "project.clj", ".git"],
        candidates: [{ command: "clojure-lsp", args: [] }],
        start: "demand",
        install: { kind: "manual", note: "brew install clojure-lsp/brew/clojure-lsp-native" },
    },
    {
        id: "haskell",
        label: "haskell-language-server",
        extensions: [".hs", ".lhs"],
        roots: ["cabal.project", "stack.yaml", ".git"],
        candidates: [{ command: "haskell-language-server-wrapper", args: ["--lsp"] }],
        start: "demand",
        install: { kind: "manual", note: "ghcup install hls" },
    },
];

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "lsp-tools");
const TSSERVER = "lib/tsserver.js";

const START_TIMEOUT = 25_000;
const REQUEST_TIMEOUT = 20_000;
const DIAGNOSTICS_TIMEOUT = 20_000;
const EDIT_WAIT = 2_500;
const MAX_FILE_BYTES = 2_000_000;
const MAX_LISTED = 25;
const QUIET_MS = 700;

const SEVERITIES = ["", "error", "warning", "info", "hint"];

function oneLine(text: string, max = 300): string {
    const flat = String(text).replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path, fsConstants.F_OK);

        return true;
    } catch {
        return false;
    }
}

async function executableOnPath(command: string): Promise<boolean> {
    if (isAbsolute(command) || command.includes("/")) {
        try {
            await access(command, fsConstants.X_OK);

            return true;
        } catch {
            return false;
        }
    }

    for (const folder of (process.env.PATH ?? "").split(":")) {
        if (folder === "") {
            continue;
        }

        try {
            await access(join(folder, command), fsConstants.X_OK);

            return true;
        } catch {
            // The next folder.
        }
    }

    return false;
}

// ─── TypeScript: which tsserver to use ───────────────────────────────────────

/** The project's own TypeScript, which is the version that its code is written against. */
async function projectTypescript(root: string): Promise<string | undefined> {
    let folder = root;

    for (let step = 0; step < 8; step += 1) {
        const candidate = join(folder, "node_modules", "typescript");

        if (await exists(join(candidate, TSSERVER))) {
            return candidate;
        }

        const parent = dirname(folder);

        if (parent === folder) {
            break;
        }

        folder = parent;
    }

    return undefined;
}

let globalRoot: Promise<string | undefined> | undefined;

/** The global package folder of this machine's Node, asked once. */
function npmGlobalRoot(): Promise<string | undefined> {
    if (globalRoot === undefined) {
        globalRoot = new Promise((settle) => {
            execFile("npm", ["root", "-g"], { timeout: 8000 }, (error, stdout) => {
                settle(error !== null ? undefined : stdout.trim() || undefined);
            }).on("error", () => settle(undefined));
        });
    }

    return globalRoot;
}

/** The newest TypeScript in npm's npx cache: what `npx -p typescript` already fetched. */
async function cachedTypescript(): Promise<string | undefined> {
    let entries: string[] = [];

    try {
        entries = await readdir(join(homedir(), ".npm", "_npx"));
    } catch {
        return undefined;
    }

    const found: { path: string; time: number }[] = [];

    for (const entry of entries) {
        const candidate = join(homedir(), ".npm", "_npx", entry, "node_modules", "typescript");

        if (!(await exists(join(candidate, TSSERVER)))) {
            continue;
        }

        try {
            found.push({ path: candidate, time: (await stat(candidate)).mtimeMs });
        } catch {
            // It went while we looked.
        }
    }

    found.sort((a, b) => b.time - a.time);

    return found[0]?.path;
}

let fallbackTypescript: Promise<string | undefined> | undefined;

/**
 * A TypeScript for a project that has none. Typescript 7 ships no `tsserver.js`, so only a version
 * with one counts; the module's own copy in `lsp-tools/` is the last answer.
 */
function fallbackTypescriptPath(): Promise<string | undefined> {
    if (fallbackTypescript === undefined) {
        fallbackTypescript = (async () => {
            const root = await npmGlobalRoot();
            const shared = root === undefined ? undefined : join(root, "typescript");

            if (shared !== undefined && (await exists(join(shared, TSSERVER)))) {
                return shared;
            }

            const cached = await cachedTypescript();

            if (cached !== undefined) {
                return cached;
            }

            const own = join(TOOLS_DIR, "node_modules", "typescript");

            return (await exists(join(own, TSSERVER))) ? own : undefined;
        })();
    }

    return fallbackTypescript;
}

// ─── Settings and per-server overrides ───────────────────────────────────────

interface Override {
    readonly disabled?: boolean;
    readonly command?: readonly string[];
    readonly extensions?: readonly string[];
    readonly env?: Record<string, string>;
    readonly initialization?: Record<string, unknown>;
}

/** A spec as the owner's overrides leave it. */
interface ResolvedSpec extends ServerSpec {
    readonly base: ServerSpec;
}

let hostWeb: Web | undefined;

function setting<T>(name: string, fallback: T): T {
    try {
        const value = hostWeb?.setting(name);

        return (value === undefined ? fallback : value) as T;
    } catch {
        return fallback;
    }
}

function overrides(): Record<string, Override> {
    const text = setting<string>("overrides", "{}");

    try {
        const parsed = JSON.parse(text);

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function resolvedSpecs(): ResolvedSpec[] {
    const map = overrides();
    const list: ResolvedSpec[] = [];

    for (const spec of SERVERS) {
        const override: Override = map[spec.id] ?? {};

        if (override.disabled === true) {
            continue;
        }

        const command = Array.isArray(override.command) && override.command.length > 0 ? override.command : undefined;

        list.push({
            ...spec,
            base: spec,
            extensions:
                Array.isArray(override.extensions) && override.extensions.length > 0 ? override.extensions : spec.extensions,
            candidates: command === undefined ? spec.candidates : [{ command: command[0], args: command.slice(1) }],
            beforeStart: async (root) => {
                const own = spec.beforeStart === undefined ? {} : await spec.beforeStart(root);

                return {
                    initializationOptions: { ...own.initializationOptions, ...override.initialization },
                    env: { ...own.env, ...override.env },
                };
            },
        });
    }

    return list;
}

function isDisabled(id: string): boolean {
    return overrides()[id]?.disabled === true;
}

/** The specs that claim a path's extension, in table order. */
function specsForExtension(path: string): ResolvedSpec[] {
    const extension = extname(path).toLowerCase();

    if (!(extension in LANGUAGE_IDS)) {
        return [];
    }

    return resolvedSpecs().filter((spec) => spec.extensions.includes(extension));
}

// ─── Commands ────────────────────────────────────────────────────────────────

const candidateCache = new Map<string, Candidate | undefined>();

async function localBinary(command: string): Promise<string | undefined> {
    const path = join(TOOLS_DIR, "node_modules", ".bin", command);

    return (await exists(path)) ? path : undefined;
}

async function resolveCandidate(spec: ResolvedSpec): Promise<Candidate | undefined> {
    if (candidateCache.has(spec.id)) {
        return candidateCache.get(spec.id);
    }

    let found: Candidate | undefined;
    const override = overrides()[spec.id]?.command;

    if (Array.isArray(override) && override.length > 0) {
        found = { command: override[0], args: override.slice(1) };
    } else {
        // A real binary on PATH, then one this module installed, then a runner that fetches it.
        for (const candidate of spec.candidates) {
            if (candidate.wrapper !== true && (await executableOnPath(candidate.command))) {
                found = candidate;

                break;
            }
        }

        if (found === undefined) {
            for (const candidate of spec.candidates) {
                const local = await localBinary(candidate.command);

                if (local !== undefined) {
                    found = { command: local, args: candidate.args };

                    break;
                }
            }
        }

        if (found === undefined) {
            for (const candidate of spec.candidates) {
                if (candidate.wrapper === true && (await executableOnPath(candidate.command))) {
                    found = candidate;

                    break;
                }
            }
        }
    }

    candidateCache.set(spec.id, found);

    return found;
}

function runToEnd(command: string, args: readonly string[]): Promise<string> {
    return new Promise((settle, fail) => {
        const child = spawn(command, [...args], { cwd: TOOLS_DIR, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            fail(new Error(`${command} took too long.`));
        }, 180_000);

        child.stdout.on("data", (chunk: Buffer) => {
            output = `${output}${chunk.toString("utf8")}`.slice(-4000);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output = `${output}${chunk.toString("utf8")}`.slice(-4000);
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            fail(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);

            if (code === 0) {
                settle(output);
            } else {
                fail(new Error(oneLine(output) || `${command} exited with ${code}.`));
            }
        });
    });
}

async function installSpec(spec: ResolvedSpec, progress: (text: string) => void): Promise<boolean> {
    const install = spec.install;

    if (install === undefined || install.kind === "manual" || install.package === undefined) {
        return false;
    }

    progress(`Installing ${spec.label} with ${install.kind}…`);

    const command =
        install.kind === "npm"
            ? { command: "npm", args: ["install", "--prefix", TOOLS_DIR, "--no-audit", "--no-fund", install.package] }
            : { command: "uv", args: ["tool", "install", install.package] };

    try {
        await runToEnd(command.command, command.args);
    } catch (error) {
        throw new Error(`Could not install ${spec.label}: ${error instanceof Error ? error.message : String(error)}`);
    }

    candidateCache.clear();
    globalRoot = undefined;
    fallbackTypescript = undefined;

    return (await resolveCandidate(spec)) !== undefined;
}

// ─── Roots ──────────────────────────────────────────────────────────────────

const GENERIC_ROOTS = [".git"];

async function rootFrom(folder: string, markers: readonly string[]): Promise<string> {
    let current = folder;

    for (let step = 0; step < 12; step += 1) {
        for (const marker of [...markers, ...GENERIC_ROOTS]) {
            if (await exists(join(current, marker))) {
                return current;
            }
        }

        const parent = dirname(current);

        if (parent === current) {
            break;
        }

        current = parent;
    }

    return folder;
}

interface AgentApi {
    readonly conversationId: unknown;
    snapshot(document: unknown, conversationId: unknown, context: unknown): Promise<any>;
}

async function cwdOf(api: AgentApi, context: unknown): Promise<string> {
    try {
        const agent = await api.snapshot(AgentDoc, api.conversationId, context);

        if (typeof agent?.cwd === "string" && agent.cwd !== "") {
            return agent.cwd;
        }
    } catch {
        // No agent state: the server's own folder.
    }

    return process.cwd();
}

function showPath(path: string, cwd: string): string {
    const inside = relative(cwd, path);

    return inside === "" || inside.startsWith("..") ? path : inside;
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

/** Reads `Content-Length` framed JSON-RPC messages from a stream. */
class FrameReader {
    private buffer: Buffer = Buffer.alloc(0);
    private remaining = -1;

    push(chunk: Buffer, onMessage: (message: any) => void): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

        for (;;) {
            if (this.remaining < 0) {
                const end = this.buffer.indexOf("\r\n\r\n");

                if (end < 0) {
                    return;
                }

                const header = this.buffer.subarray(0, end).toString("ascii");
                const match = /content-length:\s*(\d+)/i.exec(header);

                this.buffer = this.buffer.subarray(end + 4);

                if (match === null) {
                    continue;
                }

                this.remaining = Number(match[1]);
            }

            if (this.buffer.length < this.remaining) {
                return;
            }

            const body = this.buffer.subarray(0, this.remaining).toString("utf8");

            this.buffer = this.buffer.subarray(this.remaining);
            this.remaining = -1;

            try {
                onMessage(JSON.parse(body));
            } catch {
                // A body that is not JSON goes nowhere, as the protocol says.
            }
        }
    }
}

/** One language server process, for one project root. */
class LanguageServer {
    readonly spec: ResolvedSpec;
    readonly root: string;
    readonly key: string;
    readonly uri: string;
    state: "starting" | "ready" | "dead" = "starting";
    lastUsed = Date.now();
    label: string;

    private started?: Promise<void>;
    private proc: any = undefined;
    private reader = new FrameReader();
    private nextId = 1;
    private pending = new Map<number, { settle: (error?: Error, value?: unknown) => void }>();
    private diagnostics = new Map<string, any[]>();
    private publishes = new Map<string, number>();
    private subscribers = new Map<string, Set<() => void>>();
    private opened = new Map<string, { text: string; version: number }>();
    private failure = "";

    constructor(spec: ResolvedSpec, root: string) {
        this.spec = spec;
        this.root = root;
        this.key = `${spec.id}:${root}`;
        this.uri = pathToFileURL(root).href;
        this.label = spec.label;
    }

    start(): Promise<void> {
        if (this.started === undefined) {
            this.started = this.launch().then(
                () => {
                    this.state = "ready";
                },
                (error) => {
                    this.state = "dead";

                    throw error;
                },
            );
        }

        return this.started;
    }

    private async launch(): Promise<void> {
        const candidate = await resolveCandidate(this.spec);

        if (candidate === undefined) {
            this.state = "dead";

            throw new Error(
                `${this.spec.label}: no ${this.spec.id} language server found${
                    this.spec.install?.note === undefined ? "" : ` (${this.spec.install.note})`
                }.`,
            );
        }

        const extra = this.spec.beforeStart === undefined ? {} : await this.spec.beforeStart(this.root);

        this.label = this.spec.label;

        this.failure = "";

        await this.spawn(candidate, extra.env ?? {});
        await this.initialize(extra.initializationOptions ?? {});
    }

    private spawn(candidate: Candidate, env: Record<string, string>): Promise<void> {
        return new Promise((settle, fail) => {
            const proc = spawn(candidate.command, [...candidate.args], {
                cwd: this.root,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, ...env },
            });

            this.proc = proc;

            const timer = setTimeout(() => fail(new Error("it did not start in time")), START_TIMEOUT);

            proc.on("error", (error: Error) => {
                clearTimeout(timer);
                fail(error);
            });

            proc.on("spawn", () => {
                clearTimeout(timer);
                settle();
            });

            proc.stdout.on("data", (chunk: Buffer) => this.reader.push(chunk, (message) => this.receive(message)));

            proc.stderr.on("data", (chunk: Buffer) => {
                this.failure = `${this.failure}${chunk.toString("utf8")}`.slice(-2000);
            });

            proc.on("exit", () => {
                this.state = "dead";

                for (const [, waiter] of this.pending) {
                    waiter.settle(new Error("the language server stopped"));
                }

                this.pending.clear();

                for (const [, subscribers] of this.subscribers) {
                    for (const done of [...subscribers]) {
                        done();
                    }
                }

                this.subscribers.clear();
            });
        });
    }

    private async initialize(initializationOptions: Record<string, unknown>): Promise<unknown> {
        const request = this.request("initialize", {
            processId: process.pid,
            clientInfo: { name: "pi-pocket-lsp", version: "1" },
            rootUri: this.uri,
            rootPath: this.root,
            workspaceFolders: [{ uri: this.uri, name: basename(this.root) }],
            capabilities: {
                workspace: { workspaceFolders: true, symbol: {}, configuration: true },
                textDocument: {
                    synchronization: { dynamicRegistration: false, didSave: false },
                    publishDiagnostics: { relatedInformation: true },
                    hover: { contentFormat: ["markdown", "plaintext"] },
                    definition: { linkSupport: false },
                    references: {},
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                },
            },
            initializationOptions,
        });

        const result = await request;

        this.notify("initialized", {});

        return result;
    }

    private write(message: unknown): void {
        if (this.proc === undefined || this.proc.stdin.destroyed) {
            return;
        }

        const body = Buffer.from(JSON.stringify(message), "utf8");

        this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.proc.stdin.write(body);
    }

    notify(method: string, params: unknown): void {
        this.write({ jsonrpc: "2.0", method, params });
    }

    request(method: string, params: unknown, timeout = REQUEST_TIMEOUT): Promise<any> {
        const id = this.nextId;
        this.nextId += 1;

        return new Promise((settle, fail) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                fail(new Error(`The language server did not answer ${method} in time.`));
            }, timeout);

            this.pending.set(id, {
                settle: (error, value) => {
                    clearTimeout(timer);

                    if (error !== undefined) {
                        fail(error);
                    } else {
                        settle(value);
                    }
                },
            });

            this.write({ jsonrpc: "2.0", id, method, params });
        });
    }

    private answer(id: unknown, method: string, params: any): void {
        let result: unknown = null;

        if (method === "workspace/configuration") {
            result = Array.isArray(params?.items) ? params.items.map(() => ({})) : [];
        } else if (method === "workspace/workspaceFolders") {
            result = [{ uri: this.uri, name: basename(this.root) }];
        }

        this.write({ jsonrpc: "2.0", id, result });
    }

    private receive(message: any): void {
        if (message.id !== undefined && typeof message.method === "string") {
            this.answer(message.id, message.method, message.params);

            return;
        }

        if (message.id !== undefined) {
            const waiter = this.pending.get(message.id);

            if (waiter !== undefined) {
                this.pending.delete(message.id);

                if (message.error !== undefined) {
                    waiter.settle(new Error(oneLine(message.error?.message ?? "the language server refused")));
                } else {
                    waiter.settle(undefined, message.result);
                }
            }

            return;
        }

        if (message.method === "textDocument/publishDiagnostics") {
            const uri = String(message.params?.uri ?? "");

            this.diagnostics.set(uri, Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : []);
            this.publishes.set(uri, (this.publishes.get(uri) ?? 0) + 1);

            for (const done of [...(this.subscribers.get(uri) ?? [])]) {
                done();
            }
        }
    }

    /** Opens the file in the server, or sends its new text. Answers whether the text changed. */
    async syncDoc(path: string): Promise<{ uri: string; changed: boolean }> {
        let text: string;

        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            throw new Error(
                (error as { code?: string }).code === "ENOENT"
                    ? `${path} does not exist.`
                    : `Could not read ${path}: ${String((error as Error).message)}`,
            );
        }

        if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
            throw new Error(`${basename(path)} is too large for the language server.`);
        }

        const uri = pathToFileURL(path).href;
        const known = this.opened.get(uri);

        if (known === undefined) {
            this.opened.set(uri, { text, version: 1 });
            this.notify("textDocument/didOpen", {
                textDocument: {
                    uri,
                    languageId: LANGUAGE_IDS[extname(path).toLowerCase()] ?? "plaintext",
                    version: 1,
                    text,
                },
            });

            return { uri, changed: true };
        }

        if (known.text === text) {
            return { uri, changed: false };
        }

        known.text = text;
        known.version += 1;
        this.notify("textDocument/didChange", {
            textDocument: { uri, version: known.version },
            contentChanges: [{ text }],
        });

        return { uri, changed: true };
    }

    /**
     * Waits until a file's diagnostics stop changing. A server such as tsserver publishes twice: a
     * quick file-local pass, then the project-wide one that carries type errors. `earlyError` ends the
     * wait at the first publish that carries an error: for a caller that reports errors only, that is
     * the whole answer, and a clean file pays the quiet window instead.
     */
    private waitForSettle(
        uri: string,
        after: number,
        timeout: number,
        quietMs: number,
        earlyError: boolean,
    ): Promise<void> {
        return new Promise((settle) => {
            let quiet: any;
            const done = () => {
                clearTimeout(quiet);
                clearTimeout(deadline);
                this.subscribers.get(uri)?.delete(onPublish);
                settle();
            };
            const rest = () => {
                if (earlyError && (this.diagnostics.get(uri) ?? []).some((entry) => entry?.severity === 1)) {
                    done();

                    return;
                }

                clearTimeout(quiet);
                quiet = setTimeout(done, quietMs);
            };
            const onPublish = () => rest();
            const deadline = setTimeout(done, timeout);
            const set = this.subscribers.get(uri) ?? new Set<() => void>();

            set.add(onPublish);
            this.subscribers.set(uri, set);

            if ((this.publishes.get(uri) ?? 0) > after) {
                rest();
            }
        });
    }

    async diagnosticsFor(
        path: string,
        timeout = DIAGNOSTICS_TIMEOUT,
        options: { quietMs?: number; earlyError?: boolean } = {},
    ): Promise<any[]> {
        const { uri, changed } = await this.syncDoc(path);
        const before = this.publishes.get(uri) ?? 0;

        if (changed || !this.diagnostics.has(uri)) {
            await this.waitForSettle(uri, before, timeout, options.quietMs ?? QUIET_MS, options.earlyError === true);
        }

        return this.diagnostics.get(uri) ?? [];
    }

    kill(): void {
        this.state = "dead";

        try {
            this.proc?.stdin?.end();
            this.proc?.kill("SIGTERM");
        } catch {
            // It is already gone.
        }
    }
}

// ─── The registry ───────────────────────────────────────────────────────────

const running = new Map<string, LanguageServer>();

function maxServers(): number {
    const value = Number(setting<number>("maxServers", 4));

    return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 1), 12) : 4;
}

function idleMs(): number {
    const value = Number(setting<number>("idleMinutes", 10));

    return (Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 1), 240) : 10) * 60_000;
}

function evictOne(): void {
    const oldest = [...running.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];

    if (oldest !== undefined) {
        oldest[1].kill();
        running.delete(oldest[0]);
    }
}

async function serverFor(spec: ResolvedSpec, root: string): Promise<LanguageServer> {
    const key = `${spec.id}:${root}`;
    const existing = running.get(key);

    if (existing !== undefined && existing.state !== "dead") {
        existing.lastUsed = Date.now();
        await existing.start();

        return existing;
    }

    while (running.size >= maxServers()) {
        evictOne();
    }

    const server = new LanguageServer(spec, root);

    running.set(key, server);

    try {
        await server.start();
    } catch (error) {
        running.delete(key);
        server.kill();

        throw error;
    }

    server.lastUsed = Date.now();

    return server;
}

function liveServer(spec: ResolvedSpec, root: string): LanguageServer | undefined {
    const server = running.get(`${spec.id}:${root}`);

    return server !== undefined && server.state === "ready" ? server : undefined;
}

function stopAll(): number {
    const count = running.size;

    for (const server of running.values()) {
        server.kill();
    }

    running.clear();

    return count;
}

/** The first installed server that claims a file, and the root it works in. */
async function primaryFor(path: string): Promise<{ spec: ResolvedSpec; root: string; server: LanguageServer }> {
    const specs = specsForExtension(path);

    if (specs.length === 0) {
        throw new Error(
            `${basename(path)}: no language server for ${extname(path) || "this file"}. Set one in the module's overrides.`,
        );
    }

    let failure: Error | undefined;

    for (const spec of specs) {
        const root = await rootFrom(dirname(path), spec.roots);

        try {
            if ((await resolveCandidate(spec)) === undefined) {
                if (setting<boolean>("autoInstall", false)) {
                    await installSpec(spec, () => {});
                } else {
                    throw new Error(
                        `${spec.label} is not installed${spec.install?.note === undefined ? "" : ` (${spec.install.note})`}.`,
                    );
                }
            }

            return { spec, root, server: await serverFor(spec, root) };
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
    }

    throw failure ?? new Error(`No language server could start for ${basename(path)}.`);
}

/** The server for an anchor that may be a folder: what a workspace-wide search needs. */
async function primaryForAnchor(anchor: string, cwd: string): Promise<{ spec: ResolvedSpec; root: string }> {
    const info = await stat(anchor).catch(() => undefined);
    const folder = info?.isDirectory() === true ? anchor : dirname(anchor);

    if (info?.isDirectory() !== true) {
        const found = specsForExtension(anchor);

        if (found[0] !== undefined) {
            return { spec: found[0], root: await rootFrom(folder, found[0].roots) };
        }
    }

    for (const spec of resolvedSpecs()) {
        for (const marker of spec.roots) {
            if (await exists(join(folder, marker))) {
                return { spec, root: await rootFrom(folder, spec.roots) };
            }
        }
    }

    const fallback = resolvedSpecs().find((spec) => spec.id === "typescript") ?? resolvedSpecs()[0];

    if (fallback === undefined) {
        throw new Error("Every language server is disabled in the module's overrides.");
    }

    return { spec: fallback, root: await rootFrom(folder, fallback.roots) };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function locationText(location: any, cwd: string): string | undefined {
    const uri = location?.uri ?? location?.targetUri;

    if (typeof uri !== "string" || !uri.startsWith("file:")) {
        return undefined;
    }

    const range = location.range ?? location.targetSelectionRange ?? location.targetRange;

    if (range === undefined) {
        return undefined;
    }

    return `${showPath(fileURLToPath(uri), cwd)}:${(range.start?.line ?? 0) + 1}:${(range.start?.character ?? 0) + 1}`;
}

function positionOf(args: { line?: number; column?: number }): { line: number; character: number } {
    const line = Number(args.line ?? 1);
    const column = Number(args.column ?? 1);

    if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) {
        throw new Error("Line and column count from 1.");
    }

    return { line: line - 1, character: column - 1 };
}

function diagnosticLine(diagnostic: any, path: string, cwd: string): string {
    const severity = SEVERITIES[diagnostic?.severity ?? 1] || "error";
    const line = (diagnostic?.range?.start?.line ?? 0) + 1;
    const column = (diagnostic?.range?.start?.character ?? 0) + 1;
    const code = diagnostic?.code === undefined ? "" : ` [${diagnostic.code}]`;

    return `${showPath(path, cwd)}:${line}:${column} ${severity}: ${oneLine(diagnostic?.message ?? "")}${code}`;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const diagnosticsTool = defineTool({
    name: "lsp_diagnostics",
    description:
        "The type errors and warnings of one file, from its language server. Run it after an edit.",
    parameters: Type.Object({
        path: Type.String({ description: "The file, relative to the session's folder" }),
        limit: Type.Optional(Type.Number({ description: "How many to show; 40 at most" })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
        const cwd = await cwdOf(api, context);
        const path = resolve(cwd, args.path);
        const { spec, root, server } = await primaryFor(path);
        const found = await server.diagnosticsFor(path);

        // Another server that already runs for this file adds what it knows, without being started.
        const extra: { label: string; list: any[] }[] = [];

        for (const other of specsForExtension(path)) {
            if (other.id === spec.id) {
                continue;
            }

            const running = liveServer(other, await rootFrom(dirname(path), other.roots));

            if (running !== undefined) {
                extra.push({ label: running.label, list: await running.diagnosticsFor(path, 4000) });
            }
        }

        const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 40);
        const listed = found.slice(0, limit);
        const lines = listed.map((diagnostic) => diagnosticLine(diagnostic, path, cwd));

        for (const group of extra) {
            lines.push(...group.list.slice(0, 5).map((diagnostic) => `${group.label}: ${diagnosticLine(diagnostic, path, cwd)}`));
        }

        const errors = found.filter((diagnostic) => diagnostic?.severity === 1).length + extra.reduce((count, group) => count + group.list.filter((d) => d?.severity === 1).length, 0);
        const total = found.length + extra.reduce((count, group) => count + group.list.length, 0);
        const rest = total > lines.length ? `\n(and ${total - lines.length} more)` : "";
        const where = root === dirname(path) ? "" : ` (${showPath(root, cwd)})`;

        return {
            output: [
                {
                    type: "text" as const,
                    text:
                        total === 0
                            ? `${showPath(path, cwd)}: no diagnostics from ${server.label}${where}.`
                            : `${showPath(path, cwd)}: ${errors} ${errors === 1 ? "error" : "errors"}, ${total} total from ${server.label}${where}.\n${lines.join("\n")}${rest}`,
                },
            ],
        };
    },
});

const definitionTool = defineTool({
    name: "lsp_definition",
    description: "Where a symbol at a line and column is declared, through the language server.",
    parameters: Type.Object({
        path: Type.String({ description: "The file, relative to the session's folder" }),
        line: Type.Number({ description: "Line, counting from 1" }),
        column: Type.Number({ description: "Column, counting from 1" }),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
        const cwd = await cwdOf(api, context);
        const path = resolve(cwd, args.path);
        const position = positionOf(args);
        const { server } = await primaryFor(path);

        await server.syncDoc(path);

        const found = await server.request("textDocument/definition", {
            textDocument: { uri: pathToFileURL(path).href },
            position,
        });
        const places = (Array.isArray(found) ? found : found === null ? [] : [found])
            .slice(0, MAX_LISTED)
            .map((place: any) => locationText(place, cwd))
            .filter((line: string | undefined): line is string => line !== undefined);

        return {
            output: [
                { type: "text" as const, text: places.length === 0 ? "No declaration found there." : places.join("\n") },
            ],
        };
    },
});

const referencesTool = defineTool({
    name: "lsp_references",
    description: "Every place a symbol is used, through the language server. Exact, where grep guesses.",
    parameters: Type.Object({
        path: Type.String({ description: "The file, relative to the session's folder" }),
        line: Type.Number({ description: "Line, counting from 1" }),
        column: Type.Number({ description: "Column, counting from 1" }),
        declaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself" })),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
        const cwd = await cwdOf(api, context);
        const path = resolve(cwd, args.path);
        const position = positionOf(args);
        const { server } = await primaryFor(path);

        await server.syncDoc(path);

        const found = await server.request("textDocument/references", {
            textDocument: { uri: pathToFileURL(path).href },
            position,
            context: { includeDeclaration: args.declaration === true },
        });
        const places = (Array.isArray(found) ? found : [])
            .slice(0, MAX_LISTED)
            .map((place: any) => locationText(place, cwd))
            .filter((line: string | undefined): line is string => line !== undefined);

        if (places.length === 0) {
            return { output: [{ type: "text" as const, text: "No references found there." }] };
        }

        const more = Array.isArray(found) && found.length > MAX_LISTED ? `\n(and ${found.length - MAX_LISTED} more)` : "";

        return { output: [{ type: "text" as const, text: `${places.join("\n")}${more}` }] };
    },
});

const hoverTool = defineTool({
    name: "lsp_hover",
    description: "The type and documentation of a symbol, through the language server.",
    parameters: Type.Object({
        path: Type.String({ description: "The file, relative to the session's folder" }),
        line: Type.Number({ description: "Line, counting from 1" }),
        column: Type.Number({ description: "Column, counting from 1" }),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
        const cwd = await cwdOf(api, context);
        const path = resolve(cwd, args.path);
        const position = positionOf(args);
        const { server } = await primaryFor(path);

        await server.syncDoc(path);

        const answer = await server.request("textDocument/hover", {
            textDocument: { uri: pathToFileURL(path).href },
            position,
        });
        const contents = answer?.contents;
        const parts: string[] = [];

        if (typeof contents === "string") {
            parts.push(contents);
        } else if (Array.isArray(contents)) {
            for (const part of contents) {
                parts.push(typeof part === "string" ? part : String(part?.value ?? ""));
            }
        } else if (typeof contents?.value === "string") {
            parts.push(contents.value);
        }

        const text = oneLine(parts.join("\n").replace(/```[a-z]*\n?/g, ""), 1500);

        return {
            output: [{ type: "text" as const, text: text === "" ? "Nothing known there." : text }],
        };
    },
});

const symbolsTool = defineTool({
    name: "lsp_symbols",
    description: "Find declarations in the project by name, through its language server.",
    parameters: Type.Object({
        query: Type.String({ description: "Part of a name, such as `parseConfig`" }),
        path: Type.Optional(Type.String({ description: "A file or folder of the project; default: the session's folder" })),
    }),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
        const cwd = await cwdOf(api, context);
        const anchor = typeof args.path === "string" && args.path !== "" ? resolve(cwd, args.path) : cwd;
        const { spec, root } = await primaryForAnchor(anchor, cwd);
        const server = await serverFor(spec, root);
        const found = await server.request("workspace/symbol", { query: args.query }).catch((error: Error) => {
            throw new Error(`${server.label} could not search ${showPath(root, cwd)}: ${error.message}`);
        });
        const list = (Array.isArray(found) ? found : []).slice(0, MAX_LISTED);
        const lines = list
            .map((symbol: any) => {
                const where = locationText({ uri: symbol.location?.uri, range: symbol.location?.range }, cwd);

                return where === undefined
                    ? undefined
                    : `${where} ${symbol.name}${symbol.containerName ? ` — ${symbol.containerName}` : ""}`;
            })
            .filter((line: string | undefined): line is string => line !== undefined);

        return {
            output: [
                {
                    type: "text" as const,
                    text: lines.length === 0 ? `No symbol matches "${args.query}".` : lines.join("\n"),
                },
            ],
        };
    },
});

// ─── After a read, and after an edit ────────────────────────────────────────

/** A file that Pi read: start its light server in the background, so the first edit is quick. */
async function warmOnRead(path: string): Promise<void> {
    if (setting<boolean>("startOnRead", true) !== true || !(extname(path).toLowerCase() in LANGUAGE_IDS)) {
        return;
    }

    const specs = specsForExtension(path).filter((spec) => spec.start === "read");

    if (specs.length === 0) {
        return;
    }

    for (const spec of specs.slice(0, 1)) {
        try {
            const root = await rootFrom(dirname(path), spec.roots);
            const server = await serverFor(spec, root);

            await server.syncDoc(path);
        } catch {
            // A server that will not start is the tool's business, not a read's.
        }
    }
}

/** The diagnostics of a file that Pi just changed, if a server can answer within the wait. */
async function diagnosticsAfterEdit(path: string, cwd: string): Promise<{ label: string; text: string } | undefined> {
    if (!(extname(path).toLowerCase() in LANGUAGE_IDS)) {
        return undefined;
    }

    const mode = setting<string>("afterEdit", "warm");
    const specs = specsForExtension(path);

    if (specs.length === 0) {
        return undefined;
    }

    const spec = specs[0];
    const root = await rootFrom(dirname(path), spec.roots);
    let server = liveServer(spec, root);

    if (server === undefined) {
        if (mode !== "always") {
            // Warm it for the next edit, without holding this one.
            void serverFor(spec, root)
                .then((started) => started.syncDoc(path))
                .catch(() => {});

            return undefined;
        }

        server = await Promise.race([
            serverFor(spec, root),
            sleep(EDIT_WAIT).then(() => undefined),
        ]).catch(() => undefined);

        if (server === undefined) {
            return undefined;
        }
    }

    const found = await Promise.race([
        server.diagnosticsFor(path, EDIT_WAIT, { quietMs: 350, earlyError: true }),
        sleep(EDIT_WAIT).then(() => [] as any[]),
    ]);
    const errors = found.filter((diagnostic) => diagnostic?.severity === 1).slice(0, 8);

    if (errors.length === 0) {
        return undefined;
    }

    return {
        label: server.label,
        text: errors.map((diagnostic) => diagnosticLine(diagnostic, path, cwd)).join("\n"),
    };
}

const afterFileTool = hook(ToolTask, {
    afterTool: async (call, result, api, context) => {
        try {
            const raw = (call.arguments as { path?: unknown })?.path;

            if (typeof raw !== "string") {
                return undefined;
            }

            const cwd = await cwdOf(api, context);
            const path = resolve(cwd, raw);

            if (call.name === "read") {
                void warmOnRead(path);

                return undefined;
            }

            if (call.name !== "edit" && call.name !== "write") {
                return undefined;
            }

            if (result.isError === true || result.output === undefined) {
                return undefined;
            }

            await sleep(100);

            const found = await diagnosticsAfterEdit(path, cwd);

            if (found === undefined) {
                return undefined;
            }

            return {
                ...result,
                output: [
                    ...result.output,
                    { type: "text" as const, text: `\nType errors now (${found.label}):\n${found.text}` },
                ],
            };
        } catch {
            return undefined;
        }
    },
});

const guidance = section(
    "language_servers",
    () =>
        [
            "Language servers answer for about thirty languages: type errors, and exact answers about symbols.",
            "`lsp_diagnostics` gives one file's type errors: run it after an edit before you say a change works.",
            "`lsp_definition`, `lsp_references`, `lsp_hover`, and `lsp_symbols` wait for `tool_search`; they answer about symbols exactly, where grep guesses.",
            "Paths are relative to the session's folder; line and column count from 1.",
        ].join("\n"),
);

function statusCard(): string {
    const lines: string[] = [];
    const specs = resolvedSpecs();

    lines.push(`${specs.length} of ${SERVERS.length} servers enabled, ${running.size} running (at most ${maxServers()}).`);

    for (const spec of specs) {
        const exits = [...running.values()].filter((server) => server.spec.id === spec.id);
        const state =
            exits.length > 0
                ? exits.map((server) => `${server.state} ${showPath(server.root, process.cwd())}`).join("; ")
                : candidateCache.has(spec.id)
                  ? candidateCache.get(spec.id) === undefined
                      ? `missing${spec.install?.note === undefined ? "" : `: ${spec.install.note}`}`
                      : "ready"
                  : "not started";

        lines.push(`${spec.id.padEnd(12)} ${state}${spec.start === "demand" ? " (on demand)" : ""}`);
    }

    if (running.size > 0) {
        lines.push("", "Type /lsp stop to stop every server.");
    }

    return lines.join("\n");
}

// ─── The module ─────────────────────────────────────────────────────────────

export const pocketApi = 2;

export default function createLsp(_host: unknown, web: Web) {
    hostWeb = web;

    if (typeof web.settings === "function") {
        web.settings([
            {
                name: "afterEdit",
                label: "Type errors after an edit",
                type: "choice",
                default: "warm",
                choices: [
                    { value: "warm", label: "Only when a server already runs" },
                    { value: "always", label: "Start a server and wait" },
                ],
                description: "OpenCode starts a server on the first edit; this module warms it when Pi reads the file.",
            },
            {
                name: "startOnRead",
                label: "Start a server when Pi reads a file",
                type: "boolean",
                default: true,
                description: "Light servers only: the first edit then has diagnostics with no wait.",
            },
            { name: "maxServers", label: "Servers at once", type: "number", default: 4, min: 1, max: 12 },
            {
                name: "idleMinutes",
                label: "Stop an idle server after (minutes)",
                type: "number",
                default: 10,
                min: 1,
                max: 240,
            },
            {
                name: "autoInstall",
                label: "Install a missing server with npm or uv",
                type: "boolean",
                default: false,
                description: "Only the packages this module names; nothing is downloaded from a release page.",
            },
            {
                name: "overrides",
                label: "Per-server settings (JSON)",
                type: "text",
                default: "{}",
                placeholder: '{ "gopls": { "disabled": true } }',
                description: "Keys are server ids: disabled, command, extensions, env, initialization.",
            },
        ]);
    }

    const sweeper = setInterval(() => {
        const now = Date.now();
        const limit = idleMs();

        for (const [key, server] of running) {
            if (now - server.lastUsed > limit) {
                server.kill();
                running.delete(key);
            }
        }
    }, 60_000);

    sweeper.unref?.();

    const stopSettings = typeof web.onSettings === "function" ? web.onSettings(() => candidateCache.clear()) : undefined;

    web.onDispose(() => {
        clearInterval(sweeper);
        stopSettings?.();
        stopAll();
    });

    web.command("lsp-servers", {
        description: "Show or stop the language servers",
        args: "[stop]",
        scope: "conversation",
        handler: (args) => {
            if (args.trim() === "stop") {
                const count = stopAll();

                return { type: "toast", level: "info", message: `Stopped ${count} language ${count === 1 ? "server" : "servers"}.` };
            }

            return { type: "card", output: statusCard() };
        },
    });

    return defineExtension({
        name: "lsp",
        tools: [diagnosticsTool, definitionTool, referencesTool, hoverTool, symbolsTool],
        sections: [guidance],
        hooks: [afterFileTool],
    });
}

/** For the tests beside this module: the parts that do not need Pi Pocket. */
/**
 * The tests use these; Pi Pocket does not. `resolveCandidate` and `installSpec` are here so a test
 * can prove that an install changes which command a server uses.
 */
export const internals = {
    SERVERS,
    LANGUAGE_IDS,
    specsForExtension,
    rootFrom,
    resolvedSpecs,
    resolveCandidate,
    installSpec,
    isDisabled,
    overrides,
};
