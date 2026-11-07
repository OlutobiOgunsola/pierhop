// Run against `npx wrangler dev --port 8787` and a Chrome started with --remote-debugging-port=9336.
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

// Each person gets their own browser context (separate storage), like separate devices.
async function person(label) {
  const ctx = (await bsend("Target.createBrowserContext")).result.browserContextId;
  const { targetId } = (await bsend("Target.createTarget", { url: "about:blank", browserContextId: ctx })).result;
  const ws = new WebSocket(`${CDP.replace('http', 'ws')}/devtools/page/${targetId}`);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); if (d.method === "Runtime.exceptionThrown") console.log(`  [${label} error]`, d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable");
  await bsend("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: ctx });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(label + ": " + expr.slice(0, 60) + " -> " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };
  const until = async (expr, what, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await ev(expr)) return true; } catch {} await sleep(150); }
    const state = await ev(`JSON.stringify({ screens: ["s-name","s-wait","s-msg","s-room"].filter(id => !document.getElementById(id).hidden), ws: ws && ws.readyState, peers: [...peers.values()].map(p => ({ name: p.name, pc: p.pc && p.pc.connectionState, ice: p.pc && p.pc.iceConnectionState, ctl: p.ctl && p.ctl.readyState })) })`).catch((e) => String(e));
    throw new Error(`${label}: timed out waiting for ${what}\n  state: ${state}`);
  };
  const go = (path) => send("Page.navigate", { url: BASE + path });
  const join = async (name) => {
    await until(`!document.getElementById("s-name").hidden`, "name screen");
    await ev(`document.getElementById("name").value = ${JSON.stringify(name)}; document.getElementById("name-form").requestSubmit(); true`);
  };
  const visible = (id) => ev(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  return { label, ev, until, go, join, visible, text };
}

const sha = `async (blob) => { const b = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }`;
const makeFile = (name, bytes) => `(async () => {
  const data = new Uint8Array(${bytes}); for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
  const f = new File([data], ${JSON.stringify(name)}); shareFiles([f]); return (${sha})(f); })()`;
const downloadAndHash = (who, fileName) => `(async () => {
  const p = [...peers.values()].find(p => p.name === ${JSON.stringify(who)});
  const f = p.files.find(f => f.name === ${JSON.stringify(fileName)});
  download(p, f);
  for (let i = 0; i < 300; i++) {
    const t = [...transfers.values()].reverse().find(t => t.dir === "down" && t.name === ${JSON.stringify(fileName)});
    if (t && t.status === "done") return (${sha})(await (await fetch(t.url)).blob());
    if (t && t.status === "failed") return "failed: " + t.error;
    await new Promise(r => setTimeout(r, 100));
  }
  return "timeout"; })()`;

const host = await person("host"), amaka = await person("amaka"), bayo = await person("bayo"), chen = await person("chen");

await host.go("/new");
await host.join("Tobi");
await host.until(`!document.getElementById("s-room").hidden`, "room");
const code = (await host.ev("location.pathname")).slice(1);
check("host creates a pier with a Meet-style code", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code), code);
check("invite link shows the pier", (await host.text("#invite-link")).endsWith("/" + code));

await amaka.go("/" + code);
await amaka.until(`!document.getElementById("s-name").hidden`, "join screen");
check("guest sees whose pier it is", (await amaka.text("#name-title")) === "Join Tobi's pier", await amaka.text("#name-title"));
await amaka.join("Amaka");
await amaka.until(`!document.getElementById("s-wait").hidden`, "waiting screen");
check("guest waits to be let in", true);
await host.until(`document.querySelectorAll("#requests .request").length === 1`, "join request");
check("host sees the request", (await host.text("#requests .request .who")).startsWith("Amaka wants to join"));
await host.ev(`[...document.querySelectorAll("#requests button")].find(b => b.textContent === "Let in").click(); true`);
await amaka.until(`!document.getElementById("s-room").hidden`, "room");
check("guest is let in", true);
await host.until(`[...peers.values()].every(p => connected(p)) && peers.size === 1`, "host connected to Amaka");
await amaka.until(`[...peers.values()].every(p => connected(p)) && peers.size === 1`, "Amaka connected to host");
await host.until(`document.getElementById("count").textContent === "2 on this pier"`, "count of 2");
check("host and guest connect directly", true, await host.text("#count"));

const hostHash = await host.ev(makeFile("holiday-video.mp4", 5_300_000));
await amaka.until(`[...peers.values()].some(p => p.files.some(f => f.name === "holiday-video.mp4"))`, "file list");
await amaka.until(`(document.querySelector("#files .group h3") || {}).textContent === "Tobi is sharing"`, "Tobi's files on screen");
check("guest sees the host's file", true);
const got1 = await amaka.ev(downloadAndHash("Tobi", "holiday-video.mp4"));
check("host to guest: 5.3 MB arrives intact", got1 === hostHash, got1.slice(0, 16));

const amakaHash = await amaka.ev(makeFile("receipt.pdf", 1_200_000));
await host.until(`[...peers.values()].some(p => p.files.some(f => f.name === "receipt.pdf"))`, "guest file list");
const got2 = await host.ev(downloadAndHash("Amaka", "receipt.pdf"));
check("guest to host: files go both ways", got2 === amakaHash, got2.slice(0, 16));

await bayo.go("/" + code);
await bayo.join("Bayo");
await host.until(`document.querySelectorAll("#requests .request").length === 1`, "second request");
await host.ev(`[...document.querySelectorAll("#requests button")].find(b => b.textContent === "Deny").click(); true`);
await bayo.until(`!document.getElementById("s-msg").hidden`, "denied screen");
check("a denied guest is told", (await bayo.text("#msg-title")) === "You weren't let in");
check("a denied guest never sees the files", (await bayo.ev("peers.size")) === 0);

await chen.go("/" + code);
await chen.join("Chen");
await host.until(`document.querySelectorAll("#requests .request").length === 1`, "third request");
await host.ev(`[...document.querySelectorAll("#requests button")].find(b => b.textContent === "Let in").click(); true`);
await chen.until(`peers.size === 2 && [...peers.values()].every(p => connected(p))`, "Chen connected to both");
check("a third person connects to everyone on the pier", true);
const got3 = await chen.ev(downloadAndHash("Amaka", "receipt.pdf"));
check("guest to guest works too", got3 === amakaHash, got3.slice(0, 16));
await amaka.until(`document.getElementById("count").textContent === "3 on this pier"`, "count of 3");
check("everyone sees 3 on this pier", true);

await host.ev(`[...peers.values()].find(p => p.name === "Chen") && send({ type: "remove", id: [...peers.values()].find(p => p.name === "Chen").id }); true`);
await chen.until(`!document.getElementById("s-msg").hidden`, "removed screen");
check("host can remove someone", (await chen.text("#msg-title")) === "You were removed from this pier");
await amaka.until(`peers.size === 1`, "Chen gone for Amaka");
check("others see them leave", true);

await host.ev(`location.reload(); true`);
await host.until(`!document.getElementById("s-room").hidden && peers.size === 1 && [...peers.values()].every(p => connected(p))`, "host back after refresh", 20000);
check("host refreshes the page and the pier survives", true);
await amaka.until(`document.getElementById("host-away").hidden`, "host-away banner cleared");

await host.ev(`document.getElementById("leave").click(); document.getElementById("leave").click(); true`);
await amaka.until(`!document.getElementById("s-msg").hidden`, "ended screen");
check("ending the pier tells everyone", (await amaka.text("#msg-title")) === "This pier has ended");
await bayo.go("/" + code);
await bayo.until(`!document.getElementById("s-msg").hidden`, "closed screen");
check("an old link shows the pier is closed", (await bayo.text("#msg-title")) === "This pier is closed");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
