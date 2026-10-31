// MCP servers, the browser part: a rail button above the Extensions one, and a sheet that shows, signs in, turns on
// and off, adds, and removes the MCP servers of `~/.pi/agent/mcp.json`.
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useState, useEffect } = pocket;

    /** Two racks: a server. One path, as the app's Icon draws one. */
    const RACKS =
        "M4 4h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" +
        "M4 14h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" +
        "M7 7h.01M7 17h.01";

    const show = () => pocket.openSheet("servers");

    pocket.rail({ id: "servers", title: "MCP servers", iconPath: RACKS, run: show });
    pocket.menu({ id: "servers", label: "MCP servers…", hint: "MCP", run: show });
    pocket.launcher({ id: "servers", label: "MCP servers…", detail: "MCP", iconPath: RACKS, keywords: ["mcp", "servers", "tools", "model context protocol"], run: show });

    // ---------- Its place: above the Extensions button, by order alone ----------
    // The app draws the button; this only gives it an `order` in the rail's column (see the Extensions button module,
    // which puts the extension group into that column). Nothing in the page is added, moved, or hidden, so the buttons
    // cannot double up.

    const style = document.createElement("style");
    style.id = "mcp-rail-css";
    style.textContent = [
        "nav[data-part='rail'] .rail-exts{display:contents}",
        "nav[data-part='rail'] button.rail-ext[title='MCP servers']{order:90}",
    ].join("\n");
    document.head.append(style);

    // ---------- The sheet ----------
    // Cards in a grid: each server with its kind (local or remote), a coloured state, and its actions. The sheet grows
    // to the screen it has, and one column of cards on a phone.

    const TERMINAL = "M4 17l6-5-6-5M12 19h8";
    const GLOBE = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 4 3 14 0 18M12 3c-3 4-3 14 0 18";
    const SEARCH = "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4";

    const Glyph = ({ d, size = 18 }) =>
        html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d} /></svg>`;

    /** The words and colour of a state: grey off, green ready or connected, amber needs a sign-in or is pending, red failed. */
    const LOOK = {
        connected: { label: "Connected", tone: "ok" },
        ready: { label: "Ready", tone: "ok" },
        "needs sign-in": { label: "Needs sign-in", tone: "warn" },
        failed: { label: "Failed", tone: "err" },
        "not listed": { label: "Pending", tone: "pending" },
        off: { label: "Off", tone: "off" },
    };

    function Servers({ close }) {
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);
        const [note, setNote] = useState(null);
        const [busy, setBusy] = useState(null);
        const [open, setOpen] = useState(() => new Set());
        const [query, setQuery] = useState("");
        const [name, setName] = useState("");
        const [target, setTarget] = useState("");
        const [adding, setAdding] = useState(false);
        const [signIn, setSignIn] = useState(null); // { name, url } while a sign-in waits
        const [address, setAddress] = useState("");
        const [copied, setCopied] = useState(false);

        const load = () => pocket.api("state").then(setState, (e) => setError(e.message));
        useEffect(() => {
            load();
            // A sign-in finishes on another page: coming back to this one lists the servers again.
            const back = () => {
                if (document.visibilityState === "visible") {
                    load();
                    setSignIn(null);
                }
            };
            document.addEventListener("visibilitychange", back);
            window.addEventListener("focus", back);
            return () => {
                document.removeEventListener("visibilitychange", back);
                window.removeEventListener("focus", back);
            };
        }, []);

        const run = async (action, serverName, extra) => {
            setBusy(`${action}:${serverName ?? ""}`);
            setError(null);
            setNote(null);
            try {
                const r = await pocket.api("action", {
                    action,
                    name: serverName,
                    ...(action === "login" ? { origin: location.origin, inApp: true } : {}),
                    ...(extra ?? {}),
                });
                setState((s) => ({ ...s, servers: r.servers }));
                if (r.text) setNote(r.text);
                // A sign-in answers with its address: open it, and keep it in sight to copy on another device.
                const url = action === "login" ? String(r.text ?? "").match(/https?:\/\/\S+/)?.[0] : undefined;
                if (url) {
                    setSignIn({ name: serverName, url, inApp: r.inApp === true });
                    setAddress("");
                    window.open(url, "_blank", "noopener");
                } else if (action === "login") {
                    setSignIn(null);
                    setNote(r.text || `Already signed in to ${serverName}.`);
                }
                if (action === "finish") {
                    setSignIn(null);
                    setAddress("");
                }
                return r;
            } catch (e) {
                setError(e.message);
            } finally {
                setBusy(null);
            }
        };

        const toggle = (n) => {
            const next = new Set(open);
            next.has(n) ? next.delete(n) : next.add(n);
            setOpen(next);
        };

        if (!state)
            return html`<div class="mcp-root">${error ? html`<div class="error-box">${error}</div>` : html`<${pocket.Loader} label="Loading servers" />`}</div>`;

        const all = state.servers;
        const q = query.trim().toLowerCase();
        const shown = q
            ? all.filter((s) => `${s.name} ${s.target} ${s.description ?? ""}`.toLowerCase().includes(q))
            : all;
        const on = all.filter((s) => s.enabled).length;
        const tools = all.reduce((sum, s) => sum + (s.enabled ? s.tools : 0), 0);

        return html`<div class="mcp-root">
            <div class="mcp-head">
                <div class="mcp-intro">
                    <div class="mcp-lead">Tool servers Pi can call. Open one, or check its status.</div>
                    <div class="mcp-dim">${all.length} ${all.length === 1 ? "server" : "servers"} · ${on} on · ${tools} tools · <span class="mono">${state.configPath}</span></div>
                </div>
                <div class="mcp-actions">
                    <button class="button small" disabled=${busy !== null} onClick=${() => run("refresh", undefined)}>
                        ${busy === "refresh:" ? "Listing…" : "List tools again"}
                    </button>
                </div>
            </div>

            ${all.length > 4 &&
            html`<label class="mcp-search">
                <${Glyph} d=${SEARCH} size=${16} />
                <input placeholder="Search servers" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
            </label>`}

            ${signIn &&
            html`<div class="mcp-signin">
                <div class="mcp-signin-head">
                    <strong>Sign in to ${signIn.name}</strong>
                    <button class="mcp-x" title="Close" onClick=${() => setSignIn(null)}>×</button>
                </div>
                <div class="mcp-dim">
                    Approve on the page that opened. It comes back here by itself, and this list follows when you return to Pi Pocket. If that page cannot open, copy the address and finish it below.
                </div>
                <div class="mcp-signin-row">
                    <a class="mcp-url mono" href=${signIn.url} target="_blank" rel="noopener">${signIn.url}</a>
                    <button
                        class="button small"
                        onClick=${async () => {
                            try {
                                await navigator.clipboard.writeText(signIn.url);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            } catch {
                                setNote(signIn.url);
                            }
                        }}
                    >${copied ? "Copied" : "Copy"}</button>
                </div>
                <form
                    class="mcp-signin-row"
                    onSubmit=${async (e) => {
                        e.preventDefault();
                        await run("finish", undefined, { target: address.trim() });
                    }}
                >
                    <input class="mono" placeholder="Paste the address the sign-in ended on" value=${address} onInput=${(e) => setAddress(e.currentTarget.value)} />
                    <button class="button small primary" disabled=${!address.trim() || busy !== null}>Finish</button>
                </form>
            </div>`}

            ${error && html`<div class="error-box">${error}</div>`}

            <div class="mcp-grid">
                ${shown.map((s) => {
                    const off = !s.enabled;
                    const look = LOOK[off ? "off" : s.state] ?? { label: s.state, tone: "pending" };
                    const long = (s.description ?? "").length > 150;
                    const wide = open.has(s.name);
                    return html`<div class=${`mcp-card ${off ? "off" : ""} ${wide ? "wide" : ""}`}>
                        <div class="mcp-card-top">
                            <span class="mcp-ico"><${Glyph} d=${s.url ? GLOBE : TERMINAL} size=${17} /></span>
                            <span class=${`mcp-pill ${look.tone}`}>${look.label}</span>
                        </div>
                        <div class="mcp-name" title=${s.name}>${s.name}</div>
                        <div class="mcp-target mono" title=${s.target}>${s.target}</div>
                        <div class="mcp-kind">${s.url ? "Remote server" : "Local server"}${!off && s.tools > 0 ? ` · ${s.tools} tools` : ""}</div>
                        ${(s.description || s.error) &&
                        html`<div class="mcp-body">
                            <div class=${`mcp-desc ${s.error ? "mcp-err" : ""}`} title=${wide ? undefined : s.error ?? s.description}>
                                ${s.error ?? s.description}
                            </div>
                            ${long && !s.error && html`<button class="mcp-more" onClick=${() => toggle(s.name)}>${wide ? "Show less" : "Show more"}</button>`}
                        </div>`}
                        <div class="mcp-card-tools">
                            ${!off &&
                            (s.state === "needs sign-in" || s.state === "failed") &&
                            html`<button class="button small primary" disabled=${busy !== null} onClick=${() => run("login", s.name)}>Sign in</button>`}
                            <button class="button small" disabled=${busy !== null} onClick=${() => run(off ? "enable" : "disable", s.name)}>
                                ${off ? "Turn on" : "Turn off"}
                            </button>
                            <button
                                class="button small mcp-remove"
                                disabled=${busy !== null}
                                onClick=${async () => {
                                    if (!confirm(`Remove ${s.name}, with its sign-in?`)) return;
                                    await run("remove", s.name);
                                }}
                            >Remove</button>
                        </div>
                    </div>`;
                })}

                ${adding
                    ? html`<form
                          class="mcp-card mcp-add"
                          onSubmit=${async (e) => {
                              e.preventDefault();
                              const r = await run("add", name.trim(), { target: target.trim() });
                              if (r) {
                                  setName("");
                                  setTarget("");
                                  setAdding(false);
                              }
                          }}
                      >
                          <div class="mcp-name">Add MCP server</div>
                          <input class="mono" placeholder="name, e.g. obsidian" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
                          <input class="mono" placeholder="https://… or npx -y some-mcp" value=${target} onInput=${(e) => setTarget(e.currentTarget.value)} />
                          <div class="mcp-kind">A URL signs in with OAuth. A command runs on this machine.</div>
                          <div class="mcp-card-tools">
                              <button class="button small" type="button" onClick=${() => setAdding(false)}>Cancel</button>
                              <button class="button small primary" disabled=${!name.trim() || !target.trim() || busy !== null}>Add</button>
                          </div>
                      </form>`
                    : html`<button class="mcp-card mcp-new" onClick=${() => setAdding(true)}>
                          <span class="mcp-plus">+</span>
                          <span class="mcp-name">Add MCP server</span>
                          <span class="mcp-kind">Local command or remote URL</span>
                      </button>`}
            </div>

            ${q && shown.length === 0 && html`<div class="mcp-dim" style="text-align:center;padding:20px">No server matches "${query}".</div>`}
            ${note && !signIn && html`<pre class="mcp-note mono small">${note}</pre>`}

            <style>
                body:has(.mcp-root) .sheet { max-width: min(1080px, 94vw); max-height: 90dvh; }
                @media (max-width: 699px) {
                    body:has(.mcp-root) .sheet { max-width: 100%; max-height: 96dvh; }
                }
                .mcp-root { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
                .mcp-head { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
                .mcp-intro { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 3px; }
                .mcp-lead { font-size: 14px; }
                .mcp-dim { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
                .mcp-actions { display: flex; gap: 8px; }
                .mcp-search { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--hair); border-radius: 10px; background: var(--bg); color: var(--muted); }
                .mcp-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--text); font: inherit; }
                .mcp-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); align-items: stretch; grid-auto-rows: 1fr; }
                .mcp-card { display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--hair); border-radius: var(--r-card, 12px); background: var(--card); min-width: 0; height: 100%; box-sizing: border-box; text-align: left; font: inherit; color: var(--text); }
                .mcp-card.off { opacity: .62; }
                .mcp-card.wide { grid-column: 1 / -1; }
                .mcp-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
                .mcp-ico { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--hair); color: var(--muted); flex: none; }
                .mcp-pill { font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 99px; white-space: nowrap; line-height: 1.6; border: 1px solid transparent; }
                /* The colour is mixed toward the theme's text, so a light theme gets a dark green, amber, or red, and a dark
                   theme a bright one: the palette's own colours alone are too faint on a light ground. */
                .mcp-pill::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: middle; }
                .mcp-pill.ok { color: color-mix(in oklab, var(--ok) 55%, var(--text)); background: color-mix(in srgb, var(--ok) 20%, transparent); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
                .mcp-pill.warn { color: color-mix(in oklab, var(--warn) 45%, var(--text)); background: color-mix(in srgb, var(--warn) 26%, transparent); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
                .mcp-pill.err { color: color-mix(in oklab, var(--err) 55%, var(--text)); background: color-mix(in srgb, var(--err) 18%, transparent); border-color: color-mix(in srgb, var(--err) 50%, transparent); }
                .mcp-pill.pending { color: var(--muted); background: var(--card-2); border-color: var(--hair); }
                .mcp-pill.pending::before { animation: mcp-wait 1.4s ease-in-out infinite; }
                .mcp-pill.off { color: var(--muted); background: none; border-color: var(--hair); }
                .mcp-pill.off::before { opacity: .35; }
                @keyframes mcp-wait { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
                @media (prefers-reduced-motion: reduce) { .mcp-pill.pending::before { animation: none; } }
                .mcp-name { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
                .mcp-target { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mcp-kind { font-size: 12px; color: var(--muted); }
                .mcp-body { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; margin-top: 2px; }
                .mcp-desc { font-size: 13px; line-height: 1.45; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; width: 100%; }
                .mcp-card.wide .mcp-desc { -webkit-line-clamp: unset; display: block; }
                .mcp-err { color: var(--err); }
                .mcp-more { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-size: 12px; cursor: pointer; }
                .mcp-card-tools { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; padding-top: 10px; }
                .mcp-card-tools .button { flex: 1; min-width: 0; justify-content: center; }
                .mcp-remove { color: var(--muted); }
                .mcp-new { align-items: center; justify-content: center; gap: 6px; border-style: dashed; background: none; color: var(--muted); cursor: pointer; text-align: center; }
                .mcp-new:hover { background: var(--card-2); }
                .mcp-new .mcp-name { margin: 0; color: var(--text); font-size: 14px; }
                .mcp-plus { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--hair); background: var(--card-2); font-size: 20px; line-height: 1; color: var(--muted); }
                .mcp-add { gap: 8px; }
                .mcp-add input { padding: 7px 9px; border: 1px solid var(--hair); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 13px; width: 100%; box-sizing: border-box; }
                .mcp-signin { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--warn-line, var(--hair)); border-radius: var(--r-card, 12px); background: var(--warn-soft, var(--card-2)); }
                .mcp-signin-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
                .mcp-x { background: none; border: 0; font: inherit; font-size: 18px; line-height: 1; color: var(--muted); cursor: pointer; padding: 0 4px; }
                .mcp-signin-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
                .mcp-signin-row input { flex: 1; min-width: 160px; padding: 7px 9px; border: 1px solid var(--hair); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
                .mcp-url { flex: 1; min-width: 0; font-size: 12px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mcp-note { margin: 0; padding: 10px; border: 1px solid var(--hair); border-radius: var(--r-card, 12px); white-space: pre-wrap; max-height: 24vh; overflow: auto; }
                @media (max-width: 699px) {
                    .mcp-grid { grid-template-columns: 1fr; }
                    .mcp-card-tools .button { flex: 1; }
                }
            </style>
        </div>`;
    }

    pocket.sheet({ id: "servers", title: "MCP servers", component: Servers });

    return () => style.remove();
}
