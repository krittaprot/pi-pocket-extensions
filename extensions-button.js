// Extensions button, the browser part: a rail button that opens the app's Extensions manager.
//
// The rail is drawn by the app, which puts modules' buttons above its own bottom ones (Devices, Providers, Theme,
// you). A CSS `order` puts this button where the person wants it; nothing in the page is added, moved, or hidden, and
// the module imports nothing of the app's.
export const pocketApi = 1;

/** Blocks, as an app's extensions are drawn: two overlapping tiles. One path, as the app's Icon draws one. */
const BLOCKS =
    "M10 22V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H2" +
    "M15 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z";

export default function setup(pocket) {
    /**
     * The app draws the Extensions sheet, and it gives no public way to open one of its own sheets (`pocket.openSheet`
     * opens this module's). So the button walks there the way a person does, in two steps, and taps the app's own row:
     *
     * - In a conversation, the top bar's Menu button, then the menu's row "Extensions".
     * - On the home screen, which has no Menu button, the "Launcher" button, then its row "Extensions".
     *
     * The rows are found by what they say, never by a class of the app's. This module's own row in the launcher says
     * "Extensions…", so it is never the one that is tapped. A row shows for a frame at most.
     */
    const EXTENSIONS_ROW = (each) => {
        const label = (each.getAttribute("aria-label") ?? each.textContent ?? "").trim();

        // The app's own rows say just that; a row with a hint after it, or another label, is not this one.
        return /^extensions$/i.test(label.split(",")[0].trim());
    };
    const MENU_ROW = (each) => /^extensions(\s|$)/i.test((each.textContent ?? "").trim());

    function openExtensions() {
        const menu = document.querySelector('[data-part="topbar"] button[aria-label="Menu" i]');
        const launcher = [...document.querySelectorAll('[data-part="home-actions"] button')].find((each) =>
            /^launcher/i.test((each.textContent ?? "").trim()),
        );

        if (menu && menu.getAttribute("aria-expanded") !== "true") {
            menu.click();
        } else if (menu === null) {
            if (!launcher) {
                pocket.notify?.("warning", "Open Extensions from the Menu: this page has no button for it.");
                return;
            }
            launcher.click();
        }

        let tries = 0;
        const tapRow = () => {
            const row =
                [...document.querySelectorAll('[data-part="launcher-row"]')].find(EXTENSIONS_ROW) ??
                [...document.querySelectorAll('[data-part="sheet-body"] button.list-item')].find(MENU_ROW);

            if (row) {
                row.click();
                return;
            }

            if (++tries < 30) requestAnimationFrame(tapRow);
            else pocket.notify?.("warning", "Extensions did not open. Try again from the Menu.");
        };
        requestAnimationFrame(tapRow);
    }

    // Pocket draws this button, from this registration (it is what Appearance → Layout lists).
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
