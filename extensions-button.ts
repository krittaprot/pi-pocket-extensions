/**
 * Extensions button: a rail button in the quick access sidebar that opens the Extensions manager in one tap, instead
 * of the menu's last rows.
 *
 * - The button sits in the rail with the other tools. It opens the app's own Extensions sheet, so everything in it (the
 *   toggle, the details, the gallery) works as before.
 * - It opens that sheet through the app's own `openSheet` (`/store.js`), which is not a public API. If an update
 *   changes it, the button falls back to opening the menu and clicking its "Extensions" row, so it still works.
 */
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 1;

export default function createExtensionsButton(_host: Host, web: Web) {
    web.client("extensions-button.js");
}
