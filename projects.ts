/**
 * Projects: Claude-style projects for Pi Pocket. A project has a name, folders, and instructions. A session can work
 * in more than one folder. New starts a session at once.
 *
 * - The folder chip under the message box shows the session's project or folder. A tap opens the picker: choose a
 *   project, move the session to another folder, or add extra folders to it.
 * - A project's first folder is where its sessions start. Pi gets the project's instructions and every folder of the
 *   session in a prompt section (`project`). Pi Pocket loads `AGENTS.md` only from the working folder, so the section
 *   tells Pi to read the others' `AGENTS.md` itself.
 * - The session list shows each session's project as a chip, can filter by project, and finds sessions by project name.
 * - New starts a session at once in the default folder, or in the project that the list's filter shows.
 *   Shift+click New, Alt+N, or the launcher still open the app's own folder picker. New clicks are caught on the app's
 *   own `.new-button`, which is not a public extension point: if an update changes it, New opens the picker again.
 * - State is kept in `projects/state.json` beside this file. It replaces the Quick New extension.
 */
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 1;

const HOME = homedir();
const HERE = dirname(import.meta.filename);
const STATE = join(HERE, "projects", "state.json");
const OLD_QUICK_NEW = join(HERE, "quick-new", "state.json");
const MAX_DIRS = 500;
const MAX_INSTRUCTIONS = 20_000;
const MAX_FOLDERS = 20;
/** Where chats with no project work: a new empty folder for each. */
const SCRATCH = join(HOME, ".pi-scratch");
/** The system's temporary folders: open to every chat. */
const TEMP = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"])];

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
const isScratch = (cwd: string) => inside(cwd, SCRATCH) && cwd !== SCRATCH;

interface Project {
    id: string;
    name: string;
    folders: string[];
    instructions: string;
    pinned: boolean;
    createdAt: number;
    updatedAt: number;
}

interface SessionLink {
    project?: string;
    extra?: string[];
    /** A project's folders that this session leaves out. */
    hidden?: string[];
}

interface State {
    /** What New starts: a chat with no project (a new temporary folder), or a session in `defaultFolder`. */
    newIn: "scratch" | "folder";
    defaultFolder: string;
    projects: Project[];
    sessions: Record<string, SessionLink>;
}

function expand(raw: unknown): string {
    const text = String(raw ?? "").trim() || "~";
    if (text === "~") return HOME;
    if (text.startsWith("~/")) return join(HOME, text.slice(2));
    return resolve(HOME, text);
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** "/Users/ode/x" → "~/x", for display. */
function pretty(path: string): string {
    return path === HOME ? "~" : path.startsWith(`${HOME}/`) ? `~/${path.slice(HOME.length + 1)}` : path;
}

function load(): State {
    try {
        const s = JSON.parse(readFileSync(STATE, "utf8"));
        return {
            newIn: s.newIn === "folder" ? "folder" : "scratch",
            defaultFolder: typeof s.defaultFolder === "string" ? s.defaultFolder : HOME,
            projects: Array.isArray(s.projects) ? s.projects : [],
            sessions: s.sessions && typeof s.sessions === "object" ? s.sessions : {},
        };
    } catch {
        let defaultFolder = HOME;
        try {
            defaultFolder = JSON.parse(readFileSync(OLD_QUICK_NEW, "utf8")).folder ?? HOME;
        } catch {}
        return { newIn: "scratch", defaultFolder, projects: [], sessions: {} };
    }
}

let state = load();

function save() {
    mkdirSync(dirname(STATE), { recursive: true });
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, STATE);
}

const projectOf = (id: string | undefined) => (id ? state.projects.find((p) => p.id === id) : undefined);

/** A session's folders: its working folder first, then the project's and its own extra folders. */
function foldersOf(sessionId: number, cwd: string): { project?: Project; folders: string[] } {
    const link = state.sessions[String(sessionId)] ?? {};
    const project = projectOf(link.project);
    const hidden = link.hidden ?? [];
    const all = [cwd, ...(project?.folders ?? []).filter((f) => !hidden.includes(f)), ...(link.extra ?? [])];
    return { project, folders: [...new Set(all.filter(Boolean))] };
}

function cleanFolders(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const f of raw.slice(0, MAX_FOLDERS)) {
        const path = expand(f);
        if (!isDir(path)) throw new Error(`${path} is not a folder.`);
        if (!out.includes(path)) out.push(path);
    }
    return out;
}

/** Each session's working folder, as the last request saw it: the tool hook has no other way to know it. */
const cwds = new Map<number, string>();

/** A chat with no project, no extra folders, and a temporary folder: Pi stays in its folder. */
function locked(id: number, cwd: string | undefined): boolean {
    if (!cwd || !isScratch(cwd)) return false;
    const link = state.sessions[String(id)];
    return !projectOf(link?.project) && !(link?.extra?.length);
}

function newScratch(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    let path = join(SCRATCH, stamp);
    for (let i = 2; existsSync(path); i++) path = join(SCRATCH, `${stamp}-${i}`);
    mkdirSync(path, { recursive: true });
    return path;
}

const projectSection = section("project", (input) => {
    const cwd = input.env?.cwd;
    if (!cwd) return undefined;
    cwds.set(Number(input.conversationId), cwd);
    if (locked(Number(input.conversationId), cwd)) {
        return [
            `This chat has no project. It works only in its own temporary folder, ${cwd}, and in the system's temporary folders.`,
            "Do not read, list, or change files anywhere else on this computer: such tool calls are blocked.",
            "Files that the person attaches, and skills, can still be read.",
            "When the person wants you to work in a project or folder, tell them to choose one with the folder chip under the message box.",
        ].join("\n");
    }
    const { project, folders } = foldersOf(Number(input.conversationId), cwd);
    if (!project && folders.length < 2) return undefined;

    const lines: string[] = [];
    if (project) lines.push(`This session is in the project "${project.name}".`);
    if (folders.length > 1) {
        lines.push(
            "This session works in more than one folder. The first is the working directory. Use absolute paths for files in the others:",
            ...folders.map((f, i) => `- ${f}${i === 0 ? " (working directory)" : ""}`),
            "Pi Pocket loads AGENTS.md only from the working directory. Before you work in another folder, read its AGENTS.md if it has one.",
        );
    }
    if (project?.instructions.trim()) {
        lines.push("", "The project's instructions:", project.instructions.trim());
    }
    return lines.join("\n");
});

/** Absolute paths, `~` paths, and `..` in a shell command: the parts that can reach outside the folder. */
function pathsIn(command: string, cwd: string): string[] {
    const out: string[] = [];
    for (const m of command.matchAll(/(?:^|[\s'"=:(<>|;&])((?:~|\$HOME|\$\{HOME\}|\/|\.\.)[^\s'";|&()<>]*)/g)) {
        let t = m[1];
        if (t.startsWith("~")) t = HOME + t.slice(1);
        else if (t.startsWith("${HOME}")) t = HOME + t.slice(7);
        else if (t.startsWith("$HOME")) t = HOME + t.slice(5);
        out.push(isAbsolute(t) ? resolve(t) : resolve(cwd, t));
    }
    return out;
}

/** System folders that commands use (programs, devices): reading them reveals nothing of the person's. */
const SYSTEM = ["/bin", "/sbin", "/usr", "/opt", "/dev", "/etc", "/System", "/Library", "/Applications", "/private/etc", "/nix"];

export default function createProjects(host: Host, web: Web) {
    const readRoots = () => [
        ...TEMP,
        join(host.dataDir, "uploads"),
        host.agentDir,
        join(HOME, ".pi", "skills"),
        join(HOME, ".agents", "skills"),
        ...(host.skillPaths?.() ?? []),
        // Pi Pocket's own folder: its docs.
        ...((process.argv[1] ?? "").match(/^(.*\/pi-pocket)\//)?.slice(1, 2) ?? []),
    ];

    const guard = hook(ToolTask, {
        beforeTool: (call, api) => {
            const id = Number(api.conversationId);
            const cwd = cwds.get(id);
            if (!locked(id, cwd)) return undefined;
            const args = (call.arguments ?? {}) as Record<string, unknown>;
            const why = (p: string) => ({
                block: `This chat has no project, so it works only in ${cwd} and temporary folders: ${p} is outside. Ask the person to choose a project or folder with the folder chip under the message box.`,
            });
            const writes = call.name === "write" || call.name === "edit";
            if (typeof args.path === "string" && ["read", "write", "edit", "ls", "grep", "find"].includes(call.name)) {
                const p = resolve(cwd!, args.path.replace(/^~(?=\/|$)/, HOME));
                const ok = inside(p, cwd!) || TEMP.some((r) => inside(p, r)) || (!writes && readRoots().some((r) => inside(p, r)));
                return ok ? undefined : why(p);
            }
            if (call.name === "bash" && typeof args.command === "string") {
                for (const p of pathsIn(args.command, cwd!)) {
                    const ok =
                        inside(p, cwd!) || TEMP.some((r) => inside(p, r)) || SYSTEM.some((r) => inside(p, r)) || readRoots().some((r) => inside(p, r)) || p === "/";
                    if (!ok) return why(p);
                }
            }
            return undefined;
        },
    });
    const changed = () => web.send("changed", { at: Date.now() });
    const fail = (e: unknown) => web.error(400, (e as Error).message);

    /** All the browser needs: projects, the session links, the default folder, and one session's folders. */
    web.route("GET", "state", ({ query, sessions }) => {
        const out: Record<string, unknown> = {
            home: HOME,
            newIn: state.newIn,
            scratchRoot: SCRATCH,
            defaultFolder: state.defaultFolder,
            defaultPretty: pretty(state.defaultFolder),
            defaultOk: isDir(state.defaultFolder),
            projects: state.projects.map((p) => {
                const mine = (sessions?.() ?? []).filter(
                    (s: { id: number; archived: boolean }) => !s.archived && state.sessions[String(s.id)]?.project === p.id,
                );
                return {
                    ...p,
                    pretty: p.folders.map(pretty),
                    count: mine.length,
                    last: Math.max(0, ...mine.map((s: { updatedAt: number }) => s.updatedAt)),
                    chats: mine
                        .sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt)
                        .slice(0, 50)
                        .map((s: { id: number; title?: string | null; updatedAt: number }) => ({
                            id: s.id,
                            title: s.title || "New session",
                            updatedAt: s.updatedAt,
                        })),
                };
            }),
            links: Object.fromEntries(
                Object.entries(state.sessions)
                    .filter(([, l]) => l.project && projectOf(l.project))
                    .map(([id, l]) => [id, l.project]),
            ),
        };
        const id = Number(query.get("session"));
        if (query.get("session")) {
            const session = sessions?.().find((s: { id: number }) => s.id === id);
            if (session) {
                const { project, folders } = foldersOf(id, session.cwd);
                const link = state.sessions[String(id)] ?? {};
                const extra = link.extra ?? [];
                const hiddenProject = project?.folders.filter((f) => (link.hidden ?? []).includes(f)) ?? [];
                out.session = {
                    id,
                    cwd: session.cwd,
                    scratch: isScratch(session.cwd),
                    locked: locked(id, session.cwd),
                    ok: isDir(session.cwd),
                    project: project?.id ?? null,
                    hiddenProject,
                    folders: folders.map((f) => ({
                        path: f,
                        pretty: pretty(f),
                        ok: isDir(f),
                        main: f === session.cwd,
                        own: extra.includes(f),
                        fromProject: !!project?.folders.includes(f) && f !== session.cwd,
                        projectFolder: !!project?.folders.includes(f),
                    })),
                };
            }
        }
        return out;
    });

    web.route("POST", "default-folder", ({ body }) => {
        const path = expand((body as { path?: unknown })?.path);
        if (!isDir(path)) throw web.error(400, `${path} is not a folder.`);
        state.defaultFolder = path;
        state.newIn = "folder";
        save();
        changed();
        return { path, pretty: pretty(path) };
    });

    /** New starts a chat with no project, in a new temporary folder. */
    web.route("POST", "new-in-scratch", () => {
        state.newIn = "scratch";
        save();
        changed();
        return { ok: true };
    });

    /** A new temporary folder for a chat with no project. */
    web.route("POST", "scratch", () => ({ path: newScratch() }));

    /** Create or change a project. */
    web.route("POST", "project", ({ body }) => {
        const b = (body ?? {}) as Partial<Project>;
        const name = String(b.name ?? "").trim().slice(0, 80);
        if (!name) throw web.error(400, "A project needs a name.");
        let folders: string[];
        try {
            folders = cleanFolders(b.folders);
        } catch (e) {
            throw fail(e);
        }
        const instructions = String(b.instructions ?? "").slice(0, MAX_INSTRUCTIONS);
        const now = Date.now();
        let project = projectOf(b.id);
        if (project) {
            Object.assign(project, { name, folders, instructions, pinned: !!b.pinned, updatedAt: now });
        } else {
            project = { id: randomUUID().slice(0, 8), name, folders, instructions, pinned: !!b.pinned, createdAt: now, updatedAt: now };
            state.projects.push(project);
        }
        save();
        changed();
        return project;
    });

    web.route("POST", "project-pin", ({ body }) => {
        const project = projectOf((body as { id?: string })?.id);
        if (!project) throw web.error(404, "No such project.");
        project.pinned = !project.pinned;
        save();
        changed();
        return project;
    });

    web.route("POST", "project-delete", ({ body }) => {
        const id = (body as { id?: string })?.id;
        if (!projectOf(id)) throw web.error(404, "No such project.");
        state.projects = state.projects.filter((p) => p.id !== id);
        for (const link of Object.values(state.sessions)) if (link.project === id) delete link.project;
        save();
        changed();
        return { ok: true };
    });

    /**
     * Link sessions to a project (or none), or change one session's extra folders. Moving the working folder is the
     * app's own call (`configure`), made by the browser, so the server checks who may steer.
     */
    web.route("POST", "session", ({ body, sessions }) => {
        const b = (body ?? {}) as { ids?: unknown; project?: string | null; extra?: unknown; hidden?: unknown };
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number);
        const visible = new Set((sessions?.() ?? []).map((s: { id: number }) => s.id));
        if (ids.length === 0 || ids.some((id) => !visible.has(id))) throw web.error(404, "No such session.");
        if (b.project && !projectOf(b.project)) throw web.error(404, "No such project.");
        let extra: string[] | undefined;
        if (b.extra !== undefined) {
            try {
                extra = cleanFolders(b.extra);
            } catch (e) {
                throw fail(e);
            }
        }
        const hidden = Array.isArray(b.hidden) ? b.hidden.map((f) => expand(f)).slice(0, MAX_FOLDERS) : undefined;
        for (const id of ids) {
            const link = (state.sessions[String(id)] ??= {});
            if (b.project !== undefined) {
                if (b.project) link.project = b.project;
                else delete link.project;
            }
            if (extra !== undefined) link.extra = extra;
            if (hidden !== undefined) {
                if (hidden.length) link.hidden = hidden;
                else delete link.hidden;
            }
            if (!link.project && !link.extra?.length && !link.hidden?.length) delete state.sessions[String(id)];
        }
        save();
        changed();
        return { ok: true };
    });

    /**
     * An empty session in this folder to reuse instead of making another: the current one when it is empty, else the
     * newest empty one. A session gets its title from its first message, so no title means never used.
     */
    web.route("GET", "reuse", ({ query, sessions }) => {
        const scratch = query.get("scratch") === "1";
        const folder = expand(query.get("folder") ?? state.defaultFolder);
        const project = query.get("project") || undefined;
        const current = Number(query.get("current"));
        const empty = (sessions?.() ?? []).filter(
            (s: { id: number; title?: string | null; cwd: string; archived: boolean }) =>
                !s.archived &&
                (!s.title || s.title === "New session") &&
                (scratch ? isScratch(s.cwd) && !state.sessions[String(s.id)]?.extra?.length : s.cwd === folder) &&
                (state.sessions[String(s.id)]?.project ?? undefined) === project,
        );
        const pick =
            empty.find((s: { id: number }) => s.id === current) ??
            empty.sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt)[0];
        return { id: pick?.id ?? null, isCurrent: pick?.id === current };
    });

    /** One folder's subfolders, and places to jump to. */
    web.route("GET", "browse", ({ query, sessions }) => {
        let path = expand(query.get("path") ?? state.defaultFolder);
        if (!isDir(path)) path = HOME;
        const hidden = query.get("hidden") === "1";

        let dirs: string[] = [];
        let error: string | undefined;
        try {
            dirs = readdirSync(path, { withFileTypes: true })
                .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && isDir(join(path, d.name)))) && (hidden || !d.name.startsWith(".")))
                .map((d) => d.name)
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
                .slice(0, MAX_DIRS);
        } catch (e) {
            error = `Cannot open this folder: ${(e as Error).message.split(":")[0]}`;
        }

        const places: Array<{ label: string; path: string }> = [{ label: "Home", path: HOME }];
        try {
            for (const v of readdirSync("/Volumes")) {
                const p = join("/Volumes", v);
                if (isDir(p) && v !== "Macintosh HD") places.push({ label: v, path: p });
            }
        } catch {}

        return {
            path,
            pretty: pretty(path),
            parent: path === "/" ? null : dirname(path),
            dirs,
            error,
            places,
            recent: recentFolders(sessions?.() ?? []),
        };
    });

    /** Recent session folders, for the picker. */
    web.route("GET", "recent", ({ sessions }) => ({ recent: recentFolders(sessions?.() ?? []) }));

    web.client("projects.js");

    return defineExtension({ name: "projects", sections: [projectSection], hooks: [guard] });
}

function recentFolders(list: Array<{ cwd: string; archived: boolean; updatedAt: number }>) {
    const recent = new Set<string>();
    for (const s of list.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (recent.size >= 8) break;
        if (s.cwd && !recent.has(s.cwd) && existsSync(s.cwd) && isDir(s.cwd)) recent.add(s.cwd);
    }
    return [...recent].map((p) => ({ label: pretty(p), path: p }));
}
