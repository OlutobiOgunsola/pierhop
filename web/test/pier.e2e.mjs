// End-to-end test: four people in separate browser sessions, against a real
// pier server. Run against `npx wrangler dev --port 8787` (or the live site via
// BASE=https://...) and a Chrome started with --remote-debugging-port=9336:
//   node --experimental-websocket web/test/pier.e2e.mjs
const BASE = process.env.BASE || "http://127.0.0.1:8787", CDP = process.env.CDP || "http://127.0.0.1:9336";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, detail = "") => { if (!cond) failures++; console.log((cond ? "PASS " : "FAIL ") + label + (detail ? "  " + detail : "")); };

const version = await (await fetch(CDP + "/json/version")).json();
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let bid = 0; const bpending = new Map();
bws.onmessage = (m) => { const d = JSON.parse(m.data); bpending.get(d.id)?.(d); };
const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bpending.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });

// Everything that crosses the pier server, from every browser, for the privacy check.
const serverTraffic = [];

// Each person gets their own browser context (separate storage), like separate devices.
async function person(label) {
  const ctx = (await bsend("Target.createBrowserContext")).result.browserContextId;
  const { targetId } = (await bsend("Target.createTarget", { url: "about:blank", browserContextId: ctx })).result;
  const ws = new WebSocket(`${CDP.replace("http", "ws")}/devtools/page/${targetId}`);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
    if (d.method === "Network.webSocketFrameSent" || d.method === "Network.webSocketFrameReceived") serverTraffic.push(d.params.response.payloadData);
    if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: 1e9 + Math.floor(Math.random() * 1e6), method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    if (d.method === "Runtime.exceptionThrown") console.log(`  [${label} error]`, d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await bsend("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: ctx });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(label + ": " + expr.slice(0, 60) + " -> " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await ev(expr)) return true; } catch {} await sleep(150); }
    const state = await ev(`JSON.stringify({ screens: ["s-name","s-wait","s-msg","s-room"].filter(id => !document.getElementById(id).hidden), ws: ws && ws.readyState, peers: [...peers.values()].map(p => ({ name: p.name, pc: p.pc && p.pc.connectionState, ctl: p.ctl && p.ctl.readyState, blocked: p.blocked })), transfers: [...transfers.values()].map(t => [t.name, t.status, t.done, t.error]) })`).catch((e) => String(e));
    throw new Error(`${label}: timed out waiting for ${what}\n  state: ${state}`);
  };
  const open = (url) => send("Page.navigate", { url });
  const join = async (name) => {
    await until(`!document.getElementById("s-name").hidden`, "name screen");
    await ev(`document.getElementById("name").value = ${JSON.stringify(name)}; document.getElementById("name-form").requestSubmit(); true`);
  };
  const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  const reload = () => send("Page.reload");
  return { label, ev, until, open, join, text, reload };
}

// Deterministic file bytes, so a sender who refreshes can share the very same file again.
const makeFile = (name, bytes, seed) => `(() => {
  const data = new Uint8Array(${bytes}); let x = ${seed} >>> 0 || 1;
  for (let i = 0; i < data.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data[i] = x & 255; }
  const f = new File([data], ${JSON.stringify(name)}, { lastModified: 1700000000000 + ${seed} });
  shareFiles([f]); return true; })()`;
const checksum = `async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return b.length + ":" + h.toString(16); }`;
const expected = (bytes, seed) => { const data = new Uint8Array(bytes); let x = seed >>> 0 || 1; for (let i = 0; i < data.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data[i] = x & 255; } let h = 0x811c9dc5; for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193) >>> 0; } return bytes + ":" + h.toString(16); };
const startDownload = (who, fileName) => `(() => {
  const p = [...peers.values()].find(p => p.name === ${JSON.stringify(who)});
  window.save = () => {};
  download(p, p.files.find(f => f.name === ${JSON.stringify(fileName)})); return true; })()`;
const progress = (fileName) => `(() => { const t = [...transfers.values()].find(t => t.dir === "down" && t.name === ${JSON.stringify(fileName)}); return t ? t.done / t.size : 0; })()`;
const finished = (fileName) => `(() => { const t = [...transfers.values()].find(t => t.dir === "down" && t.name === ${JSON.stringify(fileName)}); return t && t.status === "done"; })()`;
const resultOf = (fileName) => `(async () => { const t = [...transfers.values()].find(t => t.dir === "down" && t.name === ${JSON.stringify(fileName)}); return JSON.stringify({ sum: await (${checksum})(await (await fetch(t.url)).blob()), resumedFrom: t.resumedFrom || 0 }); })()`;
// Slow the sender down so there's time to cut things off mid-transfer.
const slow = (ms) => `(() => { if (!Blob.prototype._orig) Blob.prototype._orig = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = async function () { await new Promise(r => setTimeout(r, ${ms})); return this._orig(); }; return true; })()`;
const letIn = async (host, name) => {
  const row = `[...document.querySelectorAll("#requests .request")].find(r => r.querySelector(".who b").textContent === ${JSON.stringify(name)})`;
  await host.until(`!!${row}`, `${name}'s request`);
  await host.ev(`${row}.querySelector("button.primary").click(); true`);
};
const allConnected = (n) => `peers.size === ${n} && [...peers.values()].every(p => connected(p))`;

const host = await person("host"), amaka = await person("amaka"), bayo = await person("bayo"), chen = await person("chen");

// --- the basics ---
await host.open(BASE + "/new");
await host.join("Tobi");
await host.until(`!document.getElementById("s-room").hidden`, "room");
const link = await host.ev("pierLink()");
const code = new URL(link).pathname.slice(1);
const secret = new URL(link).hash.slice(1);
check("host creates a pier with a Meet-style code", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code), code);
check("the link carries a 256-bit key after the #", secret.length === 43, `${secret.length} chars`);

await amaka.open(BASE + "/" + code);
await amaka.until(`!document.getElementById("s-msg").hidden`, "incomplete-link screen");
check("a link without its key is refused", (await amaka.text("#msg-title")) === "This link is incomplete");

await amaka.open(link);
await amaka.until(`!document.getElementById("s-name").hidden`, "join screen");
check("guest sees whose pier it is", (await amaka.text("#name-title")) === "Join Tobi's pier", await amaka.text("#name-title"));
await amaka.join("Amaka");
await amaka.until(`!document.getElementById("s-wait").hidden`, "waiting screen");
await letIn(host, "Amaka");
await amaka.until(allConnected(1), "Amaka connected");
await host.until(allConnected(1), "host connected");
check("host lets a guest in and they connect directly", true);

await host.ev(makeFile("holiday-video.mp4", 5_300_000, 11));
await amaka.until(`[...peers.values()].some(p => p.files.some(f => f.name === "holiday-video.mp4"))`, "file list");
await amaka.ev(startDownload("Tobi", "holiday-video.mp4"));
await amaka.until(finished("holiday-video.mp4"), "download");
let r = JSON.parse(await amaka.ev(resultOf("holiday-video.mp4")));
check("host to guest: 5.3 MB arrives intact (decrypted)", r.sum === expected(5_300_000, 11), r.sum);

await amaka.ev(makeFile("receipt.pdf", 1_200_000, 22));
await host.until(`[...peers.values()].some(p => p.files.some(f => f.name === "receipt.pdf"))`, "guest file list");
await host.ev(startDownload("Amaka", "receipt.pdf"));
await host.until(finished("receipt.pdf"), "download back");
r = JSON.parse(await host.ev(resultOf("receipt.pdf")));
check("guest to host: files go both ways", r.sum === expected(1_200_000, 22), r.sum);

await bayo.open(link);
await bayo.join("Bayo");
await host.until(`document.querySelectorAll("#requests .request").length === 1`, "Bayo's request");
await host.ev(`[...document.querySelectorAll("#requests button")].find(b => b.textContent === "Deny").click(); true`);
await bayo.until(`!document.getElementById("s-msg").hidden`, "denied screen");
check("a denied guest is told, and sees nothing", (await bayo.text("#msg-title")) === "You weren't let in" && (await bayo.ev("peers.size")) === 0);

await chen.open(link);
await chen.join("Chen");
await letIn(host, "Chen");
await chen.until(allConnected(2), "Chen connected to both");
await chen.ev(startDownload("Amaka", "receipt.pdf"));
await chen.until(finished("receipt.pdf"), "guest to guest");
r = JSON.parse(await chen.ev(resultOf("receipt.pdf")));
check("guest to guest works too", r.sum === expected(1_200_000, 22));

// --- picking up where it stopped ---
const BIG = 24_000_000;
await host.ev(slow(6));
await host.ev(makeFile("wedding.zip", BIG, 33));
await amaka.until(`[...peers.values()].some(p => p.files.some(f => f.name === "wedding.zip"))`, "wedding.zip listed");
await amaka.ev(startDownload("Tobi", "wedding.zip"));
await amaka.until(`${progress("wedding.zip")} > 0.3`, "30% of wedding.zip", 60000);
// The direct connection dies, as when a phone switches networks.
await amaka.ev(`[...peers.values()].find(p => p.name === "Tobi").pc.close(); true`);
await amaka.until(`[...transfers.values()].some(t => t.name === "wedding.zip" && t.status === "paused")`, "paused");
check("a dropped connection pauses the download", true);
await amaka.until(finished("wedding.zip"), "resumed and finished", 90000);
r = JSON.parse(await amaka.ev(resultOf("wedding.zip")));
check("it reconnects and picks up where it stopped", r.resumedFrom > BIG * 0.25, `resumed at ${(r.resumedFrom / 1e6).toFixed(1)} MB`);
check("the resumed file is byte for byte correct", r.sum === expected(BIG, 33), r.sum);

// The receiver refreshes the page halfway through.
await chen.until(`[...peers.values()].some(p => p.files.some(f => f.name === "wedding.zip"))`, "Chen sees wedding.zip");
await chen.ev(startDownload("Tobi", "wedding.zip"));
await chen.until(`${progress("wedding.zip")} > 0.35`, "35% for Chen", 60000);
await chen.reload();
await chen.until(`!document.getElementById("s-room").hidden`, "Chen back in the room without knocking");
check("after a refresh, a guest comes straight back without knocking", (await host.ev(`document.querySelectorAll("#requests .request").length`)) === 0);
await chen.ev("window.save = () => {}; true");
await chen.until(finished("wedding.zip"), "Chen's download finished after refresh", 90000);
r = JSON.parse(await chen.ev(resultOf("wedding.zip")));
check("the receiver's refresh doesn't start it over", r.resumedFrom > BIG * 0.3, `resumed at ${(r.resumedFrom / 1e6).toFixed(1)} MB`);
check("and the file is byte for byte correct", r.sum === expected(BIG, 33), r.sum);

// The sender refreshes halfway through, then shares the same file again.
await amaka.ev(makeFile("photos.zip", BIG, 44));
await amaka.ev(slow(6));
await host.until(`[...peers.values()].some(p => p.files.some(f => f.name === "photos.zip"))`, "photos.zip listed");
await host.ev(startDownload("Amaka", "photos.zip"));
await host.until(`${progress("photos.zip")} > 0.3`, "30% of photos.zip", 60000);
await amaka.reload();
await amaka.until(`!document.getElementById("s-room").hidden && ${allConnected(2)}`, "Amaka back");
await host.until(`[...transfers.values()].some(t => t.name === "photos.zip" && t.status === "paused")`, "host's download paused");
check("when the sender leaves, the download waits", true);
await amaka.ev(makeFile("photos.zip", BIG, 44));
await host.until(finished("photos.zip"), "host's download finished after Amaka re-shared", 90000);
r = JSON.parse(await host.ev(resultOf("photos.zip")));
check("sharing the same file again picks up where it stopped", r.resumedFrom > BIG * 0.25, `resumed at ${(r.resumedFrom / 1e6).toFixed(1)} MB`);
check("and the file is byte for byte correct", r.sum === expected(BIG, 44), r.sum);

// --- privacy: what the server saw ---
const traffic = serverTraffic.join("\n");
const leaked = ["holiday-video", "receipt.pdf", "wedding.zip", "photos.zip", secret].filter((s) => traffic.includes(s));
check("no file names or keys ever reach the server", leaked.length === 0, `${serverTraffic.length} messages checked${leaked.length ? ", leaked: " + leaked : ""}`);
check("connection setup crossing the server is signed", serverTraffic.some((m) => m.includes('"sig"')));

// --- a malicious server can't step into the middle ---
// Dan's browser tampers with the DTLS fingerprint on its way through the
// server, which is what a server trying to intercept would have to do.
const dan = await person("dan");
await dan.open(link);
await dan.until(`!document.getElementById("s-name").hidden`, "Dan's join screen");
await dan.ev(`(() => { const orig = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.type === "signal" && m.data.sdp) { m.data.sdp.sdp = m.data.sdp.sdp.replace(/(a=fingerprint:sha-256 [0-9A-F:]+)([0-9A-F])/, (a, b, c) => b + (c === "0" ? "1" : "0")); d = JSON.stringify(m); } } catch {} return orig.call(this, d); }; return true; })()`);
await dan.join("Dan");
await letIn(host, "Dan");
await host.until(`[...peers.values()].some(p => p.name === "Dan" && p.blocked)`, "tampered connection blocked");
await sleep(2000);
check("a tampered connection is detected and refused", !(await host.ev(`connected([...peers.values()].find(p => p.name === "Dan"))`)));

// --- the rest of the room ---
await host.ev(`send({ type: "remove", id: [...peers.values()].find(p => p.name === "Chen").id }); true`);
await chen.until(`!document.getElementById("s-msg").hidden`, "removed screen");
check("host can remove someone", (await chen.text("#msg-title")) === "You were removed from this pier");
await chen.open("about:blank"); // the same URL again wouldn't reload the page
await chen.open(link);
await chen.until(`!document.getElementById("s-name").hidden`, "Chen has to knock again");
check("someone removed can't walk back in without asking", true);

await host.reload();
await host.until(`!document.getElementById("s-room").hidden && [...peers.values()].some(p => p.name === "Amaka" && connected(p))`, "host back after refresh", 30000);
check("host refreshes the page and the pier survives", true);

await host.ev(`document.getElementById("leave").click(); document.getElementById("leave").click(); true`);
await amaka.until(`!document.getElementById("s-msg").hidden`, "ended screen");
check("ending the pier tells everyone", (await amaka.text("#msg-title")) === "This pier has ended");
await bayo.open("about:blank");
await bayo.open(link);
await bayo.until(`!document.getElementById("s-msg").hidden && document.getElementById("msg-title").textContent === "This pier is closed"`, "closed screen");
check("an old link shows the pier is closed", (await bayo.text("#msg-title")) === "This pier is closed");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
