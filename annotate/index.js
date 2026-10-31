/**
 * Annotate's browser module: a sheet with a canvas. A tap on an image attached in the message box opens that image
 * here; a finger circles what matters, and Done puts the marked picture back into the message box as the attachment
 * itself, with no words added. The conversation stays behind the sheet, as it was.
 */
export const pocketApi = 1;

/** A pencil, as a 24 × 24 stroked path, like the app's own icons. */
const PENCIL = "M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19zM13.5 6.5l3 3";
/** A rectangle, for the wider screens' second tool. */
const BOX = "M4 6h16v12H4z";
/** Redo: the app's undo arrow, mirrored. */
const REDO = "M15 14L20 9l-5-5M20 9H9a5 5 0 000 10h4";

/** The export's longest side, in pixels: Pi reads an image of 2000 px a side at most. */
const MAX_SIDE = 2000;
/** A stroke's width, as a part of the image's shorter side: thin, medium, bold. */
const WIDTHS = [0.004, 0.009, 0.016];
const WIDTH_NAMES = ["Thin", "Medium", "Bold"];
const WIDTH_DOTS = [7, 11, 17];
const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0091ff", "#ffffff", "#111111"];
/** How long to wait for the message box to take the marked picture. */
const DELIVER_MS = 10_000;

// ─── Drawing ────────────────────────────────────────────────────────────────────

/**
 * One mark on a canvas of `w` by `h`: its points are parts of the image's width and height, from 0 to 1. A pen is a
 * line through them; a rectangle is the box that its first two points make.
 */
function stroke(ctx, wire, w, h) {
    const unit = Math.min(w, h);
    const points = wire.points;

    if (points.length === 0) {
        return;
    }

    ctx.save();
    ctx.strokeStyle = wire.color;
    ctx.fillStyle = wire.color;
    ctx.lineWidth = Math.max(1.5, wire.width * unit);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (wire.kind === "rect") {
        const start = points[0];
        const finish = points[1] ?? points[0];

        ctx.strokeRect(
            Math.min(start[0], finish[0]) * w,
            Math.min(start[1], finish[1]) * h,
            Math.abs(finish[0] - start[0]) * w,
            Math.abs(finish[1] - start[1]) * h,
        );
        ctx.restore();

        return;
    }

    if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0][0] * w, points[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        return;
    }

    // A curve through the middle of every pair of points: a finger's steps look like one line.
    ctx.beginPath();
    ctx.moveTo(points[0][0] * w, points[0][1] * h);

    for (let index = 1; index < points.length - 1; index += 1) {
        const [x, y] = points[index];
        const [nextX, nextY] = points[index + 1];

        ctx.quadraticCurveTo(x * w, y * h, ((x + nextX) / 2) * w, ((y + nextY) / 2) * h);
    }

    const last = points[points.length - 1];

    ctx.lineTo(last[0] * w, last[1] * h);
    ctx.stroke();
    ctx.restore();
}

/** The whole picture: the image, then the strokes over it. */
function paint(canvas, image, wires) {
    const ctx = canvas.getContext("2d");

    if (ctx === null) {
        return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const wire of wires) {
        stroke(ctx, wire, canvas.width, canvas.height);
    }
}

/** The image with its marks on it, as a JPEG: as large as it can be, and no larger than `most` bytes. */
async function picture(image, wires, { side, most }) {
    const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));

    for (const shrink of [1, 0.9, 0.8, 0.7]) {
        const canvas = document.createElement("canvas");

        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale * shrink));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale * shrink));

        const ctx = canvas.getContext("2d");

        // A JPEG has no transparency: a PNG's clear parts are white, as they are on the page.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        for (const wire of wires) {
            stroke(ctx, wire, canvas.width, canvas.height);
        }

        const blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.92));

        if (blob !== null && blob.size <= most) {
            return blob;
        }
    }

    throw new Error("This image is too large to send.");
}

/** A blob as base64, without its data header: what the fallback route takes. */
function base64(blob) {
    return new Promise((done, fail) => {
        const reader = new FileReader();

        reader.onload = () => {
            const result = String(reader.result ?? "");
            const comma = result.indexOf(",");

            done(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.onerror = () => fail(new Error("This image could not be read."));
        reader.readAsDataURL(blob);
    });
}

// ─── The message box's attachments ──────────────────────────────────────────────

const chips = () => [...document.querySelectorAll(".chip")];
const nameOf = (chip) => chip.querySelector(".chip-name")?.textContent?.trim() ?? "";
const thumbOf = (chip) => chip.querySelector("img.chip-thumb");
const removeButton = (chip) =>
    chip.querySelector('button[aria-label^="Remove "]') ?? chip.querySelector("button.small") ?? null;

/** Whether the app has taken the file already: its spinner for the upload has gone. */
const uploaded = (chip) =>
    chip.querySelector("img.chip-thumb") !== null && chip.querySelector(".spinner") === null;

/**
 * Give the app a file as a drop does, so its own upload and its own chip do the work. `false` when there is no message
 * box to take it.
 */
function deliver(file) {
    const box = document.querySelector("footer textarea") ?? document.querySelector("textarea");

    if (box === null) {
        return false;
    }

    const data = new DataTransfer();

    data.items.add(file);

    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });

    // The sheet's own paste and drop handlers take images for the canvas: this one is not for them.
    drop.annotateDelivery = true;
    box.dispatchEvent(drop);

    return true;
}

/** The chip that the app made for the file just delivered, once it is on the server. */
async function took(name, before) {
    const until = Date.now() + DELIVER_MS;

    while (Date.now() < until) {
        const now = chips();
        const made =
            now.find((chip) => !before.has(chip) && nameOf(chip) === name && uploaded(chip)) ??
            now.find((chip) => !before.has(chip) && uploaded(chip));

        if (made !== undefined) {
            return made;
        }

        await new Promise((next) => setTimeout(next, 120));
    }

    return null;
}

/** Take the marked image's place from the attachment it came from: one picture in the message, the marked one. */
function replace(chipName, made) {
    for (const chip of chips()) {
        if (chip !== made && nameOf(chip) === chipName) {
            removeButton(chip)?.click();
        }
    }
}

/** What goes into the message box when the app does not take the picture: its path, which Pi reads itself. */
function fallbackText(path) {
    return `I marked up this image: ${path}`;
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState, Icon, Spinner } = pocket;

    pocket.style("annotate.css");

    function Annotate({ close, url, chipName }) {
        const fromChip = typeof chipName === "string" && chipName !== "";

        const [image, setImage] = useState(null);
        const [mode, setMode] = useState("view");
        const [wires, setWires] = useState([]);
        const [past, setPast] = useState([]);
        const [future, setFuture] = useState([]);
        const [color, setColor] = useState(COLORS[0]);
        const [width, setWidth] = useState(WIDTHS[1]);
        const [tool, setTool] = useState("pen");
        const [busy, setBusy] = useState(false);
        const [leaving, setLeaving] = useState(false);
        const [error, setError] = useState(null);
        const [recent, setRecent] = useState([]);
        const [box, setBox] = useState({ width: 0, height: 0 });

        const leaveTimer = useRef(null);
        const stageRef = useRef(null);
        const canvasRef = useRef(null);
        const fileRef = useRef(null);
        const wireRef = useRef(null);
        const urlRef = useRef(null);
        /** What the handlers read: the values of this drawing, without a new one for each change. */
        const now = useRef({});

        now.current = { image, mode, wires, color, width, tool };

        /** Close the way a sheet closes on an iPhone: it slides down over a third of a second, then it goes. */
        function leave() {
            setLeaving((going) => {
                if (!going) {
                    clearTimeout(leaveTimer.current);
                    leaveTimer.current = setTimeout(close, 380);
                }

                return true;
            });
        }

        useEffect(() => () => clearTimeout(leaveTimer.current), []);

        /** Draw the image and every mark again, on the canvas as it is now. */
        const redraw = () => {
            const canvas = canvasRef.current;
            const { image: shown, wires: drawn } = now.current;

            if (canvas === null || shown === null) {
                return;
            }

            paint(canvas, shown, wireRef.current === null ? drawn : [...drawn, wireRef.current]);
        };

        // The stage's size: a phone turned, a keyboard shown, or the tools in place of nothing.
        useEffect(() => {
            const stage = stageRef.current;

            if (stage === null) {
                return undefined;
            }

            let frame = 0;
            const measure = () => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() =>
                    setBox({ width: stage.clientWidth, height: stage.clientHeight }),
                );
            };

            measure();

            const observer = new ResizeObserver(measure);

            observer.observe(stage);

            return () => {
                cancelAnimationFrame(frame);
                observer.disconnect();
            };
        }, [image]);

        // The biggest canvas that fits the stage, and keeps the image's shape.
        const fit =
            image !== null && box.width > 0 && box.height > 0
                ? Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight)
                : 0;
        const cssWidth = image === null ? 0 : Math.max(1, Math.round(image.naturalWidth * fit));
        const cssHeight = image === null ? 0 : Math.max(1, Math.round(image.naturalHeight * fit));
        const density = Math.max(
            1,
            Math.min(window.devicePixelRatio || 1, 1600 / Math.max(cssWidth, cssHeight, 1)),
        );
        const pixelWidth = Math.max(1, Math.round(cssWidth * density));
        const pixelHeight = Math.max(1, Math.round(cssHeight * density));

        // The canvas keeps the image and its marks: a new size, or a mark undone or drawn, draws it all again.
        useEffect(() => {
            const canvas = canvasRef.current;

            if (canvas === null || image === null) {
                return;
            }

            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
            redraw();
        }, [image, wires, pixelWidth, pixelHeight]);

        // The image that the tap on an attachment chose.
        useEffect(() => {
            if (typeof url === "string" && url !== "") {
                show(url, url.startsWith("blob:"));
            }
        }, []);

        // A finger that draws on the picture keeps the sheet in place: the app's drag closes a sheet that a finger
        // pulls down, and a stroke is not a pull.
        useEffect(() => {
            const stage = stageRef.current;

            if (stage === null) {
                return undefined;
            }

            const stop = (event) => {
                if (now.current.mode === "draw") {
                    event.stopPropagation();
                }
            };

            stage.addEventListener("touchstart", stop, { passive: true });
            stage.addEventListener("touchmove", stop, { passive: true });

            return () => {
                stage.removeEventListener("touchstart", stop);
                stage.removeEventListener("touchmove", stop);
            };
        }, [image, mode]);

        // The newest images of this session: the ones that a person attached here.
        useEffect(() => {
            const id = pocket.conversationId();

            if (id === null) {
                return undefined;
            }

            let live = true;

            pocket.api(`recent?conversation=${id}`).then(
                (answer) => {
                    if (live) {
                        setRecent(Array.isArray(answer?.images) ? answer.images : []);
                    }
                },
                () => {},
            );

            return () => {
                live = false;
            };
        }, []);

        // An image pasted or dropped anywhere on the sheet, not only on its own button.
        useEffect(() => {
            const take = (transfer) => {
                if (transfer === null || transfer === undefined) {
                    return false;
                }

                const image = [...(transfer.files ?? [])].find((each) => each.type.startsWith("image/"));

                if (image !== undefined) {
                    pick(image);

                    return true;
                }

                for (const item of [...(transfer.items ?? [])]) {
                    if (item.kind === "file" && item.type.startsWith("image/")) {
                        const file = item.getAsFile();

                        if (file !== null) {
                            pick(file);

                            return true;
                        }
                    }
                }

                return false;
            };
            const onPaste = (event) => {
                if (take(event.clipboardData)) {
                    event.preventDefault();
                }
            };
            const onDrop = (event) => {
                // The sheet gives the message box a file of its own, and that is not one to draw on.
                if (event.annotateDelivery === true) {
                    return;
                }

                if (take(event.dataTransfer)) {
                    event.preventDefault();
                }
            };
            const onOver = (event) => {
                if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
                    event.preventDefault();
                }
            };

            document.addEventListener("paste", onPaste);
            document.addEventListener("drop", onDrop);
            document.addEventListener("dragover", onOver);

            return () => {
                document.removeEventListener("paste", onPaste);
                document.removeEventListener("drop", onDrop);
                document.removeEventListener("dragover", onOver);
                URL.revokeObjectURL(urlRef.current ?? "");
            };
        }, []);

        /** Show an image on the sheet: from the device, or from the session. */
        function show(source, temporary) {
            setError(null);

            const next = new window.Image();

            next.decoding = "async";
            next.onload = () => {
                if (urlRef.current !== null && urlRef.current !== source) {
                    URL.revokeObjectURL(urlRef.current);
                }

                urlRef.current = temporary ? source : null;
                setImage(next);
                setWires([]);
                setPast([]);
                setFuture([]);
                setMode("view");
            };
            next.onerror = () => setError("That image could not be opened. Try another one.");
            next.src = source;
        }

        /** A file from the device, or from a paste or a drop. */
        function pick(file) {
            if (!file.type.startsWith("image/")) {
                setError("That file is not an image.");
                return;
            }

            show(URL.createObjectURL(file), true);
        }

        /** One more change to the marks, kept for Undo. */
        function commit(next) {
            setPast((list) => [...list, now.current.wires].slice(-100));
            setWires(next);
            setFuture([]);
        }

        function undo() {
            if (past.length === 0) {
                return;
            }

            setPast(past.slice(0, -1));
            setWires(past[past.length - 1]);
            setFuture([now.current.wires, ...future]);
        }

        function again() {
            if (future.length === 0) {
                return;
            }

            const [next, ...rest] = future;

            setPast((kept) => [...kept, now.current.wires]);
            setWires(next);
            setFuture(rest);
        }

        /** Where a press is on the image: a part of its width and height, from 0 to 1. */
        function pointAt(event) {
            const rect = canvasRef.current.getBoundingClientRect();

            return [
                Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
                Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
            ];
        }

        function start(event) {
            if (now.current.mode !== "draw" || now.current.image === null) {
                return;
            }

            // One finger draws: a second one does not start a stroke of its own.
            if (event.button > 0 || wireRef.current !== null) {
                return;
            }

            event.preventDefault();

            try {
                event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
                // A pointer that is not active anymore: the marks go on without it.
            }

            wireRef.current = {
                kind: now.current.tool,
                color: now.current.color,
                width: now.current.width,
                points: [pointAt(event), pointAt(event)],
            };
            redraw();
        }

        function move(event) {
            const wire = wireRef.current;

            if (wire === null) {
                return;
            }

            event.preventDefault();

            const points =
                typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];

            for (const each of points.length === 0 ? [event] : points) {
                if (wire.kind === "rect") {
                    wire.points[1] = pointAt(each);
                } else if (wire.points.length < 4000) {
                    // A long stroke keeps enough points to look smooth, and not thousands.
                    wire.points.push(pointAt(each));
                }
            }

            redraw();
        }

        function end() {
            const wire = wireRef.current;

            if (wire === null) {
                return;
            }

            wireRef.current = null;

            if (wire.kind === "rect") {
                const [start, finish] = wire.points;

                if (Math.abs(finish[0] - start[0]) < 0.02 && Math.abs(finish[1] - start[1]) < 0.02) {
                    commit([...now.current.wires]);
                    redraw();

                    return;
                }
            }

            commit([...now.current.wires, wire]);
        }

        /**
         * Put the marked picture into the message box as an attachment: the app's own upload takes it, and the
         * attachment it came from goes. No words are added to the message box.
         */
        async function apply() {
            const shown = now.current.image;

            if (shown === null || busy) {
                return;
            }

            const marks = now.current.wires;

            if (fromChip && marks.length === 0) {
                // Marked nothing: the image is already in the message box as it is.
                leave();
                return;
            }

            setBusy(true);
            setError(null);

            const name = `${(chipName ?? "image").replace(/\.[^.]+$/, "")}-marked.jpg`;
            const before = new Set(chips());

            try {
                const blob = await picture(shown, marks, { side: MAX_SIDE, most: 8_000_000 });

                if (deliver(new File([blob], name, { type: blob.type }))) {
                    // Gone already, the way a sheet goes: the app uploads the picture behind it, and the attachment it
                    // came from makes way for it.
                    leave();

                    const made = await took(name, before);

                    if (made !== null) {
                        if (fromChip) {
                            replace(chipName, made);
                        }

                        return;
                    }
                }

                // The app did not take it: save the picture, and let Pi read it by its path.
                const small = await picture(shown, marks, { side: 1600, most: 480_000 });
                const saved = await pocket.api("save", { image: await base64(small) });

                if (typeof saved?.path !== "string") {
                    throw new Error("The server did not save the image.");
                }

                pocket.insertText(fallbackText(saved.path));
                pocket.notify("warning", "The marked image went into the message as its path: Pi reads it there.");
                leave();
            } catch (failure) {
                setError(failure?.message ?? "The image could not be added.");
            } finally {
                setBusy(false);
            }
        }

        const choose = () => fileRef.current?.click();
        const picker = html`<input
            ref=${fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange=${(event) => {
                const file = event.currentTarget.files?.[0];

                event.currentTarget.value = "";

                if (file !== undefined) {
                    pick(file);
                }
            }}
        />`;

        if (image === null) {
            return html`<div class=${`ann-root${leaving ? " leaving" : ""}`}>
                ${error === null ? null : html`<div class="error-box">${error}</div>`}
                <div class="ann-line">
                    <button
                        class="ann-plain-corner"
                        title="Close"
                        aria-label="Close"
                        onClick=${leave}
                    >
                        <${Icon} name="close" size=${20} />
                    </button>
                </div>
                ${picker}
                <button class="ann-drop" onClick=${choose}>
                    <span class="ann-drop-icon"><${Icon} name="plus" size=${22} /></span>
                    <span>
                        <strong>Choose an image</strong>
                        <span class="ann-sub">A photo, a screenshot, a design</span>
                    </span>
                </button>
                <p class="ann-hint">You can also paste an image (⌘V or Ctrl+V), or drop one here.</p>
                ${recent.length === 0
                    ? null
                    : html`<h3 class="ann-heading">Attached in this session</h3>
                          <div class="ann-grid">
                              ${recent.map(
                                  (each) =>
                                      html`<button
                                          class="ann-thumb"
                                          title=${each.label ?? each.name}
                                          onClick=${() => show(each.url, false)}
                                      >
                                          <img src=${each.url} alt="" loading="lazy" />
                                      </button>`,
                              )}
                          </div>`}
            </div>`;
        }

        return html`<div class=${`ann-root${leaving ? " leaving" : ""}`}>
            ${error === null ? null : html`<div class="error-box">${error}</div>`}
            ${picker}
            <div class="ann-stage" ref=${stageRef} data-no-swipe>
                <canvas
                    ref=${canvasRef}
                    class=${`ann-canvas ${mode}`}
                    width=${pixelWidth}
                    height=${pixelHeight}
                    style=${`width:${cssWidth}px;height:${cssHeight}px`}
                    onPointerDown=${start}
                    onPointerMove=${move}
                    onPointerUp=${end}
                    onPointerCancel=${end}
                    onPointerLeave=${end}
                />
                <button class="ann-corner left" title="Close" aria-label="Close" onClick=${leave}>
                    <${Icon} name="close" size=${20} />
                </button>
                ${mode === "draw"
                    ? html`<button
                          class="ann-corner right apply"
                          title="Done"
                          aria-label="Done"
                          disabled=${busy}
                          onClick=${apply}
                      >
                          ${busy ? html`<${Spinner} />` : html`<${Icon} name="check" size=${20} />`}
                      </button>`
                    : html`<button
                          class="ann-corner right"
                          title="Draw on the image"
                          aria-label="Draw on the image"
                          onClick=${() => setMode("draw")}
                      >
                          <${Icon} path=${PENCIL} size=${20} />
                      </button>`}
                ${mode === "draw" || wires.length === 0
                    ? null
                    : html`<span class="ann-count"
                          >${wires.length === 1 ? "1 mark" : `${wires.length} marks`}</span
                      >`}
            </div>
            ${mode === "draw"
                ? html`<div class="ann-panel">
                      <div class="ann-line">
                          <div class="ann-tools">
                              <button
                                  class=${`ann-tool${tool === "pen" ? " on" : ""}`}
                                  title="Pen"
                                  aria-label="Pen"
                                  onClick=${() => setTool("pen")}
                              >
                                  <${Icon} path=${PENCIL} size=${18} />
                              </button>
                              <button
                                  class=${`ann-tool${tool === "rect" ? " on" : ""}`}
                                  title="Rectangle"
                                  aria-label="Rectangle"
                                  onClick=${() => setTool("rect")}
                              >
                                  <${Icon} path=${BOX} size=${18} />
                              </button>
                          </div>
                          <div class="ann-colors">
                              ${COLORS.map(
                                  (each) =>
                                      html`<button
                                          class=${`ann-color${each === color ? " on" : ""}`}
                                          style=${`--ann-color:${each}`}
                                          title=${each}
                                          aria-label=${`Pen color ${each}`}
                                          onClick=${() => setColor(each)}
                                      />`,
                              )}
                          </div>
                          <div class="ann-widths">
                              ${WIDTHS.map(
                                  (each, index) =>
                                      html`<button
                                          class=${`ann-width${each === width ? " on" : ""}`}
                                          title=${WIDTH_NAMES[index]}
                                          aria-label=${`${WIDTH_NAMES[index]} pen`}
                                          onClick=${() => setWidth(each)}
                                      >
                                          <span
                                              style=${`width:${WIDTH_DOTS[index]}px;height:${WIDTH_DOTS[index]}px`}
                                          />
                                      </button>`,
                              )}
                          </div>
                      </div>
                      <div class="ann-line">
                          <button
                              class="ann-icon"
                              title="Undo"
                              aria-label="Undo"
                              disabled=${past.length === 0}
                              onClick=${undo}
                          >
                              <${Icon} name="undo" size=${19} />
                          </button>
                          <button
                              class="ann-icon"
                              title="Redo"
                              aria-label="Redo"
                              disabled=${future.length === 0}
                              onClick=${again}
                          >
                              <${Icon} path=${REDO} size=${19} />
                          </button>
                          <button
                              class="ann-icon"
                              title="Clear the marks"
                              aria-label="Clear the marks"
                              disabled=${wires.length === 0}
                              onClick=${() => commit([])}
                          >
                              <${Icon} name="close" size=${19} />
                          </button>
                      </div>
                  </div>`
                : fromChip
                  ? null
                  : html`<div class="ann-panel">
                        <div class="ann-line">
                            <button class="button primary ann-done" disabled=${busy} onClick=${apply}>
                                ${busy ? html`<${Spinner} />` : null} Add to message
                            </button>
                        </div>
                    </div>`}
        </div>`;
    }

    pocket.sheet({ id: "annotate", title: "Annotate", component: Annotate, wide: true });

    pocket.menu({ id: "annotate", label: "Annotate an image", hint: "draw, then send", sheet: "annotate" });
    pocket.launcher({
        id: "annotate",
        label: "Annotate an image",
        detail: "circle what you mean",
        keywords: ["draw", "circle", "mark up", "image", "screenshot", "photo"],
        iconPath: PENCIL,
        sheet: "annotate",
    });

    // A tap on an image attached in the message box opens it here: that is the way in, so the message box keeps its
    // own buttons. The chip does nothing else under a tap, so this takes nothing from the app, and the sheet leaves
    // the conversation, its draft, and its attachments as they were.
    const onTap = (event) => {
        const target = event.target;

        if (!(target instanceof Element) || target.closest("button") !== null) {
            return;
        }

        const chip = target.closest(".chip");
        const thumb = chip === null ? null : thumbOf(chip);
        const url = thumb === null ? "" : thumb.currentSrc || thumb.src;

        if (url === "") {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        pocket.openSheet("annotate", { url, chipName: nameOf(chip) });
    };

    document.addEventListener("click", onTap, true);
    pocket.onDispose(() => document.removeEventListener("click", onTap, true));
}
