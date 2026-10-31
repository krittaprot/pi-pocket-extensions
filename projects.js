// Projects, the browser part: the folder chip and its picker, projects and their editor, the session list's project
// chips and filter, and a New that starts a session at once.
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useState, useEffect, useMemo } = pocket;

    // ---------- Shared state ----------

    let data = { projects: [], links: {}, defaultFolder: "", home: "" };
    // The list's project filter, kept for this browser: a reload on a phone shows the same scope.
    const FILTER_KEY = "pj.filter";
    let filterProject = localStorage.getItem(FILTER_KEY) || null;
    let loaded = false;
    const listeners = new Set();
    let seq = 0;

    async function reload() {
        const id = pocket.conversationId?.();
        const mine = ++seq;
        try {
            const next = await pocket.api(`state${id != null ? `?session=${id}` : ""}`);
            if (mine !== seq) return;
            data = next;
            loaded = true;
        } catch {
            return;
        }
        for (const l of listeners) l(data);
        drawChip();
        drawList();
        drawBlock();
    }

    function useData() {
        const [d, setD] = useState(data);
        useEffect(() => {
            listeners.add(setD);
            return () => listeners.delete(setD);
        }, []);
        return d;
    }

    const projectById = (id) => data.projects.find((p) => p.id === id);
    const nameOf = (path) => (path === data.home ? "Home" : path.split("/").filter(Boolean).pop() || "/");
    const sortProjects = (list) =>
        [...list].sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // ---------- Actions ----------

    async function configureCwd(sessionId, cwd) {
        const response = await fetch(`/api/c/${sessionId}/configure`, {
            method: "POST",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ cwd }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `the server answered ${response.status}`);
    }

    async function createSession(cwd) {
        const response = await fetch("/api/sessions", {
            method: "POST",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ cwd }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.id === undefined) throw new Error(body.error || `the server answered ${response.status}`);
        return body.id;
    }

    /** Put sessions in a project (or none). A session outside the project's folders moves to its first folder. */
    async function assign(ids, projectId, cwdOf) {
        const project = projectById(projectId);
        if (project?.folders.length) {
            for (const id of ids) {
                const cwd = cwdOf?.(id);
                if (!cwd || !project.folders.includes(cwd)) await configureCwd(id, project.folders[0]);
            }
        }
        await pocket.api("session", { ids, project: projectId ?? null });
        await reload();
    }

    /** Leave one folder out of this session: an extra one goes, a project's one is hidden here, the main one moves away. */
    async function removeFolder(session, folder) {
        const left = session.folders.filter((f) => f.path !== folder.path);
        if (!left.length) {
            const { path } = await pocket.api("scratch", {});
            await configureCwd(session.id, path);
            await pocket.api("session", { ids: [session.id], extra: [] });
            pocket.notify?.("info", "This session now works only in a temporary folder.");
            return reload();
        }
        if (folder.own) {
            await setExtra(session.id, session.folders.filter((x) => x.own && x.path !== folder.path).map((x) => x.path));
            pocket.notify?.("info", `Left ${folder.pretty} out of this session`);
            return;
        }
        if (folder.main) {
            await configureCwd(session.id, left[0].path);
            pocket.notify?.("info", `Pi now works in ${left[0].pretty}`);
        }
        if (folder.projectFolder) {
            const hidden = [...(session.hiddenProject ?? []), folder.path];
            await pocket.api("session", { ids: [session.id], hidden });
            pocket.notify?.("info", `Left ${folder.pretty} out of this session`);
        }
        await reload();
    }

    async function setExtra(sessionId, extra) {
        await pocket.api("session", { ids: [sessionId], extra });
        await reload();
    }

    /** Don't work in a project: a new temporary folder, and the project's folders left behind. */
    async function leaveProject(sessionId) {
        const id = sessionId ?? pocket.conversationId?.();
        if (id == null) return;
        const { path } = await pocket.api("scratch", {});
        await configureCwd(id, path);
        await pocket.api("session", { ids: [id], project: null, extra: [], hidden: [] });
        await reload();
    }

    /** A new session in a project's first folder, or a chat with no project (a new temporary folder), or the default folder. */
    async function startIn(projectId) {
        const project = projectById(projectId);
        const scratch = !project && data.newIn !== "folder";
        const folder = project?.folders[0] ?? data.defaultFolder;
        const current = pocket.conversationId?.();
        const q = new URLSearchParams({ folder, current: current ?? "", project: projectId ?? "", scratch: scratch ? "1" : "" });
        const reuse = await pocket.api(`reuse?${q}`).catch(() => ({ id: null }));
        if (reuse.id != null) {
            if (!reuse.isCurrent) {
                pocket.openConversation(reuse.id);
                await waitFor(() => pocket.conversationId?.() === reuse.id);
            }
            const page = await pocket.messages?.({ limit: 1 }).catch(() => null);
            if (!page || page.conversationId !== reuse.id || (page.messages ?? []).length === 0) {
                focusComposer();
                return;
            }
        }
        const id = await createSession(scratch ? (await pocket.api("scratch", {})).path : folder);
        if (projectId) await pocket.api("session", { ids: [id], project: projectId });
        pocket.openConversation(id);
        setTimeout(reload, 300);
    }

    async function waitFor(test, ms = 2000) {
        const end = Date.now() + ms;
        while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    }

    function focusComposer() {
        setTimeout(() => document.querySelector('[data-part="composer"] textarea, textarea')?.focus(), 50);
    }

    const run = (fn) => async (...args) => {
        try {
            await fn(...args);
        } catch (e) {
            pocket.notify?.("error", e.message);
        }
    };

    // ---------- Pieces of UI ----------

    const css = html`<style>
        .pj-row{display:flex;gap:8px;align-items:center;width:100%;padding:8px 10px;border:0;border-bottom:1px solid var(--line);background:none;color:var(--text);text-align:left;cursor:pointer;font:inherit}
        .pj-row:last-child{border-bottom:0}
        .pj-row:hover{background:var(--card)}
        .pj-row.on{background:var(--card);font-weight:600}
        .pj-list{border:1px solid var(--line);border-radius:10px;overflow:auto}
        .pj-head{font-size:12px;color:var(--muted, #888);margin:4px 0 6px}
        .pj-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .pj-sub{font-size:12px;opacity:.65}
        .pj-p-count{flex:none;font:11px var(--mono);color:var(--muted)}
        .pj-link{background:none;border:0;padding:2px 6px;color:var(--accent);cursor:pointer;font:inherit;font-size:12px}
        .pj-input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
    </style>`;

    /** A folder browser: places, recent folders, a path box, and the subfolders. `onPick` gets the chosen path. */
    function FolderBrowser({ start, onPick, pickLabel = "Use", onCancel }) {
        const [view, setView] = useState(null);
        const [error, setError] = useState(null);
        const [hidden, setHidden] = useState(false);
        const [typed, setTyped] = useState(null);
        const [busy, setBusy] = useState(false);

        const go = (path) => {
            setError(null);
            const q = new URLSearchParams();
            if (path) q.set("path", path);
            if (hidden) q.set("hidden", "1");
            pocket.api(`browse?${q}`).then(
                (v) => {
                    setView(v);
                    setTyped(null);
                },
                (e) => setError(e.message),
            );
        };
        useEffect(() => go(view?.path ?? start), [hidden]);

        if (!view) return error ? html`<div class="error-box">${error}</div>` : html`<${pocket.Loader} label="Loading folders" />`;

        const crumbs = [{ label: "/", path: "/" }];
        let acc = "";
        for (const part of view.path.split("/").filter(Boolean)) {
            acc += `/${part}`;
            crumbs.push({ label: part, path: acc });
        }
        const chip = (p) => html`<button class=${`button small ${view.path === p.path ? "primary" : ""}`} style="margin:0 6px 6px 0" onClick=${() => go(p.path)} title=${p.path}>${p.label}</button>`;

        return html`<div style="display:flex;flex-direction:column;gap:10px;min-height:0">
            <div>
                <div class="pj-head">Places</div>
                <div>${view.places.map(chip)}</div>
                ${view.recent.length > 0 && html`<div class="pj-head">Recent session folders</div><div>${view.recent.map(chip)}</div>`}
            </div>
            <div class="mono small" style="display:flex;flex-wrap:wrap;gap:2px;align-items:center">
                ${crumbs.map(
                    (c, i) => html`${i > 1 ? html`<span class="muted">/</span>` : ""}<a href="#" style="color:var(--accent);text-decoration:none;padding:2px 3px" onClick=${(e) => {
                        e.preventDefault();
                        go(c.path);
                    }}>${c.label}</a>`,
                )}
            </div>
            <form style="display:flex;gap:6px" onSubmit=${(e) => {
                e.preventDefault();
                if (typed) go(typed);
            }}>
                <input class="mono pj-input" style="flex:1;min-width:0" placeholder="Type a path, e.g. /Volumes/ProVault/projects" value=${typed ?? view.path} onInput=${(e) => setTyped(e.currentTarget.value)} />
                <button class="button small" type="submit">Go</button>
            </form>
            ${error && html`<div class="error-box">${error}</div>`}
            ${view.error && html`<div class="error-box">${view.error}</div>`}
            <div class="pj-list" style="max-height:38vh">
                ${view.parent && html`<button class="pj-row" onClick=${() => go(view.parent)}><${pocket.Icon} name="folder" size=${14} /> <span class="muted">..</span></button>`}
                ${view.dirs.length === 0 && !view.error && html`<div class="small muted" style="padding:10px">No subfolders.</div>`}
                ${view.dirs.map(
                    (d) => html`<button class="pj-row" onClick=${() => go(`${view.path === "/" ? "" : view.path}/${d}`)}><${pocket.Icon} name="folder" size=${14} /> <span>${d}</span></button>`,
                )}
            </div>
            <label class="small" style="display:inline-flex;gap:6px;align-items:center;align-self:flex-start;width:auto;cursor:pointer">
                <input type="checkbox" style="width:auto;margin:0" checked=${hidden} onChange=${(e) => setHidden(e.currentTarget.checked)} />
                <span>Show hidden folders</span>
            </label>
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
                ${onCancel && html`<button class="button" onClick=${onCancel}>Cancel</button>`}
                <button class="button primary" disabled=${busy} onClick=${async () => {
                    setBusy(true);
                    try {
                        await onPick(view.path, view.pretty);
                    } catch (e) {
                        setError(e.message);
                    } finally {
                        setBusy(false);
                    }
                }}>${pickLabel} ${view.pretty}</button>
            </div>
            ${css}
        </div>`;
    }

    // ---------- Sheet: Project or folder (the chip's picker) ----------

    function Picker({ close, manage }) {
        const d = useData();
        const [search, setSearch] = useState("");
        const [adding, setAdding] = useState(null); // null | "move" | "add"
        const session = manage ? null : d.session;

        useEffect(() => {
            reload();
        }, []);

        const projects = useMemo(() => {
            const q = search.trim().toLowerCase();
            return sortProjects(d.projects).filter((p) => !q || p.name.toLowerCase().includes(q) || p.folders.some((f) => f.toLowerCase().includes(q)));
        }, [d, search]);
        const exact = d.projects.some((p) => p.name.toLowerCase() === search.trim().toLowerCase());

        if (adding && session) {
            return html`<div>
                <div class="pj-head" style="margin-bottom:10px">${adding === "move" ? "Move this session to a folder. Pi works there from the next message." : "Add a folder that Pi can also work in."}</div>
                <${FolderBrowser}
                    start=${session.cwd}
                    pickLabel=${adding === "move" ? "Work in" : "Add"}
                    onCancel=${() => setAdding(null)}
                    onPick=${async (path, pretty) => {
                        if (adding === "move") {
                            await configureCwd(session.id, path);
                            pocket.notify?.("info", `Pi now works in ${pretty}`);
                            await reload();
                        } else {
                            const own = session.folders.filter((f) => f.own).map((f) => f.path);
                            if (!session.folders.some((f) => f.path === path)) await setExtra(session.id, [...own, path]);
                            pocket.notify?.("info", `Added ${pretty}`);
                        }
                        setAdding(null);
                    }}
                />
            </div>`;
        }

        const current = session?.project ?? null;
        const noProject = run(async () => {
            if (!session) return close();
            if (session.locked) {
                pocket.notify?.("info", "This chat already works only in a temporary folder.");
                return close();
            }
            await leaveProject(session.id);
            pocket.notify?.("info", "This chat now has no project. Pi works only in a temporary folder.");
            close();
        });
        const pick = run(async (p) => {
            if (session) {
                await assign([session.id], p.id, () => session.cwd);
                pocket.notify?.("info", `This session is now in ${p.name}`);
                close();
            } else {
                pocket.openSheet("editor", { id: p.id });
            }
        });

        return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
            ${session &&
            html`<div>
                <div class="pj-head">This session works in</div>
                <div class="pj-list">
                    ${session.folders.map(
                        (f) => html`<div class="pj-row" style="cursor:default">
                            <${pocket.Icon} name="folder" size=${14} />
                            <span class="pj-grow mono small" title=${f.path}>${session.scratch && f.main ? "Temporary folder" : f.pretty}</span>
                            ${f.main
                                ? html`<span class="pj-sub" title=${f.path}>${session.locked ? "only this folder" : "working folder"}</span>`
                                : html`<button class="pj-link" title="Pi starts its commands here" onClick=${run(async () => {
                                      await configureCwd(session.id, f.path);
                                      await reload();
                                  })}>Make main</button>`}
                            ${f.fromProject && !f.own && html`<span class="pj-sub">project</span>`}
                            <button class="pj-link" title=${f.main ? "Move this session to another folder, or to a temporary one" : "Leave this folder out of this session"} onClick=${run(() => removeFolder(session, f))}>Remove</button>
                        </div>`,
                    )}
                </div>
                ${(session.hiddenProject ?? []).length > 0 &&
                html`<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center">
                    <span class="pj-sub">Left out of this session:</span>
                    ${session.hiddenProject.map(
                        (p) => html`<button class="pj-link" title=${p} onClick=${run(async () => {
                            await pocket.api("session", { ids: [session.id], hidden: (session.hiddenProject ?? []).filter((x) => x !== p) });
                            await reload();
                        })}>${nameOf(p)} +</button>`,
                    )}
                </div>`}
                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                    <button class="button small" onClick=${() => setAdding("move")}>Change folder</button>
                    <button class="button small" onClick=${() => setAdding("add")}>Add folder</button>
                    ${current && html`<button class="button small" onClick=${run(() => assign([session.id], null))}>Leave project</button>`}
                </div>
            </div>`}

            <div>
                <div class="pj-head">${session ? "Project" : "Projects"}</div>
                <input class="pj-input" placeholder="Search or create a project" value=${search} onInput=${(e) => setSearch(e.currentTarget.value)} />
            </div>
            <div class="pj-list" style="max-height:40vh">
                ${session &&
                !search.trim() &&
                html`<div class=${`pj-row ${session.locked ? "on" : ""}`} onClick=${noProject}>
                    <span style="width:14px"></span>
                    <span class="pj-grow">No project<div class="pj-sub">Pi works only in a new temporary folder</div></span>
                </div>`}
                ${projects.length === 0 && html`<div class="small muted" style="padding:10px">${d.projects.length ? "No project matches." : "No projects yet."}</div>`}
                ${projects.map(
                    (p) => html`<div class=${`pj-row ${p.id === current ? "on" : ""}`} onClick=${() => pick(p)}>
                        <${pocket.Icon} name="folder" size=${14} />
                        <span class="pj-grow">
                            ${p.name}${p.pinned ? html` <span class="pj-sub">· pinned</span>` : ""}
                            <div class="pj-sub mono pj-grow">${p.pretty[0] ?? "no folder"}${p.folders.length > 1 ? ` +${p.folders.length - 1}` : ""}</div>
                        </span>
                        ${!session && html`<button class="pj-link" onClick=${(e) => {
                            e.stopPropagation();
                            close();
                            run(startIn)(p.id);
                        }}>New session</button>`}
                        <button class="pj-link" onClick=${(e) => {
                            e.stopPropagation();
                            run(() => pocket.api("project-pin", { id: p.id }))();
                        }}>${p.pinned ? "Unpin" : "Pin"}</button>
                        <button class="pj-link" onClick=${(e) => {
                            e.stopPropagation();
                            pocket.openSheet("editor", { id: p.id });
                        }}>Edit</button>
                    </div>`,
                )}
                <button class="pj-row" onClick=${() => pocket.openSheet("editor", { name: exact ? "" : search.trim(), forSession: session?.id ?? null, folder: session?.cwd ?? null })}>
                    <span style="width:14px;text-align:center">+</span>
                    <span>${search.trim() && !exact ? `Create project "${search.trim()}"` : "New project"}</span>
                </button>
            </div>
            ${css}
        </div>`;
    }

    // ---------- Sheet: a project's editor ----------

    function Editor({ close, id, name: startName, forSession, folder }) {
        const d = useData();
        const existing = d.projects.find((p) => p.id === id);
        const [name, setName] = useState(existing?.name ?? startName ?? "");
        const [folders, setFolders] = useState(existing?.folders ?? (folder ? [folder] : []));
        const [instructions, setInstructions] = useState(existing?.instructions ?? "");
        const [pinned, setPinned] = useState(existing?.pinned ?? false);
        const [browsing, setBrowsing] = useState(false);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [confirmDelete, setConfirmDelete] = useState(false);

        const pretty = (p) => (p === d.home ? "~" : p.startsWith(`${d.home}/`) ? `~/${p.slice(d.home.length + 1)}` : p);

        if (browsing) {
            return html`<div>
                <div class="pj-head" style="margin-bottom:10px">Add a folder to ${name || "the project"}</div>
                <${FolderBrowser}
                    start=${folders[0]}
                    pickLabel="Add"
                    onCancel=${() => setBrowsing(false)}
                    onPick=${(path) => {
                        if (!folders.includes(path)) setFolders([...folders, path]);
                        setBrowsing(false);
                    }}
                />
            </div>`;
        }

        const saveIt = async () => {
            setBusy(true);
            setError(null);
            try {
                const saved = await pocket.api("project", { id: existing?.id, name, folders, instructions, pinned });
                await reload();
                if (!existing && forSession != null) {
                    await assign([forSession], saved.id, () => folder);
                    pocket.notify?.("info", `This session is now in ${saved.name}`);
                } else pocket.notify?.("info", `Saved ${saved.name}`);
                close();
            } catch (e) {
                setError(e.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<div style="display:flex;flex-direction:column;gap:12px;min-height:0">
            <div>
                <div class="pj-head">Name</div>
                <input class="pj-input" value=${name} placeholder="e.g. Family Business" onInput=${(e) => setName(e.currentTarget.value)} />
            </div>
            <div>
                <div class="pj-head">Folders. New sessions start in the first one; Pi also knows the others.</div>
                <div class="pj-list">
                    ${folders.length === 0 && html`<div class="small muted" style="padding:10px">No folders yet. Sessions start in your default folder.</div>`}
                    ${folders.map(
                        (f, i) => html`<div class="pj-row" style="cursor:default">
                            <${pocket.Icon} name="folder" size=${14} />
                            <span class="pj-grow mono small" title=${f}>${pretty(f)}</span>
                            ${i === 0 ? html`<span class="pj-sub">main</span>` : html`<button class="pj-link" onClick=${() => setFolders([f, ...folders.filter((x) => x !== f)])}>Make main</button>`}
                            <button class="pj-link" onClick=${() => setFolders(folders.filter((x) => x !== f))}>Remove</button>
                        </div>`,
                    )}
                    <button class="pj-row" onClick=${() => setBrowsing(true)}><span style="width:14px;text-align:center">+</span><span>Add folder</span></button>
                </div>
            </div>
            <div>
                <div class="pj-head">Instructions. Pi gets them in every session of this project.</div>
                <textarea class="pj-input" rows="6" style="resize:vertical" placeholder="e.g. Answer in Thai. The app is a Next.js PWA; run pnpm test before you say it works." value=${instructions} onInput=${(e) => setInstructions(e.currentTarget.value)}></textarea>
            </div>
            <label class="small" style="display:inline-flex;gap:6px;align-items:center;align-self:flex-start;width:auto;cursor:pointer">
                <input type="checkbox" style="width:auto;margin:0" checked=${pinned} onChange=${(e) => setPinned(e.currentTarget.checked)} />
                <span>Pin at the top</span>
            </label>
            ${error && html`<div class="error-box">${error}</div>`}
            <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap">
                <div>
                    ${existing &&
                    (confirmDelete
                        ? html`<button class="button small" onClick=${run(async () => {
                              await pocket.api("project-delete", { id: existing.id });
                              if (filterProject === existing.id) setFilter(null);
                              await reload();
                              close();
                          })}>Delete ${existing.name}? Its sessions stay.</button>`
                        : html`<button class="button small" onClick=${() => setConfirmDelete(true)}>Delete</button>`)}
                </div>
                <div style="display:flex;gap:8px">
                    ${existing && html`<button class="button" onClick=${() => {
                        close();
                        run(startIn)(existing.id);
                    }}>New session</button>`}
                    <button class="button primary" disabled=${busy || !name.trim()} onClick=${saveIt}>${existing ? "Save" : "Create project"}</button>
                </div>
            </div>
            ${css}
        </div>`;
    }

    // ---------- Sheet: the default folder for New ----------

    function DefaultFolder({ close }) {
        const d = useData();
        const scratch = d.newIn !== "folder";
        return html`<div>
            <div class="pj-head">What New starts when no project filter is on</div>
            <div class="pj-list" style="margin-bottom:12px">
                <button class=${`pj-row ${scratch ? "on" : ""}`} onClick=${run(async () => {
                    await pocket.api("new-in-scratch", {});
                    await reload();
                    pocket.notify?.("info", "New now starts chats with no project");
                    close();
                })}><span class="pj-grow">A chat with no project<div class="pj-sub">Each gets a new temporary folder. Pi cannot reach your other files.</div></span></button>
                <div class=${`pj-row ${scratch ? "" : "on"}`} style="cursor:default"><span class="pj-grow">A session in a folder<div class="pj-sub mono">${scratch ? "Choose it below" : d.defaultPretty}</div></span></div>
            </div>
            <${FolderBrowser}
                start=${d.defaultFolder}
                onCancel=${close}
                onPick=${async (path) => {
                    const r = await pocket.api("default-folder", { path });
                    pocket.notify?.("info", `New now starts sessions in ${r.pretty}`);
                    await reload();
                    close();
                }}
            />
        </div>`;
    }

    // ---------- Sheet: the session list's project filter, and Move to project ----------

    function FilterSheet({ close }) {
        const d = useData();
        const fp = liveFilter();
        return html`<div class="pj-list">
            <button class=${`pj-row ${fp ? "" : "on"}`} onClick=${() => {
                setFilter(null);
                close();
            }}><span class="pj-grow">All sessions</span></button>
            ${sortProjects(d.projects).map(
                (p) => html`<button class=${`pj-row ${fp === p.id ? "on" : ""}`} onClick=${() => {
                    setFilter(p.id);
                    close();
                }}><${pocket.Icon} name="folder" size=${14} /><span class="pj-grow">${p.name}</span><span class="pj-p-count">${p.count ? String(p.count) : ""}</span></button>`,
            )}
            ${d.projects.length === 0 && html`<div class="small muted" style="padding:10px">No projects yet.</div>`}
            ${css}
        </div>`;
    }

    /** What the scope header's menu opens: the few things a person wants from a project they are looking at. */
    function ScopeSheet({ close, id: projectId }) {
        const d = useData();
        const p = d.projects.find((x) => x.id === projectId);
        useEffect(() => {
            reload();
        }, []);
        if (!p) return html`<div class="small muted">That project is gone.</div>`;
        return html`<div style="display:flex;flex-direction:column;gap:12px">
            <div>
                <div class="pj-head">${p.name} \u00b7 ${p.count ?? 0} chats</div>
                <div class="pj-sub mono" style="white-space:pre-line">${(p.pretty ?? []).join("\n") || "No folders"}</div>
            </div>
            <div class="pj-list">
                <button class="pj-row" onClick=${() => {
                    close();
                    run(startIn)(p.id);
                }}><${pocket.Icon} name="folder" size=${14} /><span class="pj-grow">New chat in ${p.name}</span></button>
                <button class="pj-row" onClick=${() => {
                    close();
                    pocket.openSheet("editor", { id: p.id });
                }}><span class="pj-grow">Edit project and folders</span></button>
                <button class="pj-row" onClick=${run(async () => {
                    await pocket.api("project-pin", { id: p.id });
                    await reload();
                })}><span class="pj-grow">${p.pinned ? "Unpin from the top" : "Pin at the top"}</span></button>
                <button class="pj-row" onClick=${() => {
                    setFilter(null);
                    close();
                }}><span class="pj-grow">Show all sessions</span></button>
            </div>
            ${css}
        </div>`;
    }

    function MoveSheet({ close, sessions }) {
        const d = useData();
        const ids = (sessions ?? []).map(Number);
        const go = run(async (projectId) => {
            await assign(ids, projectId);
            pocket.notify?.("info", projectId ? `Moved to ${projectById(projectId)?.name}` : "Removed from its project");
            close();
        });
        return html`<div style="display:flex;flex-direction:column;gap:10px">
            <div class="pj-head">A session outside the project's folders moves to its first folder.</div>
            <div class="pj-list">
                ${sortProjects(d.projects).map((p) => html`<button class="pj-row" onClick=${() => go(p.id)}><${pocket.Icon} name="folder" size=${14} /><span class="pj-grow">${p.name}</span></button>`)}
                <button class="pj-row" onClick=${() => go(null)}>No project</button>
            </div>
            ${css}
        </div>`;
    }

    pocket.sheet({ id: "picker", title: "Project or folder", component: Picker });
    pocket.sheet({ id: "manage", title: "Projects", component: (props) => html`<${Picker} ...${props} manage=${true} />` });
    pocket.sheet({ id: "editor", title: "Project", component: Editor });
    pocket.sheet({ id: "default", title: "What New starts", component: DefaultFolder });
    pocket.sheet({ id: "filter", title: "Show sessions of", component: FilterSheet });
    pocket.sheet({ id: "scope", title: "Project", component: ScopeSheet });
    pocket.sheet({ id: "move", title: "Move to project", component: MoveSheet });

    // ---------- The chip under the message box ----------

    // A tap leaves the project at once, as ChatGPT's × on its project chip does.
    const leaveBtn = pocket.status({
        id: "folder-x",
        text: "\u00d7",
        short: "\u00d7",
        title: "Don't work in a project. Pi works only in a temporary folder.",
        label: "Leave the project",
        tone: "muted",
        before: "ext:projects:folder",
        run: run(async () => {
            await leaveProject();
            pocket.notify?.("info", "This chat now has no project. Pi works only in a temporary folder.");
        }),
    });

    const chip = pocket.status({
        id: "folder",
        text: "Folder ▾",
        title: "The project and folders Pi works in. Tap to change them.",
        label: "Project or folder",
        after: "core:connection",
        run: () => (pocket.conversationId?.() == null ? pocket.openSheet("manage") : pocket.openSheet("picker")),
    });

    function drawChip() {
        const s = data.session;
        if (!s || s.id !== pocket.conversationId?.()) return chip.update({ text: "Folder ▾", short: "Folder ▾" });
        const project = projectById(s.project);
        const base = project ? project.name : s.scratch ? "No project" : nameOf(s.cwd);
        const more = s.folders.length > 1 ? ` +${s.folders.length - 1}` : "";
        const text = `${base}${more} ▾`;
        chip.update({
            text,
            short: text,
            title: `${project ? `Project: ${project.name}\n` : ""}${s.folders.map((f) => f.path).join("\n")}\nTap to change.`,
            tone: s.ok ? undefined : "warn",
        });
    }

    // ---------- The session list ----------

    const chips = pocket.sessionChips?.({ id: "project", chips: () => [] });
    const words = pocket.sessionSearch?.({ id: "project", words: () => [] });
    const filter = pocket.sessionFilter?.({
        id: "project",
        title: "Filter by project",
        icon: "folder",
        sheet: "filter",
        match: null,
        started: (id) => {
            const fp = liveFilter();
            return fp ? assign([id], fp) : undefined;
        },
    });
    pocket.sessionAction?.({ id: "move", label: "Move to project…", sheet: "move" });

    function setFilter(projectId) {
        filterProject = projectId && projectById(projectId) ? projectId : null;
        if (filterProject) localStorage.setItem(FILTER_KEY, filterProject);
        else localStorage.removeItem(FILTER_KEY);
        drawList();
        drawBlock();
        document.querySelector('[data-part="session-list"] .session-items')?.scrollTo?.({ top: 0 });
    }

    let saidGone = false;
    /** The filter the list shows, if that project is still there: one deleted in another tab must not empty the list. */
    function liveFilter() {
        if (!filterProject || !loaded) return filterProject;
        if (projectById(filterProject)) return filterProject;
        filterProject = null;
        localStorage.removeItem(FILTER_KEY);
        if (!saidGone) {
            saidGone = true;
            pocket.notify?.("info", "That project is gone, so the list shows all sessions again.");
        }
        return null;
    }

    // Which tab the list shows, and whether its search has words: Recent without a search hides project sessions.
    const listTab = () => document.querySelector('[data-part="session-tab"][aria-selected="true"]')?.dataset.tab ?? null;
    const searching = () => !!document.querySelector('[data-part="session-search"] input')?.value?.trim();
    const groupedRecent = () => listTab() === "recent" && !searching() && !liveFilter() && data.projects.length > 0;

    function drawList() {
        const links = data.links ?? {};
        const name = (s) => projectById(links[String(s.id)])?.name;
        const fp = liveFilter();
        chips?.update({
            chips: (s) => {
                const pid = links[String(s.id)];
                const p = projectById(pid);
                if (!p) return [];
                // A chip that only repeats the heading over the list is noise: hidden while its project is the filter.
                if (pid === fp) return [];
                const label = p.folders.length > 1 ? `${p.name} \u203a ${nameOf(s.cwd)}` : p.name;
                return [{ label, title: `${p.name}\n${s.cwd ?? ""}\nTap to show only its chats.`, run: () => setFilter(pid) }];
            },
        });
        words?.update({ words: (s) => (name(s) ? [name(s)] : []) });
        const grouped = groupedRecent();
        const inSomeProject = new Set(data.projects.flatMap((p) => (p.chats ?? []).map((c) => c.id)));
        lastGrouped = grouped;
        filter?.update({
            match: fp ? (s) => links[String(s.id)] === fp : grouped ? (s) => !links[String(s.id)] && !inSomeProject.has(s.id) : null,
            badge: null,
            title: fp
                ? `Showing ${projectById(fp)?.name}. Tap to change.`
                : grouped
                  ? "Recent lists projects at the top, and sessions without a project below. Tap to show one project."
                  : "Filter by project",
        });
    }
    let lastGrouped = false;

    // ---------- The Projects block at the top of the list ----------
    // The list has no extension point for groups, so this block is put in its scroll box, as New's click is caught.
    // If an update changes the list, the block stops showing: nothing breaks.

    const ago = (t) => {
        if (!t) return "";
        const m = Math.round((Date.now() - t) / 60000);
        return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
    };
    let blockSig = "";
    let projectsOpen = localStorage.getItem("pj.projectsOpen") !== "0";

    function el(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "onClick") e.addEventListener("click", v);
            else if (k === "style") e.style.cssText = v;
            else e.setAttribute(k, v);
        }
        for (const k of kids) if (k != null) e.append(k);
        return e;
    }

    // Which projects are open, and which show all their chats: kept per browser.
    const keep = (key, fallback) => {
        try {
            return new Set(JSON.parse(localStorage.getItem(key) ?? fallback));
        } catch {
            return new Set();
        }
    };
    const openProjects = keep("pj.open", "[]");
    const longProjects = keep("pj.long", "[]");
    let allProjects = false;
    const store = (key, set) => localStorage.setItem(key, JSON.stringify([...set]));
    const toggle = (set, key, id) => {
        set.has(id) ? set.delete(id) : set.add(id);
        store(key, set);
        drawBlock();
    };

    const ICON = {
        folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        folderOpen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 17l2.6-6.2A2 2 0 0 1 7.4 9.6H21l-2.8 7.2a2 2 0 0 1-1.9 1.2H5a2 2 0 0 1-2-1z"/></svg>',
        compose: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
        dots: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
        plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/></svg>',
        pinOn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7" fill="none"/></svg>',
        mail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
        mailOpen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-5 9 5v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9l9 6 9-6"/></svg>',
        archive: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>',
        chevron: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
        filter: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg>',
        close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    };
    const icon = (name, cls = "pj-i") => {
        const s = el("span", { class: cls, "aria-hidden": "true" });
        s.innerHTML = ICON[name];
        return s;
    };
    const SHOW = 5;

    // ---------- The app's own row actions ----------
    // Pin and mark-unread live in this browser (localStorage, and the app's store); archive goes to the server. The
    // app's modules are at the site's root and already loaded, so importing one gives the same live module. They are not
    // a public API: a version that changes them takes the fallbacks here, which still work.

    let appApi = null;
    async function appApi_() {
        if (appApi) return appApi;
        const [storeMod, themeMod, sessionsMod] = await Promise.all([
            import("/store.js").catch(() => null),
            import("/theme.js").catch(() => null),
            import("/sessions.js").catch(() => null),
        ]);
        appApi = {
            store: storeMod?.store ?? null,
            setUnread: storeMod?.setUnread ?? null,
            updateSession: storeMod?.actions?.updateSession ?? null,
            isPinned: themeMod?.isPinned ?? null,
            togglePin: themeMod?.togglePin ?? null,
            setArchived: sessionsMod?.setArchived ?? null,
        };
        return appApi;
    }
    const pinnedIds = () => new Set(appApi?.store?.state?.pinned ?? []);
    const unreadIds = () => new Set(appApi?.store?.state?.unread ?? []);

    const actions2 = {
        async pin(id) {
            const a = await appApi_();
            if (a.togglePin) a.togglePin(id);
            else {
                const key = "pocket.pinned";
                const list = JSON.parse(localStorage.getItem(key) ?? "[]");
                localStorage.setItem(key, JSON.stringify(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
            }
            blockSig = "";
            drawBlock();
        },
        async read(id) {
            const a = await appApi_();
            const unread = unreadIds().has(id);
            if (a.setUnread) a.setUnread(id, !unread);
            else {
                const key = "pocket.unread";
                const list = JSON.parse(localStorage.getItem(key) ?? "[]");
                localStorage.setItem(key, JSON.stringify(!unread ? [...new Set([...list, id])] : list.filter((x) => x !== id)));
            }
            blockSig = "";
            drawBlock();
        },
        async archive(id) {
            const a = await appApi_();
            if (a.setArchived) a.setArchived([id], true);
            else if (a.updateSession) await a.updateSession(id, { archived: true });
            else {
                const r = await fetch(`/api/sessions/${id}`, {
                    method: "POST",
                    headers: { "X-Pocket": "1", "content-type": "application/json" },
                    body: JSON.stringify({ archived: true }),
                });
                if (!r.ok) throw new Error(`the server answered ${r.status}`);
            }
            blockSig = "";
            drawBlock();
            setTimeout(reload, 500);
        },
    };
    appApi_().then(() => {
        blockSig = "";
        drawBlock();
    });

    /** A filtered project with no chats: say so, and give the two things a person wants next. */
    function emptyCard(project) {
        return el("div", { "data-projects-extra": "1", class: "pj-empty" },
            el("div", null, `No chats in ${project.name} yet`),
            el("div", { class: "pj-empty-actions" },
                el("button", { class: "button small primary", onClick: () => run(startIn)(project.id) }, "New chat"),
                el("button", { class: "button small", onClick: () => setFilter(null) }, "Show all sessions"),
            ),
        );
    }

    function drawBlock() {
        const box = document.querySelector('[data-part="session-list"] .session-items');
        const old = document.querySelector("[data-projects-block]");
        const extra = document.querySelector("[data-projects-extra]");
        const fp = liveFilter();
        const showProjects = groupedRecent();
        const showBar = !!fp && !!projectById(fp);
        if (!box || (!showProjects && !showBar)) {
            old?.remove();
            extra?.remove();
            blockSig = "";
            return;
        }
        const here = pocket.conversationId?.();
        const scope = showBar ? projectById(fp) : null;
        const empty = !!scope && !scope.count && listTab() !== "archived" && !searching();
        const sig = JSON.stringify([
            showProjects, fp, projectsOpen, allProjects, here, empty, [...openProjects], [...longProjects],
            [...pinnedIds()], [...unreadIds()],
            data.projects.map((p) => [p.id, p.name, p.pinned, p.count, (p.chats ?? []).map((c) => [c.id, c.title, ago(c.updatedAt)])]),
        ]);
        if (old && old.parentElement === box && box.firstElementChild === old && sig === blockSig) return;
        blockSig = sig;
        const block = el("div", { "data-projects-block": "1", class: `pj-block${showBar ? " pj-scope-block" : ""}` });

        if (showBar) {
            const p = projectById(fp);
            const path = (p.pretty ?? []).join("  ");
            const more = p.folders.length > 1 ? ` +${p.folders.length - 1}` : "";
            block.append(
                el("div", { class: "pj-scope" },
                    el("button", { class: "pj-scope-main", title: `${path}\nTap to show another project.`, onClick: () => pocket.openSheet("filter") },
                        icon("folder"),
                        el("span", { class: "pj-scope-name" }, p.name),
                        el("span", { class: "pj-scope-count" }, String(p.count ?? 0)),
                    ),
                    el("button", { class: "pj-tool", title: "More", "aria-label": "More", onClick: () => pocket.openSheet("scope", { id: p.id }) }, icon("dots")),
                    el("button", { class: "pj-tool", title: "Show all sessions", "aria-label": "Show all sessions", onClick: () => setFilter(null) }, icon("close")),
                ),
            );
            if (path) block.append(el("div", { class: "pj-scope-path mono", title: path }, `${p.pretty[0] ?? ""}${more}`));
        } else {
            // The heading: "Projects" and a chevron, as the app's own group heads.
            const head = el("button", { class: `group-head pj-b-head ${projectsOpen ? "" : "pj-closed"}`, "aria-expanded": String(projectsOpen), onClick: () => {
                projectsOpen = !projectsOpen;
                localStorage.setItem("pj.projectsOpen", projectsOpen ? "1" : "0");
                drawBlock();
            } },
                el("span", { class: "group-name" }, "Projects"),
                icon("chevron", "pj-chev"),
            );
            block.append(head);

            if (projectsOpen) {
                const list = sortProjects(data.projects);
                const shown = allProjects ? list : list.slice(0, SHOW);
                for (const p of shown) {
                    const open = openProjects.has(p.id);
                    const row = el("div", { class: `pj-p ${open ? "open" : ""}`, role: "button", tabindex: "0", "aria-expanded": String(open), title: p.pretty.join("\n") || p.name, onClick: () => toggle(openProjects, "pj.open", p.id) },
                        icon(open ? "folderOpen" : "folder"),
                        el("span", { class: "pj-p-name" }, p.name),
                        el("span", { class: "pj-p-count" }, p.count ? String(p.count) : ""),
                        el("span", { class: "pj-p-tools" },
                            el("button", { class: "pj-tool", title: `Show only ${p.name}`, "aria-label": `Show only ${p.name}`, onClick: (e) => {
                                e.stopPropagation();
                                setFilter(p.id);
                            } }, icon("filter")),
                            el("button", { class: "pj-tool", title: "Edit project", "aria-label": `Edit ${p.name}`, onClick: (e) => {
                                e.stopPropagation();
                                pocket.openSheet("editor", { id: p.id });
                            } }, icon("dots")),
                            el("button", { class: "pj-tool", title: `New chat in ${p.name}`, "aria-label": `New chat in ${p.name}`, onClick: (e) => {
                                e.stopPropagation();
                                run(startIn)(p.id);
                            } }, icon("plus")),
                        ),
                    );
                    row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), row.click()));
                    block.append(row);

                    if (open) {
                        const chats = p.chats ?? [];
                        const long = longProjects.has(p.id);
                        if (chats.length === 0) block.append(el("div", { class: "pj-c pj-c-empty" }, "No chats yet"));
                        const pinned = pinnedIds();
                        const unread = unreadIds();
                        for (const c of long ? chats : chats.slice(0, SHOW)) {
                            const tools = el("span", { class: "pj-c-tools" },
                                el("button", { class: "pj-tool", title: pinned.has(c.id) ? "Unpin" : "Pin", "aria-label": pinned.has(c.id) ? "Unpin" : "Pin", onClick: (e) => {
                                    e.stopPropagation();
                                    run(() => actions2.pin(c.id))();
                                } }, icon(pinned.has(c.id) ? "pinOn" : "pin")),
                                el("button", { class: "pj-tool", title: unread.has(c.id) ? "Mark read" : "Mark unread", "aria-label": unread.has(c.id) ? "Mark read" : "Mark unread", onClick: (e) => {
                                    e.stopPropagation();
                                    run(() => actions2.read(c.id))();
                                } }, icon(unread.has(c.id) ? "mailOpen" : "mail")),
                                el("button", { class: "pj-tool", title: "Archive", "aria-label": "Archive", onClick: (e) => {
                                    e.stopPropagation();
                                    run(() => actions2.archive(c.id))();
                                } }, icon("archive")),
                            );
                            const row = el("div", { class: `pj-c ${c.id === here ? "on" : ""} ${unread.has(c.id) ? "pj-unread" : ""}`, role: "button", tabindex: "0", title: c.title, onClick: () => pocket.openConversation(c.id) },
                                unread.has(c.id) ? el("span", { class: "pj-dot", title: "Unread" }) : el("span", { class: "pj-dot pj-dot-off" }),
                                el("span", { class: "pj-c-title" }, c.title),
                                el("span", { class: "pj-c-time" }, ago(c.updatedAt)),
                                tools,
                            );
                            row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), row.click()));
                            block.append(row);
                        }
                        if (chats.length > SHOW) {
                            block.append(el("button", { class: "pj-c pj-more", onClick: () => toggle(longProjects, "pj.long", p.id) }, long ? "Show less" : "Show more"));
                        }
                    }
                }
                if (list.length > SHOW) {
                    block.append(el("button", { class: "pj-p pj-more", onClick: () => {
                        allProjects = !allProjects;
                        drawBlock();
                    } }, allProjects ? "Show less" : "Show more"));
                }
                block.append(el("button", { class: "pj-p pj-new", onClick: () => pocket.openSheet("editor", {}) }, icon("plus"), el("span", { class: "pj-p-name" }, "New project")));
            }
        }
        if (!document.getElementById("pj-block-css")) {
            document.head.append(
                el("style", { id: "pj-block-css" },
                    `.pj-block{margin-bottom:6px}
                    .pj-b-head{cursor:pointer;background:none;border:0;font:inherit;display:flex;align-items:center;gap:6px}
                    .pj-chev{display:inline-flex;opacity:.6;transition:transform .15s}
                    .pj-b-head.pj-closed .pj-chev{transform:rotate(-90deg)}
                    .pj-p,.pj-c{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;border:0;border-radius:8px;background:none;color:var(--text);font:inherit;font-size:14px;text-align:left;cursor:pointer}
                    .pj-p{padding:7px 8px;min-height:34px}
                    .pj-c{padding:6px 8px 6px 34px;min-height:30px}
                    .pj-p:hover,.pj-c:hover,.pj-p:focus-visible{background:var(--card)}
                    .pj-c.on{background:var(--card);font-weight:600}
                    .pj-i{display:inline-flex;flex:none;opacity:.75}
                    .pj-p-name,.pj-c-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                    .pj-c-time{flex:none;font-size:12px;opacity:.5}
                    .pj-p-tools{display:none;gap:2px;margin:-4px -4px -4px 0}
                    .pj-p:hover .pj-p-tools,.pj-p:focus-within .pj-p-tools{display:flex}
                    @media (pointer:coarse){.pj-p-tools{display:flex}}
                    .pj-tool{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:none;color:inherit;opacity:.65;cursor:pointer}
                    .pj-tool:hover{opacity:1;background:var(--line)}
                    .pj-more{opacity:.55;font-size:13px}
                    .pj-p.pj-more{padding-left:8px}
                    .pj-c-empty{opacity:.5;font-size:13px;cursor:default}
                    .pj-c{padding-left:24px}
                    .pj-c-tools{display:none;gap:1px;margin:-4px -6px -4px 0}
                    .pj-c:hover .pj-c-tools,.pj-c:focus-within .pj-c-tools{display:flex}
                    .pj-c:hover .pj-c-time{display:none}
                    @media (pointer:coarse){.pj-c-tools{display:flex}.pj-c:hover .pj-c-time{display:inline}.pj-c{flex-wrap:wrap}}
                    .pj-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
                    .pj-dot-off{background:transparent}
                    .pj-unread .pj-c-title{font-weight:600}
                    .pj-c-empty:hover{background:none}
                    .pj-new{opacity:.75}
                    .pj-bar{display:none}
                    .pj-scope-block{position:sticky;top:0;z-index:3;background:var(--panel);margin:0 -4px 2px;padding:2px 6px 6px 4px;border-bottom:1px solid var(--hair)}
                    .pj-scope{display:flex;align-items:center;gap:1px;padding-left:6px}
                    .pj-scope-main{flex:1;min-width:0;display:flex;align-items:center;gap:7px;padding:4px 4px 4px 2px;border:0;border-radius:8px;background:none;color:var(--text);font:inherit;font-size:13px;text-align:left;cursor:pointer}
                    .pj-scope-main:hover{background:var(--card)}
                    .pj-scope-main .pj-i,.pj-scope-block .pj-tool{color:var(--faint)}
                    .pj-scope-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
                    .pj-scope-count{flex:none;font:11px var(--mono);color:var(--faint)}
                    .pj-scope-path{padding:0 6px 0 33px;font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                    .pj-p-count{flex:none;font:11px var(--mono);color:var(--faint)}
                    .pj-empty{margin:10px 4px;padding:16px 12px;border:1px dashed var(--line);border-radius:12px;text-align:center;color:var(--muted);font-size:13px}
                    .pj-empty-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px}`,
                ),
            );
        }
        if (old) old.replaceWith(block);
        box.prepend(block);
        extra?.remove();
        if (empty) box.insertBefore(emptyCard(scope), block.nextSibling);
    }

    /** On a tab change or a search: hide or show project sessions, and the block. */
    function onListChange() {
        if (groupedRecent() !== lastGrouped) drawList();
        drawBlock();
    }
    const onInput = (e) => e.target instanceof Element && e.target.closest('[data-part="session-search"]') && setTimeout(onListChange, 0);
    document.addEventListener("input", onInput, true);

    // ---------- Menu and launcher ----------

    pocket.menu({ id: "projects", label: "Projects…", hint: "Projects", sheet: "manage" });
    pocket.menu({ id: "default", label: "What New starts…", hint: "Projects", sheet: "default" });
    pocket.menu({ id: "filter-project", label: "Show one project's sessions…", hint: "Projects", sheet: "filter" });
    pocket.menu({ id: "session", label: "Project or folder…", hint: "Projects", group: "session", sheet: "picker" });
    pocket.launcher({ id: "projects", label: "Projects…", detail: "Projects", icon: "folder", keywords: ["project", "projects"], sheet: "manage" });
    pocket.launcher({ id: "new-project", label: "New project…", detail: "Projects", icon: "folder", keywords: ["create project"], run: () => pocket.openSheet("editor", {}) });
    pocket.launcher({ id: "session", label: "Change this session's folders…", detail: "Projects", icon: "folder", keywords: ["cwd", "folder", "directory", "add folder"], sheet: "picker" });
    pocket.launcher({ id: "default", label: "What New starts…", detail: "Projects", icon: "folder", keywords: ["default folder", "quick new"], sheet: "default" });
    pocket.launcher({ id: "filter-project", label: "Show one project's sessions…", detail: "Projects", icon: "folder", keywords: ["filter", "project", "scope", "only"], sheet: "filter" });

    // ---------- New: start at once ----------

    let busy = false;
    function onClick(event) {
        const button = event.target instanceof Element && event.target.closest('[data-part="session-list"] .new-button');
        if (!button || busy || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        busy = true;
        (async () => {
            if (!liveFilter() && data.newIn === "folder" && !data.defaultOk) {
                pocket.notify?.("warning", `${data.defaultPretty} is not there (an unplugged drive?). Pick another default folder.`);
                pocket.openSheet("default");
                return;
            }
            await startIn(liveFilter());
        })()
            .catch((error) => {
                pocket.notify?.("error", `New failed: ${error.message}. Opening the folder picker instead.`);
                button.click();
            })
            .finally(() => {
                busy = false;
            });
    }
    document.addEventListener("click", onClick, true);

    const retitle = () => {
        for (const b of document.querySelectorAll('[data-part="session-list"] .new-button:not([data-projects])')) {
            b.dataset.projects = "1";
            b.dataset.oldTitle = b.title;
            b.title = "New chat with no project, or in the filtered project (Shift+click: pick a folder)";
        }
    };
    retitle();
    let pending = false;
    const observer = new MutationObserver(() => {
        retitle();
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            onListChange();
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // ---------- Keep it fresh ----------

    const stopConv = pocket.onConversation?.(() => {
        drawBlock();
        reload();
    });
    const stopEvents = pocket.on("changed", () => reload());
    // /cwd or another person can move a session too.
    const timer = setInterval(() => document.visibilityState === "visible" && reload(), 15000);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    reload();

    return () => {
        stopConv?.();
        stopEvents?.();
        clearInterval(timer);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("input", onInput, true);
        observer.disconnect();
        document.querySelector("[data-projects-block]")?.remove();
        document.querySelector("[data-projects-extra]")?.remove();
        document.getElementById("pj-block-css")?.remove();
        for (const b of document.querySelectorAll("[data-projects]")) {
            b.title = b.dataset.oldTitle ?? b.title;
            delete b.dataset.projects;
            delete b.dataset.oldTitle;
        }
    };
}
