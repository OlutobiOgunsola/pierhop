// Renders intro.html frame by frame in headless Chrome.
//
//   python3 -m http.server 8794 --directory web          (serves intro.html and the fonts)
//   chrome --headless=new --remote-debugging-port=9337 ...
//   node --experimental-websocket web/video/record.mjs OUT_DIR            all 450 frames
//   node --experimental-websocket web/video/record.mjs OUT_DIR 0.5,6,12   stills at those times
//
// Then: ffmpeg -framerate 30 -i OUT_DIR/frame_%04d.png -c:v libx264 -pix_fmt yuv420p \
//         -crf 18 -movflags +faststart web/video/pierhop-intro-9x16.mp4
import fs from "node:fs";

const OUT = process.argv[2];
const STILLS = process.argv[3] ? process.argv[3].split(",").map(Number) : null;
const PAGE = process.env.PAGE || "http://127.0.0.1:8794/video/intro.html?record";
const CDP = process.env.CDP || "http://127.0.0.1:9337";
const FPS = 30, DURATION = 15;

fs.mkdirSync(OUT, { recursive: true });
const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.result.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: PAGE });
await new Promise((r) => setTimeout(r, 1500));
console.log("fonts ready:", await ev(`document.fonts.ready.then(() => document.fonts.check("40px Geist") && document.fonts.check("40px 'Geist Mono'"))`));

const times = STILLS || Array.from({ length: FPS * DURATION }, (_, i) => i / FPS);
for (let i = 0; i < times.length; i++) {
  await ev(`render(${times[i]}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const name = STILLS ? `still_${String(times[i]).replace(".", "_")}.png` : `frame_${String(i).padStart(4, "0")}.png`;
  fs.writeFileSync(`${OUT}/${name}`, Buffer.from(shot.result.data, "base64"));
  if (!STILLS && i % 90 === 0) console.log(`frame ${i}/${times.length}`);
}
console.log(`done: ${times.length} images in ${OUT}`);
process.exit(0);
