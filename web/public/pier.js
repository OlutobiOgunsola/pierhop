"use strict";
// A pier: one person creates it, others knock, the creator lets them in, and
// everyone on it can share files with everyone else.
//
// Privacy: files go browser to browser over WebRTC, which encrypts every
// connection. The pier's secret key lives in the link after the "#", which
// browsers never send to any server. With it, each browser signs its half of
// the connection setup, so not even PierHop's own server could step into the
// middle unnoticed, and every file chunk is encrypted again with AES-256-GCM
// under a fresh key per transfer. The server only ever sees knocks, names and
// sealed connection setup; never files, file names or the key.
//
// Resuming: downloads are written to the browser's private storage as they
// arrive, with a confirmed position saved every few megabytes. If anything
// drops (the connection, the network, or either page), the transfer carries on
// from the last confirmed byte once both people are back.

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const HIGH_WATER = 4 * 1024 * 1024; // pause sending when this much is queued
const LOW_WATER = 1024 * 1024;
const CONFIRM_EVERY = 2 * 1024 * 1024; // save a resume point this often
const TAG = 16; // AES-GCM adds 16 bytes to each chunk

const me = { id: null, name: "", isHost: false };
let code = null;
let hostId = null;
let ws = null;
let finished = false; // the pier ended for us; don't reconnect
const peers = new Map(); // id -> { id, name, device, host, pc, ctl, files, pending, chain }
const knocks = new Map(); // host only: id -> { id, name, device }
const myFiles = new Map(); // id -> { file, key }
const transfers = new Map(); // key -> transfer

// --- small helpers -------------------------------------------------------------

function el(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style" || k.includes("-")) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of children) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

function size(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}

function pct(done, total) {
  return Math.floor((done / (total || 1)) * 100) + "%";
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

function typeTile(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1) : "file";
  return el("span", { class: "ft", "aria-hidden": "true" }, ext);
}

function initial(name) {
  return (name.trim()[0] || "?").toUpperCase();
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|CrOS/.test(ua)) return "Computer";
  return "";
}

// crypto.randomUUID only exists on HTTPS pages; this works everywhere.
function randomId(n = 12) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => (b % 36).toString(36)).join("");
}

function newCode() {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = [...bytes].map((b) => letters[b % letters.length]).join("");
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}

// A stable name for a file, so the same file shared again (after a refresh)
// is recognised and a download of it can carry on.
function fileKey(file) {
  const s = `${file.name}|${file.size}|${file.lastModified}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + file.size.toString(36);
}

function store(key, value) {
  try { value === undefined ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {}
}

function recall(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

// --- the pier's secret key ---------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let secret = null; // 32 random bytes, only ever in the link's "#" part and this page
let baseKey = null; // HKDF key derived from it
let signKey = null; // HMAC key for signing connection setup

async function useSecret(raw) {
  secret = raw;
  baseKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  signKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc("pierhop signal v1") },
    baseKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
}

function fingerprints(sdp) {
  return sdp.split(/\r?\n/).filter((l) => l.startsWith("a=fingerprint:")).map((l) => l.trim()).sort().join("\n");
}

// The DTLS fingerprint in a connection offer identifies the browser at the
// other end. Signing it with the pier key means a server that swapped it for
// its own would be caught.
function signedText(from, to, desc) {
  return enc(`${from}|${to}|${desc.type}|${fingerprints(desc.sdp)}`);
}

async function signDescription(desc, to) {
  return b64(await crypto.subtle.sign("HMAC", signKey, signedText(me.id, to, desc)));
}

async function verifyDescription(desc, from, sig) {
  if (!sig || !fingerprints(desc.sdp)) return false;
  try { return await crypto.subtle.verify("HMAC", signKey, unb64(sig), signedText(from, me.id, desc)); }
  catch { return false; }
}

async function transferKey(salt) {
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc("pierhop file v1") },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Each chunk's nonce is its position in the file. Keys are fresh per
// transfer (random salt), so a nonce is never reused with the same key.
function nonce(offset) {
  const v = new Uint8Array(12);
  new DataView(v.buffer).setBigUint64(4, BigInt(offset));
  return v;
}

function pierLink() {
  return `${location.origin}/${code}#${b64(secret)}`;
}

// --- where downloads are kept while they arrive ----------------------------------

const disk = (() => {
  let worker = null;
  let seq = 0;
  const waiting = new Map();
  let ok = null;
  function call(op, args, transfer) {
    if (!worker) {
      worker = new Worker("/store-worker.js");
      worker.onmessage = (e) => {
        const w = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (w) e.data.ok ? w.resolve(e.data.value) : w.reject(new Error(e.data.error));
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, args }, transfer || []);
    });
  }
  return {
    call,
    // Private browser storage isn't everywhere (private windows, old browsers).
    async available() {
      if (ok !== null) return ok;
      try { await call("list"); ok = !!(navigator.storage && navigator.storage.getDirectory); }
      catch { ok = false; }
      return ok;
    },
  };
})();

// The same interface, backed by private storage or, where that isn't available,
// by memory (which still resumes, as long as this page stays open).
async function openStore(name) {
  if (await disk.available()) {
    return {
      kind: "disk",
      open: (keep) => disk.call("open", { name, keep }),
      write: (at, buf) => disk.call("write", { name, at, data: buf }, [buf]),
      flush: () => disk.call("flush", { name }),
      close: () => disk.call("close", { name }),
      remove: () => disk.call("remove", { name }),
      async file(fileName, type) {
        await disk.call("close", { name });
        const handle = await (await navigator.storage.getDirectory()).getFileHandle(name);
        return new File([await handle.getFile()], fileName, { type });
      },
    };
  }
  const parts = [];
  let length = 0;
  return {
    kind: "memory",
    async open() { return length; },
    async write(at, buf) { if (at !== length) throw new Error("out of order"); parts.push(buf); length += buf.byteLength; },
    async flush() {},
    async close() {},
    async remove() { parts.length = 0; length = 0; },
    async file(fileName, type) { return new File(parts, fileName, { type }); },
  };
}

// Resume points for this browser, kept per pier: survive a page refresh.
const INDEX = "pierhop:downloads";
function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX)) || {}; } catch { return {}; }
}
function writeIndex(idx) {
  try { localStorage.setItem(INDEX, JSON.stringify(idx)); } catch {}
}
function saveRecord(rec) {
  const idx = readIndex();
  idx[rec.tkey] = rec;
  writeIndex(idx);
}
function dropRecord(tkey) {
  const idx = readIndex();
  delete idx[tkey];
  writeIndex(idx);
}

// Deletes leftovers: finished downloads and anything from piers that are over.
async function tidyStorage(keepCode) {
  if (!(await disk.available())) return;
  const idx = readIndex();
  const keep = new Set();
  for (const [tkey, rec] of Object.entries(idx)) {
    const stale = rec.done || (keepCode === null && rec.code === code) || Date.now() - (rec.at || 0) > 3 * 86400e3;
    if (stale) delete idx[tkey];
    else keep.add(rec.store);
  }
  writeIndex(idx);
  for (const name of await disk.call("list").catch(() => [])) {
    if (name.startsWith("dl-") && !keep.has(name)) await disk.call("remove", { name }).catch(() => {});
  }
}

async function forgetPier() {
  const idx = readIndex();
  for (const [tkey, rec] of Object.entries(idx)) {
    if (rec.code !== code) continue;
    delete idx[tkey];
  }
  writeIndex(idx);
  await tidyStorage(null).catch(() => {});
}

// --- rendering ---------------------------------------------------------------------

// A timer rather than requestAnimationFrame: animation frames stop in
// background tabs, and a host on another tab still needs the "(1)" join alert.
let pending = 0;
function render() {
  if (pending) return;
  pending = setTimeout(() => { pending = 0; renderRoom(); }, 30);
}

function show(screen) {
  for (const id of ["s-name", "s-wait", "s-msg", "s-room"]) $(id).hidden = id !== screen;
  const inRoom = screen === "s-room";
  $("leave").hidden = !inRoom;
  $("count").hidden = !inRoom;
  if (!inRoom) { $("host-away").hidden = true; $("net").hidden = true; }
}

function message(title, text) {
  finished = true;
  closeAll();
  $("msg-title").textContent = title;
  $("msg-text").textContent = text || "";
  show("s-msg");
  document.title = "PierHop";
}

// --- connecting to the front desk ----------------------------------------------

let attempts = 0;
let greeted = false; // the front desk has answered at least once
let lastParams = {};

function connect(params) {
  lastParams = params;
  const q = new URLSearchParams(params);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  attempts++;
  ws = new WebSocket(`${proto}://${location.host}/api/piers/${code}/ws?${q}`);
  ws.onopen = () => { $("net").hidden = true; };
  ws.onmessage = (e) => { greeted = true; attempts = 0; onDesk(JSON.parse(e.data)); };
  ws.onclose = () => {
    if (finished) return;
    const hostToken = recall("pierhop:host:" + code);
    const ticket = recall("pierhop:ticket:" + code);
    if (me.isHost && hostToken) return reconnect({ host: hostToken, name: me.name, device: deviceLabel() });
    if (me.id && ticket) return reconnect({ guest: ticket });
    if (!greeted) {
      if (attempts < 4) return setTimeout(() => connect(params), 800 * attempts);
      return message("Couldn't reach PierHop", "Check your internet connection, then open the link again.");
    }
    message("You've been disconnected", "Check your connection, then open the pier link again.");
  };
}

// Lost the front desk (network change, phone asleep...). Keep trying; files
// already on the way keep going over the direct connections meanwhile.
function reconnect(params) {
  if (!$("s-room").hidden) $("net").hidden = false;
  setTimeout(() => { if (!finished) connect(params); }, Math.min(1000 * attempts, 8000));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onDesk(m) {
  switch (m.type) {
    case "hello":
      store("pierhop:ticket:" + code, undefined);
      $("name-title").textContent = m.hostName ? `Join ${m.hostName}'s pier` : "Join this pier";
      $("name-sub").textContent = "Tell them who you are. They'll let you in.";
      $("name-go").textContent = "Ask to join";
      $("name-go").disabled = false;
      show("s-name");
      $("name").focus();
      break;
    case "no-pier":
      forgetPier();
      message("This pier is closed", "Piers close when the person who made them leaves. Ask them for a new link.");
      break;
    case "error":
      if (m.reason === "taken") startPier(); // vanishingly rare: pick another code
      break;
    case "created":
      me.id = m.you;
      me.isHost = true;
      hostId = me.id;
      store("pierhop:host:" + code, m.token);
      reconnectPeers(m.peers || []);
      enterRoom();
      break;
    case "waiting":
      show("s-wait");
      break;
    case "welcome":
      me.id = m.you;
      hostId = m.hostId;
      store("pierhop:ticket:" + code, m.ticket);
      store("pierhop:name:" + code, me.name);
      reconnectPeers(m.peers);
      enterRoom();
      break;
    case "denied":
      message("You weren't let in", "The pier's host declined your request.");
      break;
    case "removed":
      store("pierhop:ticket:" + code, undefined);
      forgetPier();
      message("You were removed from this pier", "The host removed you. Ask them if you think it was a mistake.");
      break;
    case "ended":
      store("pierhop:ticket:" + code, undefined);
      store("pierhop:host:" + code, undefined);
      forgetPier();
      message("This pier has ended", "The host closed it, so its files are no longer available.");
      break;
    case "full":
      message("This pier is full", "Try again in a little while, or ask the host for help.");
      break;
    case "knock":
      knocks.set(m.peer.id, m.peer);
      toast(`${m.peer.name} wants to join`);
      render();
      break;
    case "knock-gone":
      knocks.delete(m.id);
      render();
      break;
    case "peer-joined":
      addPeer(m.peer, false); // they connect to us
      if (m.peer.host) { hostId = m.peer.id; $("host-away").hidden = true; }
      render();
      break;
    case "peer-left":
      if (m.id === hostId && !me.isHost) $("host-away").hidden = false;
      closePeer(m.id);
      render();
      break;
    case "signal":
      onSignal(m.from, m.data);
      break;
  }
}

// We (re)joined: whoever arrives starts the connections to everyone already there.
function reconnectPeers(list) {
  for (const id of [...peers.keys()]) closePeer(id);
  for (const p of list) addPeer(p, true);
}

// --- peers ---------------------------------------------------------------------

function addPeer(info, initiator) {
  closePeer(info.id);
  const peer = { ...info, pc: null, ctl: null, files: [], pending: [], chain: Promise.resolve(), blocked: false };
  peers.set(info.id, peer);
  if (initiator) makeConnection(peer, true);
  render();
}

function makeConnection(peer, initiator) {
  if (peer.pc) { try { peer.pc.close(); } catch {} }
  pauseTransfers(peer.id);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer.pc = pc;
  peer.ctl = null;
  peer.pending = [];
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: peer.id, data: { candidate: e.candidate.toJSON() } }); };
  pc.onconnectionstatechange = () => {
    render();
    if (peer.pc !== pc) return;
    if (pc.connectionState === "failed") recover(peer);
    else if (pc.connectionState === "disconnected") setTimeout(() => { if (peer.pc === pc && pc.connectionState === "disconnected") recover(peer); }, 5000);
  };
  pc.ondatachannel = (e) => {
    if (e.channel.label === "ctl") setupControl(peer, e.channel);
    else if (e.channel.label === "dl") serveFile(peer, e.channel);
  };
  if (initiator) {
    setupControl(peer, pc.createDataChannel("ctl"));
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(async () => {
        const d = pc.localDescription.toJSON();
        send({ type: "signal", to: peer.id, data: { sdp: d, sig: await signDescription(d, peer.id) } });
      })
      .catch(() => {});
  }
}

// A direct connection dropped. The side with the smaller id starts a fresh
// one, so both don't try at once; if that's the other side, we ask it to,
// rather than waiting for its browser to notice. Transfers then carry on.
function recover(peer) {
  if (peer.recovering || peers.get(peer.id) !== peer || peer.blocked) return;
  peer.recovering = true;
  pauseTransfers(peer.id);
  render();
  setTimeout(() => {
    peer.recovering = false;
    if (peers.get(peer.id) !== peer) return;
    if (me.id < peer.id) makeConnection(peer, true);
    else send({ type: "signal", to: peer.id, data: { reconnect: true } });
  }, 1000);
}

function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  // Handle one message at a time so candidates never race the description they belong to.
  peer.chain = peer.chain.then(async () => {
    if (data.reconnect) {
      if (me.id < from && !peer.blocked) makeConnection(peer, true);
      return;
    }
    if (data.sdp) {
      if (!(await verifyDescription(data.sdp, from, data.sig))) {
        peer.blocked = true;
        toast(`Couldn't verify ${peer.name}'s connection, so it was blocked to keep your files safe.`);
        render();
        return;
      }
      peer.blocked = false;
      if (data.sdp.type === "offer") makeConnection(peer, false); // an offer always means a fresh connection
      const pc = peer.pc;
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        const d = pc.localDescription.toJSON();
        send({ type: "signal", to: from, data: { sdp: d, sig: await signDescription(d, from) } });
      }
    } else if (data.candidate && peer.pc) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }).catch(() => {});
}

function setupControl(peer, ch) {
  peer.ctl = ch;
  ch.onopen = () => { sendFileList(peer); render(); };
  ch.onclose = () => {
    pauseTransfers(peer.id);
    render();
    if (peer.ctl === ch && peers.get(peer.id) === peer) recover(peer); // not when we replaced it ourselves
  };
  ch.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "files" && Array.isArray(m.files)) {
      peer.files = m.files.slice(0, 2000).map((f) => ({
        id: String(f.id).slice(0, 40), key: String(f.key).slice(0, 40),
        name: String(f.name).slice(0, 255), size: Math.max(0, Number(f.size) || 0),
      }));
      resumeFrom(peer);
      render();
    }
  };
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  try { peer.pc && peer.pc.close(); } catch {}
  peers.delete(id);
  pauseTransfers(id);
}

function closePeers() {
  for (const id of [...peers.keys()]) closePeer(id);
}

function closeAll() {
  closePeers();
  try { ws && ws.close(); } catch {}
}

function connected(peer) {
  return peer.ctl && peer.ctl.readyState === "open";
}

// --- sharing files ---------------------------------------------------------------

function fileList() {
  return [...myFiles].map(([id, f]) => ({ id, key: f.key, name: f.file.name, size: f.file.size }));
}

function sendFileList(peer) {
  if (connected(peer)) peer.ctl.send(JSON.stringify({ t: "files", files: fileList() }));
}

function shareFiles(files) {
  const known = new Set([...myFiles.values()].map((f) => f.key));
  let added = 0;
  for (const file of files) {
    const key = fileKey(file);
    if (known.has(key)) continue;
    known.add(key);
    myFiles.set(randomId(), { file, key });
    added++;
  }
  for (const p of peers.values()) sendFileList(p);
  if (added) toast(added === 1 ? `Sharing ${files[0].name}` : `Sharing ${added} files`);
  render();
}

function unshare(id) {
  myFiles.delete(id);
  for (const p of peers.values()) sendFileList(p);
  render();
}

function chunkSize(pc) {
  const max = pc.sctp && pc.sctp.maxMessageSize;
  return Math.min(64 * 1024, max > 0 ? max : 16 * 1024) - TAG;
}

// Someone opened a channel asking for one of our files: send it, encrypted,
// from wherever they got to.
function serveFile(peer, ch) {
  ch.binaryType = "arraybuffer";
  ch.onmessage = async (e) => {
    let req;
    try { req = JSON.parse(e.data); } catch { return; }
    if (req.t !== "get") return;
    const entry = [...myFiles.values()].find((f) => f.key === req.key);
    if (!entry) return ch.send(JSON.stringify({ t: "error", message: "That file isn't shared anymore." }));
    const file = entry.file;
    const start = Math.max(0, Math.min(Number(req.offset) || 0, file.size));
    const tkey = `up:${peer.id}:${entry.key}`;
    const t = { key: tkey, dir: "up", name: file.name, size: file.size, done: start, who: peer.name, peerId: peer.id, fileKey: entry.key, status: "active", resumedFrom: start };
    transfers.set(tkey, t);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await transferKey(salt);
    ch.send(JSON.stringify({ t: "start", name: file.name, size: file.size, type: file.type, offset: start, salt: b64(salt) }));
    ch.bufferedAmountLowThreshold = LOW_WATER;
    const step = chunkSize(peer.pc);
    try {
      for (let off = start; off < file.size; off += step) {
        if (ch.readyState !== "open") throw new Error("closed");
        const plain = await file.slice(off, off + step).arrayBuffer();
        const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(off) }, key, plain);
        if (ch.bufferedAmount > HIGH_WATER) {
          await new Promise((resolve) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; resolve(); }; });
        }
        if (ch.readyState !== "open") throw new Error("closed");
        ch.send(sealed);
        t.done = off + plain.byteLength;
        render();
      }
      ch.send(JSON.stringify({ t: "end" }));
      t.status = "done";
    } catch {
      t.status = "paused";
    }
    render();
  };
}

// --- downloading -------------------------------------------------------------------

function transferId(peerId, key) {
  return `${code}:${peerId}:${key}`;
}

function pauseTransfers(peerId) {
  for (const t of transfers.values()) {
    if (t.peerId === peerId && t.status === "active") {
      t.status = "paused";
      if (t.channel) { try { t.channel.close(); } catch {} }
    }
  }
}

// They're back (or re-shared the file): carry on with anything unfinished.
function resumeFrom(peer) {
  for (const f of peer.files) {
    const t = transfers.get(transferId(peer.id, f.key));
    if (t && t.dir === "down" && t.status === "paused") download(peer, f);
  }
}

async function download(peer, f) {
  if (!connected(peer)) return toast(`Still connecting to ${peer.name}…`);
  const tkey = transferId(peer.id, f.key);
  let t = transfers.get(tkey);
  if (t && (t.status === "active" || t.status === "starting")) return;
  const idx = readIndex();
  const rec = idx[tkey] || { tkey, code, peerId: peer.id, peerName: peer.name, key: f.key, name: f.name, size: f.size, confirmed: 0, store: "dl-" + randomId(16), at: Date.now() };
  if (!t) t = { key: tkey, dir: "down", name: f.name, size: f.size, peerId: peer.id, fileKey: f.key, who: peer.name, done: rec.confirmed };
  t.status = "starting";
  t.error = null;
  transfers.set(tkey, t);
  render();

  if (!t.store) t.store = await openStore(rec.store);
  // Private storage is cut back to the last confirmed byte; memory holds
  // exactly what arrived, in order, so all of it counts.
  const pos0 = await t.store.open(rec.confirmed);
  let pos = pos0;
  rec.confirmed = pos;
  rec.at = Date.now();
  saveRecord(rec);
  t.done = pos;
  t.resumedFrom = pos;
  if (pos >= f.size && f.size > 0) return finish(t, rec);

  if (navigator.storage && navigator.storage.estimate && t.store.kind === "disk") {
    const { quota = Infinity, usage = 0 } = await navigator.storage.estimate().catch(() => ({}));
    if (quota - usage < f.size - pos) {
      t.status = "failed";
      t.error = "Not enough space on this device";
      return render();
    }
  }

  const ch = peer.pc.createDataChannel("dl");
  ch.binaryType = "arraybuffer";
  t.channel = ch;
  t.status = "active";
  let key = null;
  let type = "";
  let sinceConfirm = 0;
  let ended = false;
  let chain = Promise.resolve();

  const confirm = async () => {
    await t.store.flush();
    rec.confirmed = pos;
    rec.at = Date.now();
    saveRecord(rec);
    sinceConfirm = 0;
  };

  const handle = async (data) => {
    if (typeof data === "string") {
      const m = JSON.parse(data);
      if (m.t === "start") {
        if (m.offset !== pos || m.size !== f.size) throw new Error("The file changed on their device");
        key = await transferKey(unb64(m.salt));
        type = m.type || "";
        rec.type = type;
      } else if (m.t === "error") {
        throw Object.assign(new Error(m.message), { final: true });
      } else if (m.t === "end") {
        ended = true;
        await confirm();
        ch.close();
        if (pos !== f.size) throw new Error("The download was incomplete");
        await finish(t, rec);
      }
      return;
    }
    if (!key) throw new Error("Out of order");
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(pos) }, key, data);
    } catch {
      throw Object.assign(new Error("A piece of this file failed its security check, so it was thrown away"), { security: true });
    }
    const n = plain.byteLength; // measure first: writing hands the buffer over to the storage worker
    await t.store.write(pos, plain);
    pos += n;
    t.done = pos;
    sinceConfirm += n;
    if (sinceConfirm >= CONFIRM_EVERY) await confirm();
    render();
  };

  ch.onopen = () => ch.send(JSON.stringify({ t: "get", key: f.key, offset: pos }));
  ch.onmessage = (e) => {
    chain = chain.then(() => (t.status === "active" ? handle(e.data) : null)).catch(async (err) => {
      t.status = "failed";
      t.error = err.message;
      try { ch.close(); } catch {}
      if (err.security) { await t.store.remove(); t.store = null; dropRecord(tkey); t.done = 0; }
      render();
    });
  };
  ch.onclose = () => {
    chain = chain.then(async () => {
      if (ended || t.status !== "active" && t.status !== "paused") return;
      await confirm().catch(() => {});
      t.status = "paused";
      render();
    });
  };
  render();
}

async function finish(t, rec) {
  const file = await t.store.file(t.name, rec.type || "");
  t.url = URL.createObjectURL(file);
  t.status = "done";
  t.done = t.size;
  rec.done = true;
  saveRecord(rec);
  save(t);
  render();
}

function save(t) {
  const a = el("a", { href: t.url, download: t.name });
  document.body.append(a);
  a.click();
  a.remove();
}

// After a refresh: list unfinished downloads so they carry on when the sender is back.
function restoreDownloads() {
  for (const rec of Object.values(readIndex())) {
    if (rec.code !== code || rec.done) continue;
    transfers.set(rec.tkey, {
      key: rec.tkey, dir: "down", name: rec.name, size: rec.size, peerId: rec.peerId, fileKey: rec.key,
      who: rec.peerName, done: rec.confirmed, status: "paused",
    });
  }
}

// --- the room --------------------------------------------------------------------

function enterRoom() {
  show("s-room");
  history.replaceState(null, "", `/${code}#${b64(secret)}`);
  $("invite-link").textContent = `${location.host}/${code}`;
  $("share").hidden = !navigator.share;
  $("local-note").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const qr = qrcode(0, "M");
  qr.addData(pierLink());
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("leave").textContent = me.isHost ? "End pier" : "Leave";
  $("s-room").classList.toggle("host", me.isHost);
  render();
}

function transferRow(t, f, peer) {
  let meta = size(t ? t.size : f.size);
  let right;
  const live = peer && connected(peer);
  if (t && (t.status === "active" || t.status === "starting")) {
    meta = `${size(t.done)} of ${size(t.size)}` + (t.resumedFrom ? " · picked up where it stopped" : "");
    right = el("span", { class: "small muted" }, pct(t.done, t.size));
  } else if (t && t.status === "paused") {
    meta = `Paused at ${pct(t.done, t.size)} · carries on when ${live ? "it reconnects" : `${t.who} is back`}`;
    right = live && f ? el("button", { onclick: () => download(peer, f) }, "Resume") : null;
  } else if (t && t.status === "done") {
    meta = `${size(t.size)} · downloaded`;
    right = el("button", { onclick: () => save(t) }, "Save again");
  } else {
    if (t && t.status === "failed") meta = `${size(f ? f.size : t.size)} · ${t.error || "failed"}`;
    right = f && peer ? el("button", { onclick: () => download(peer, f), disabled: !live }, t ? "Try again" : "Download") : null;
  }
  const name = t ? t.name : f.name;
  const showBar = t && t.status !== "failed";
  return el("li", { class: t ? t.status : null },
    typeTile(name),
    el("div", { class: "grow" },
      el("div", { class: "name", title: name }, name),
      el("div", { class: "meta" }, meta),
      showBar ? el("div", { class: "bar" }, el("div", { style: `width:${Math.min(100, (t.done / (t.size || 1)) * 100)}%` })) : null),
    right,
  );
}

function renderRoom() {
  if ($("s-room").hidden) return;
  const total = peers.size + 1;
  $("count").textContent = `${total} on this pier`;
  document.title = (me.isHost && knocks.size ? `(${knocks.size}) ` : "") + "PierHop";

  // Join requests (host only)
  const req = $("requests");
  req.replaceChildren();
  for (const k of knocks.values()) {
    req.append(el("div", { class: "request" },
      el("span", { class: "avatar" }, initial(k.name)),
      el("div", { class: "who" }, el("b", {}, k.name), " wants to join", k.device ? el("div", { class: "small muted" }, k.device) : null),
      el("button", { class: "primary", onclick: () => { send({ type: "allow", id: k.id }); knocks.delete(k.id); render(); } }, "Let in"),
      el("button", { onclick: () => { send({ type: "deny", id: k.id }); knocks.delete(k.id); render(); } }, "Deny"),
    ));
  }

  // People
  const people = $("people");
  people.replaceChildren(el("li", {},
    el("span", { class: "avatar" }, initial(me.name)),
    el("div", { class: "grow" }, el("div", { class: "name" }, me.name + " (you)"), el("div", { class: "meta" }, me.isHost ? "Host" : "Guest")),
  ));
  for (const p of peers.values()) {
    const on = connected(p);
    const state = p.blocked ? "couldn't verify, blocked" : on ? null : "connecting…";
    people.append(el("li", {},
      el("span", { class: "avatar" }, initial(p.name)),
      el("div", { class: "grow" },
        el("div", { class: "name" }, p.name),
        el("div", { class: "meta" }, [p.host ? "Host" : p.device || "Guest", state].filter(Boolean).join(" · "))),
      el("span", { class: "state" + (on ? " on" : ""), title: on ? "Connected, encrypted" : "Connecting" }),
      me.isHost ? el("button", { class: "icon-btn", title: `Remove ${p.name}`, "aria-label": `Remove ${p.name}`, onclick: () => send({ type: "remove", id: p.id }) }, "×") : null,
    ));
  }
  if (!peers.size) people.append(el("li", { class: "empty" }, "Nobody else yet. Send them the link."));

  // Files
  const box = $("files");
  box.replaceChildren();
  const groups = [];
  if (myFiles.size) {
    const ul = el("ul", { class: "files" });
    for (const [id, f] of myFiles) {
      const sending = [...transfers.values()].filter((t) => t.dir === "up" && t.fileKey === f.key && t.status === "active");
      ul.append(el("li", {},
        typeTile(f.file.name),
        el("div", { class: "grow" },
          el("div", { class: "name", title: f.file.name }, f.file.name),
          el("div", { class: "meta" }, size(f.file.size) + (sending.length ? ` · sending to ${sending.map((t) => t.who).join(", ")}` : ""))),
        el("button", { class: "icon-btn", title: "Stop sharing", "aria-label": `Stop sharing ${f.file.name}`, onclick: () => unshare(id) }, "×"),
      ));
    }
    groups.push(el("div", { class: "group" }, el("h3", {}, "You're sharing"), ul));
  }
  const shown = new Set();
  for (const p of peers.values()) {
    if (!p.files.length) continue;
    const ul = el("ul", { class: "files" });
    for (const f of p.files) {
      const tkey = transferId(p.id, f.key);
      shown.add(tkey);
      ul.append(transferRow(transfers.get(tkey), f, p));
    }
    groups.push(el("div", { class: "group" }, el("h3", {}, `${p.name} is sharing`), ul));
  }
  // Unfinished downloads from someone who isn't sharing them right now.
  const waiting = [...transfers.values()].filter((t) => t.dir === "down" && !shown.has(t.key) && t.status !== "done");
  if (waiting.length) {
    const ul = el("ul", { class: "files" });
    for (const t of waiting) ul.append(transferRow(t, null, peers.get(t.peerId)));
    groups.push(el("div", { class: "group" }, el("h3", {}, "Waiting to carry on"), ul));
  }
  if (groups.length) box.append(...groups);
  $("drop").style.marginTop = groups.length ? "16px" : "0";
}

// --- start -------------------------------------------------------------------------

async function startPier() {
  code = newCode();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  await useSecret(raw);
  store("pierhop:secret:" + code, b64(raw));
  history.replaceState(null, "", `/${code}#${b64(raw)}`);
  connect({ create: 1, name: me.name, device: deviceLabel() });
}

$("name").value = (() => { try { return localStorage.getItem("pierhop:name") || ""; } catch { return ""; } })();
$("name-form").onsubmit = (e) => {
  e.preventDefault();
  me.name = $("name").value.trim().slice(0, 40);
  if (!me.name) return;
  try { localStorage.setItem("pierhop:name", me.name); } catch {}
  $("name-go").disabled = true;
  if (code && ws) send({ type: "knock", name: me.name, device: deviceLabel() });
  else startPier();
};
$("wait-cancel").onclick = () => message("Request cancelled", "You can ask to join again from the same link.");
$("add").onclick = () => $("picker").click();
$("picker").onchange = (e) => { shareFiles([...e.target.files]); e.target.value = ""; };
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(pierLink()); toast("Link copied"); }
  catch { toast("Couldn't copy. Press and hold the link instead."); }
};
$("share").onclick = () => navigator.share({ title: "Join my pier", text: `Join ${me.name}'s pier on PierHop`, url: pierLink() }).catch(() => {});

let confirmEnd = 0;
$("leave").onclick = () => {
  if (me.isHost && Date.now() - confirmEnd > 3000) {
    confirmEnd = Date.now();
    $("leave").textContent = "Click again to end";
    setTimeout(() => { if (!finished) $("leave").textContent = "End pier"; }, 3000);
    return;
  }
  if (me.isHost) {
    send({ type: "end" });
    store("pierhop:host:" + code, undefined);
    forgetPier();
    message("You ended the pier", "Everyone has been disconnected.");
  } else {
    store("pierhop:ticket:" + code, undefined);
    forgetPier();
    message("You left the pier", "Open the link again if you want to rejoin.");
  }
};

const drop = $("drop");
["dragenter", "dragover"].forEach((t) => document.addEventListener(t, (e) => { if ($("s-room").hidden) return; e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === "drop" || !e.relatedTarget) drop.classList.remove("over"); }));
document.addEventListener("drop", (e) => {
  if ($("s-room").hidden || !e.dataTransfer) return;
  shareFiles([...e.dataTransfer.files]);
});

// Closing the tab ends what you're sharing, so ask first when it matters.
addEventListener("beforeunload", (e) => {
  if (finished || $("s-room").hidden) return;
  if ((me.isHost && peers.size) || [...transfers.values()].some((t) => t.status === "active")) e.preventDefault();
});

// Opening the full link after a shortened one only changes the "#" part,
// which doesn't reload the page by itself.
addEventListener("hashchange", () => location.reload());

(async function init() {
  if (!(crypto && crypto.subtle)) {
    return message("PierHop needs a secure connection", "Open this page using its https:// address.");
  }
  const path = location.pathname.replace(/\/$/, "").slice(1);
  if (path === "new") {
    show("s-name");
    $("name").focus();
    return;
  }
  if (!CODE_RE.test(path)) return message("Link not found", "Check the link, or create your own pier.");
  code = path;
  const fromLink = location.hash.slice(1);
  const key = fromLink || recall("pierhop:secret:" + code);
  let raw = null;
  try { raw = key ? unb64(key) : null; } catch {}
  if (!raw || raw.length !== 32) {
    return message("This link is incomplete", "Ask for the full pier link. The part after the # is the key that keeps your files private.");
  }
  await useSecret(raw);
  store("pierhop:secret:" + code, b64(raw));
  tidyStorage(code).catch(() => {});
  restoreDownloads();

  const hostToken = recall("pierhop:host:" + code);
  const ticket = recall("pierhop:ticket:" + code);
  if (hostToken) {
    // The host refreshed their page: take the pier back.
    try { me.name = localStorage.getItem("pierhop:name") || "Host"; } catch { me.name = "Host"; }
    me.isHost = true;
    connect({ host: hostToken, name: me.name, device: deviceLabel() });
  } else if (ticket) {
    // Already let in earlier: come straight back without knocking.
    me.name = recall("pierhop:name:" + code) || "Guest";
    connect({ guest: ticket });
  } else {
    connect({});
  }
})();
