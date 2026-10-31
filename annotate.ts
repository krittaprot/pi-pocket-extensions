/**
 * Annotate: draw on an image, then tell Pi about it. Adds a button to the message box that opens a full screen page,
 * where a person circles what to change or asks about, writes a note, and "Use in message" puts the marked-up image and
 * the note into the message box, ready to send.
 *
 * The page saves the marked-up image in the data folder, and the message holds its path: Pi reads it with its own read
 * tool. Recent images of the session (the ones attached in Pi Pocket) are offered on the page too.
 */
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The biggest image that the page may send: a route takes a JSON body of 1 MB at most. */
const MAX_BYTES = 4 * 1024 * 1024;
/** The newest files kept in the annotations folder; the older ones go. */
const KEEP = 400;
/** The formats that a browser can draw, and that Pi reads. */
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** What kind of image these bytes are, from its first bytes: a JPEG or a PNG, or nothing. */
function kindOf(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { ext: "jpg", mime: "image/jpeg" };
    }

    if (
        bytes.length > 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return { ext: "png", mime: "image/png" };
    }

    return undefined;
}

/** A name for a saved image: the time, and a few random characters, in the order they were made. */
function nameFor(ext) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const random = Math.random().toString(16).slice(2, 8);

    return `${stamp}-${random}.${ext}`;
}

/** A name that a person knows: the upload's own file name, without the prefix that Pi Pocket gives it. */
function plainName(name) {
    return name.replace(/^[a-z0-9]+-[0-9a-f]{6,}-/i, "");
}

export default function createAnnotate(host, web) {
    const folder = join(host.dataDir, "annotations");

    /** Some bytes, as a Buffer, from the base64 that the page sends. */
    function decode(value) {
        const text = value.replace(/^data:image\/[a-z+]+;base64,/i, "").replace(/\s+/g, "");

        if (text === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
            throw web.error(400, "Send the image as base64, without spaces.");
        }

        return Buffer.from(text, "base64");
    }

    /** The sessions that this person sees, or nothing when the server is too old for `sessions`. */
    function sees(request, id) {
        if (typeof request.sessions !== "function") {
            return true;
        }

        return request.sessions().some((each) => each.id === id);
    }

    /** Keep the newest images only: an annotation folder that only grows fills the disk. */
    async function prune() {
        try {
            const names = await readdir(folder);
            const files = [];

            for (const name of names) {
                if (!IMAGE.test(name)) {
                    continue;
                }

                try {
                    const info = await stat(join(folder, name));

                    if (info.isFile()) {
                        files.push({ name, at: info.mtimeMs });
                    }
                } catch {
                    // Gone already: nothing to count.
                }
            }

            files.sort((left, right) => right.at - left.at);

            for (const older of files.slice(KEEP)) {
                await unlink(join(folder, older.name)).catch(() => {});
            }
        } catch {
            // A folder that does not exist has nothing to prune.
        }
    }

    // POST /api/x/annotate/save: a marked-up image, as base64, saved in the data folder. Answers with its path.
    web.route("POST", "save", async (request) => {
        const bytes = decode(String(request.body.image ?? ""));

        if (bytes.length === 0) {
            throw web.error(400, "There is no image.");
        }

        if (bytes.length > MAX_BYTES) {
            throw web.error(413, "The image is too large. Choose a smaller one.");
        }

        const kind = kindOf(bytes);

        if (kind === undefined) {
            throw web.error(400, "Send a JPEG or a PNG image.");
        }

        await mkdir(folder, { recursive: true });

        const path = join(folder, nameFor(kind.ext));

        await writeFile(path, bytes, { mode: 0o600 });
        void prune();

        return { path, mime: kind.mime, bytes: bytes.length };
    });

    // GET /api/x/annotate/recent?conversation=12: the newest images that the person attached in that session.
    web.route("GET", "recent", async (request) => {
        const id = Number(request.query.get("conversation") ?? "");

        if (!Number.isSafeInteger(id) || id <= 0 || !sees(request, id)) {
            return { images: [] };
        }

        const directory = join(host.dataDir, "uploads", String(id));
        let names;

        try {
            names = await readdir(directory);
        } catch {
            return { images: [] };
        }

        const found = [];

        for (const name of names) {
            if (!IMAGE.test(name) || name.startsWith(".")) {
                continue;
            }

            try {
                const file = join(directory, name);
                const info = await stat(file);

                if (info.isFile()) {
                    found.push({ name, path: file, at: info.mtimeMs });
                }
            } catch {
                // Gone already: not offered.
            }
        }

        found.sort((left, right) => right.at - left.at);

        return {
            images: found.slice(0, 24).map((each) => ({
                name: each.name,
                label: plainName(each.name),
                path: each.path,
                url: `/api/c/${id}/file?path=${encodeURIComponent(each.path)}`,
            })),
        };
    });

    // The browser module beside this file: the page, its button, and the drawing itself.
    web.client("annotate");
}
