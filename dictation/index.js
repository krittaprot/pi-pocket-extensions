// Replaces the browser's SpeechRecognition with a streaming one backed by the dictation extension (local whisper.cpp or a
// cloud speech model), so the message box's own mic (and Alt+V) shows words live and gets a context-aware correction on stop.
export const pocketApi = 1;

const RATE = 16000;
const FLUSH_MS = 700;
const MAX_MS = 5 * 60_000;

const b64 = (pcm) => {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let text = "";

    for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
    }

    return btoa(text);
};

export default function setup(pocket) {
    const had = { plain: globalThis.SpeechRecognition, webkit: globalThis.webkitSpeechRecognition };
    let warmed = false;

    const warm = () => {
        if (!warmed) {
            warmed = true;
            pocket.api("warm", {}).catch(() => {
                warmed = false;
            });
        }
    };

    async function gather() {
        const boxes = [...document.querySelectorAll("textarea")].filter((box) => box.offsetParent !== null);
        const box = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement : boxes.at(-1);
        const context = { draft: box?.value ?? "", where: document.title || "", recent: [] };

        try {
            const page = await pocket.messages({ limit: 6 });

            context.recent = page.messages.map((message) => String(message.text ?? "").replace(/\s+/g, " ").slice(0, 300));
        } catch {
            // No session open, or not allowed: the draft alone is context.
        }

        return context;
    }

    class WhisperRecognition {
        lang = "";
        continuous = true;
        interimResults = true;
        maxAlternatives = 1;
        onresult = null;
        onerror = null;
        onend = null;
        onstart = null;
        onaudiostart = null;
        onspeechstart = null;

        #id = crypto.randomUUID();
        #stream = null;
        #context = null;
        #audio = null;
        #node = null;
        #source = null;
        #queue = [];
        #flushing = Promise.resolve();
        #timer = 0;
        #stopAt = 0;
        #state = "idle";
        #texts = [];
        #length = 0;
        #contextReady = null;
        #sent = 0;

        #fail(error) {
            this.onerror?.({ error });
        }

        #emit(texts, final) {
            this.#length = Math.max(this.#length, texts.length);

            const results = [];

            for (let index = 0; index < this.#length; index++) {
                const item = [{ transcript: texts[index] ?? "", confidence: 1 }];

                item.isFinal = final;
                results.push(item);
            }

            this.onresult?.({ resultIndex: 0, results });
        }

        async start() {
            if (this.#state !== "idle") {
                throw new DOMException("already started", "InvalidStateError");
            }

            this.#state = "listening";
            warm();
            this.#contextReady = gather().then((context) => (this.#context = context));

            try {
                this.#stream = await navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
            } catch (error) {
                this.#state = "idle";
                this.#fail(error?.name === "NotFoundError" ? "audio-capture" : "not-allowed");
                this.onend?.();

                return;
            }

            if (this.#state !== "listening") {
                this.#stream.getTracks().forEach((track) => track.stop());

                return;
            }

            const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
            let audio;

            try {
                audio = new Context({ sampleRate: RATE });
            } catch {
                audio = new Context();
            }

            this.#audio = audio;
            await audio.resume?.();

            const ratio = audio.sampleRate / RATE;
            let carry = 0;
            const source = audio.createMediaStreamSource(this.#stream);
            const node = audio.createScriptProcessor(4096, 1, 1);

            node.onaudioprocess = (event) => {
                const input = event.inputBuffer.getChannelData(0);
                const out = new Int16Array(Math.floor((input.length - carry) / ratio) + 1);
                let count = 0;

                for (let at = carry; at < input.length; at += ratio) {
                    const sample = Math.max(-1, Math.min(1, input[Math.floor(at)]));

                    out[count++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
                    carry = at + ratio - input.length;
                }

                this.#queue.push(out.subarray(0, count));
            };

            source.connect(node);
            node.connect(audio.destination);
            this.#source = source;
            this.#node = node;
            this.#stopAt = Date.now() + MAX_MS;
            this.#timer = setInterval(() => {
                if (Date.now() > this.#stopAt) {
                    this.stop();
                } else {
                    this.#flush(false);
                }
            }, FLUSH_MS);
            this.onstart?.();
            this.onaudiostart?.();
        }

        #take() {
            const total = this.#queue.reduce((sum, part) => sum + part.length, 0);
            const pcm = new Int16Array(total);
            let at = 0;

            for (const part of this.#queue) {
                pcm.set(part, at);
                at += part.length;
            }

            this.#queue = [];

            return pcm;
        }

        #flush(last, context) {
            const pcm = this.#take();

            // One request at a time, in order; audio that comes while one is out goes in the next.
            const run = async () => {
                if (this.#state === "dead") {
                    return null;
                }

                await this.#contextReady;

                // At most ~12 s a request, to stay under the route's size limit.
                const step = RATE * 12;
                let answer = null;

                for (let at = 0; at === 0 || at < pcm.length; at += step) {
                    const final = last && at + step >= pcm.length;
                    const slice = pcm.subarray(at, at + step);

                    if (!final && slice.length === 0) {
                        break;
                    }

                    answer = await pocket.api("push", {
                        id: this.#id,
                        pcm: slice.length ? b64(slice) : "",
                        last: final,
                        context: final || this.#sent++ === 0 ? (context ?? this.#context) : undefined,
                    });
                }

                return answer;
            };

            const job = this.#flushing.then(run);

            this.#flushing = job.then(
                (answer) => {
                    if (!last && answer?.segments && this.#state === "listening") {
                        const next = answer.segments;

                        if (JSON.stringify(next) !== JSON.stringify(this.#texts)) {
                            this.#texts = next;
                            this.#emit(next, false);
                        }
                    }
                },
                (error) => {
                    if (this.#state === "listening") {
                        this.#fail(error?.status === 503 ? "service-not-allowed" : "network");
                    }
                },
            );

            return job;
        }

        #release() {
            clearInterval(this.#timer);
            this.#node?.disconnect();
            this.#source?.disconnect();
            this.#stream?.getTracks().forEach((track) => track.stop());
            this.#audio?.close?.().catch(() => {});
            this.#node = this.#source = this.#stream = this.#audio = null;
        }

        async stop() {
            if (this.#state !== "listening") {
                return;
            }

            this.#state = "stopping";
            this.#release();

            // The words so far stay in the box while the server hears the end and fixes the whole text.
            try {
                const context = await gather().catch(() => this.#context);
                const answer = await this.#flush(true, context);
                const text = (answer?.text || answer?.raw || "").trim();

                if (this.#state !== "dead") {
                    this.#texts = text ? [text] : this.#texts;
                    this.#emit(this.#texts, true);
                }
            } catch (error) {
                if (this.#state !== "dead") {
                    this.#fail(error?.status === 503 ? "service-not-allowed" : "network");
                    this.#emit(this.#texts, true);
                }
            }

            this.#state = "idle";
            this.onend?.();
        }

        abort() {
            if (this.#state === "dead" || this.#state === "idle") {
                return;
            }

            const was = this.#state;

            this.#state = "dead";
            this.#release();
            pocket.api("push", { id: this.#id, drop: true }).catch(() => {});

            if (was !== "stopping") {
                this.onend?.();
            }
        }

        addEventListener() {}
        removeEventListener() {}
    }

    globalThis.SpeechRecognition = WhisperRecognition;
    globalThis.webkitSpeechRecognition = WhisperRecognition;
    pocket.onConversation?.((id) => id !== null && warm());

    return () => {
        globalThis.SpeechRecognition = had.plain;
        globalThis.webkitSpeechRecognition = had.webkit;

        if (had.plain === undefined) {
            delete globalThis.SpeechRecognition;
        }

        if (had.webkit === undefined) {
            delete globalThis.webkitSpeechRecognition;
        }
    };
}
