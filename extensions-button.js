// Extensions button, the browser part: a rail button that opens the app's Extensions manager.
//
// The rail is drawn by the app, which puts modules' buttons above its own bottom ones (Devices, Providers, Theme,
// you). To sit below the theme button, this module hides the button the app draws and draws its own at that place.
// A button of its own is not touched by the app's drawing, so it cannot double up or leave a copy behind.
export const pocketApi = 1;

/** Blocks, as an app's extensions are drawn: two overlapping tiles. One path, as the app's Icon draws one. */
const BLOCKS =
    "M10 22V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H2" +
    "M15 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z";

export default function setup(pocket) {
    /** The app's own module for opening a sheet: the same live module the app loaded. */
    let appStore = null;
    const loadStore = () =>
        (appStore ??= import("/store.js").then(
            (m) => m,
            () => ({}),
        ));

    /** Last resort: open the menu and click its "Extensions" row. */
    function throughTheMenu() {
        const part = (name) => document.querySelector(`[data-part="${name}"]`);
        const menu =
            part("menu") ??
            document.querySelector('button[aria-label="Menu" i], button[title="Menu" i]') ??
            document.querySelector('[data-part="topbar"] button:last-of-type');
        menu?.click();
        setTimeout(() => {
            const rows = [...document.querySelectorAll("button, a, [role=menuitem], [role=button]")];
            const row = rows.find((r) => /^extensions$/i.test((r.textContent ?? "").trim()));
            if (row) row.click();
            else pocket.notify?.("warning", "Extensions is not in the menu yet. Open it again from Menu.");
        }, 120);
    }

    async function openExtensions() {
        const m = await loadStore();
        if (typeof m.openSheet === "function") {
            try {
                m.openSheet({ type: "extensions" });
                return;
            } catch {}
        }
        throughTheMenu();
    }

    // The app draws this button (it is what Appearance → Layout lists); the stylesheet below hides it, and the button
    // drawn here takes its place. Keep it registered: without it, a version that cannot draw its own has nothing.
    pocket.rail({ id: "extensions", title: "Extensions", iconPath: BLOCKS, run: openExtensions });

    // ---------- Its place: below the theme button, by order alone ----------
    // The app draws the rail and its buttons; every redraw puts extensions' buttons together above its own bottom ones.
    // Rather than move or copy a button (a copy is left behind at each redraw, and two modules doing it clash), the
    // rail's extension group joins the rail's own column with `display: contents`, and a CSS `order` puts these two
    // buttons after the theme button and before the person's. Nothing in the page is added, moved, or hidden.

    const style = document.createElement("style");
    style.id = "ext-button-css";
    style.textContent = [
        "nav[data-part='rail'] .rail-exts{display:contents}",
        "nav[data-part='rail'] button.rail-ext[title='Extensions']{order:91}",
        "nav[data-part='rail'] button.rail-me{order:120}",
    ].join("\n");
    document.head.append(style);

    pocket.launcher({
        id: "extensions",
        label: "Extensions…",
        detail: "Extensions button",
        iconPath: BLOCKS,
        keywords: ["extensions", "modules", "turn on", "plugin"],
        run: openExtensions,
    });

    return () => style.remove();
}
