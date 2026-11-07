"use strict";
// A pier: one person creates it, others knock, the creator lets them in, and
// everyone on it can share files with everyone else. Files go browser to
// browser over WebRTC; the server only passes knocks and connection setup.

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const HIGH_WATER = 4 * 1024 * 1024; // pause sending when this much is queued
const LOW_WATER = 1024 * 1024;

const me = { id: null, name: "", isHost: false };
let code = null;
let hostId = null;
let ws = null;
let finished = false; // the pier ended for us; don't reconnect
const peers = new Map(); // id -> { id, name, device, host, pc, ctl, files, pending, chain }
const knocks = new Map(); // host only: id -> { id, name, device }
const myFiles = new Map(); // id -> File
const transfers = new Map();
let transferSeq = 0;

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

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
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

function pierLink() {
  return `${location.origin}/${code}`;
}

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
  if (!inRoom) $("host-away").hidden = true;
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

function connect(params) {
  const q = new URLSearchParams(params);
  attempts++;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/piers/${code}/ws?${q}`);
  ws.onmessage = (e) => { greeted = true; attempts = 0; onDesk(JSON.parse(e.data)); };
  ws.onclose = () => {
    if (finished) return;
    if (!greeted && !me.isHost) {
      if (attempts < 4) return setTimeout(() => connect(params), 800 * attempts);
      return message("Couldn't reach PierHop", "Check your internet connection, then open the link again.");
    }
    const token = sessionStorage.getItem("pierhop:host:" + code);
    if (me.isHost && token) {
      // The host's page keeps the pier alive: reconnect and set up again.
      closePeers();
      setTimeout(() => connect({ host: token, name: me.name, device: deviceLabel() }), 1500);
    } else if (me.id) {
      message("You've been disconnected", "Check your connection, then open the pier link again to rejoin.");
    }
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onDesk(m) {
  switch (m.type) {
    case "hello":
      $("name-title").textContent = m.hostName ? `Join ${m.hostName}'s pier` : "Join this pier";
      $("name-sub").textContent = "Tell them who you are. They'll let you in.";
      $("name-go").textContent = "Ask to join";
      show("s-name");
      $("name").focus();
      break;
    case "no-pier":
      message("This pier is closed", "Piers close when the person who made them leaves. Ask them for a new link.");
      break;
    case "error":
      if (m.reason === "taken") startPier(); // vanishingly rare: pick another code
      break;
    case "created":
      me.id = m.id || m.you;
      me.isHost = true;
      hostId = me.id;
      sessionStorage.setItem("pierhop:host:" + code, m.token);
      for (const p of m.peers || []) addPeer(p, true);
      enterRoom();
      break;
    case "waiting":
      show("s-wait");
      break;
    case "welcome":
      me.id = m.you;
      hostId = m.hostId;
      for (const p of m.peers) addPeer(p, true); // newcomers start the connections
      enterRoom();
      break;
    case "denied":
      message("You weren't let in", "The pier's host declined your request.");
      break;
    case "removed":
      message("You were removed from this pier", "The host removed you. Ask them if you think it was a mistake.");
      break;
    case "ended":
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
      addPeer(m.peer, false);
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

// --- peers ---------------------------------------------------------------------

function addPeer(info, initiator) {
  const peer = { ...info, pc: null, ctl: null, files: [], pending: [], chain: Promise.resolve() };
  peers.set(info.id, peer);
  if (initiator) makeConnection(peer, true);
  render();
}

function makeConnection(peer, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: peer.id, data: { candidate: e.candidate.toJSON() } }); };
  pc.onconnectionstatechange = render;
  pc.ondatachannel = (e) => {
    if (e.channel.label === "ctl") setupControl(peer, e.channel);
    else if (e.channel.label.startsWith("dl:")) serveFile(peer, e.channel);
  };
  if (initiator) {
    setupControl(peer, pc.createDataChannel("ctl"));
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => send({ type: "signal", to: peer.id, data: { sdp: pc.localDescription.toJSON() } }))
      .catch(() => {});
  }
}

function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  // Handle one message at a time so candidates never race the description they belong to.
  peer.chain = peer.chain.then(async () => {
    if (!peer.pc) makeConnection(peer, false);
    const pc = peer.pc;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: "signal", to: from, data: { sdp: pc.localDescription.toJSON() } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }).catch(() => {});
}

function setupControl(peer, ch) {
  peer.ctl = ch;
  ch.onopen = () => { sendFileList(peer); render(); };
  ch.onclose = render;
  ch.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "files" && Array.isArray(m.files)) {
      peer.files = m.files.slice(0, 2000).map((f) => ({
        id: String(f.id).slice(0, 40), name: String(f.name).slice(0, 255), size: Math.max(0, Number(f.size) || 0),
      }));
      render();
    }
  };
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  try { peer.pc && peer.pc.close(); } catch {}
  peers.delete(id);
  for (const t of transfers.values()) if (t.peerId === id && t.status === "active") { t.status = "failed"; t.error = "They left the pier"; }
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
  return [...myFiles].map(([id, f]) => ({ id, name: f.name, size: f.size }));
}

function sendFileList(peer) {
  if (connected(peer)) peer.ctl.send(JSON.stringify({ t: "files", files: fileList() }));
}

function shareFiles(files) {
  for (const f of files) myFiles.set(randomId(), f);
  for (const p of peers.values()) sendFileList(p);
  if (files.length) toast(files.length === 1 ? `Sharing ${files[0].name}` : `Sharing ${files.length} files`);
  render();
}

function unshare(id) {
  myFiles.delete(id);
  for (const p of peers.values()) sendFileList(p);
  render();
}

function chunkSize(pc) {
  const max = pc.sctp && pc.sctp.maxMessageSize;
  return Math.min(64 * 1024, max > 0 ? max : 16 * 1024);
}

// Someone opened a channel asking for one of our files: stream it to them.
function serveFile(peer, ch) {
  ch.binaryType = "arraybuffer";
  const file = myFiles.get(ch.label.slice(3));
  const start = async () => {
    if (!file) {
      ch.send(JSON.stringify({ t: "error", message: "That file isn't shared anymore." }));
      return;
    }
    const t = { key: ++transferSeq, dir: "up", name: file.name, size: file.size, done: 0, who: peer.name, peerId: peer.id, status: "active" };
    transfers.set(t.key, t);
    ch.send(JSON.stringify({ t: "start", name: file.name, size: file.size, type: file.type }));
    ch.bufferedAmountLowThreshold = LOW_WATER;
    const step = chunkSize(peer.pc);
    try {
      for (let off = 0; off < file.size; off += step) {
        if (ch.readyState !== "open") throw new Error("closed");
        const buf = await file.slice(off, off + step).arrayBuffer();
        if (ch.bufferedAmount > HIGH_WATER) {
          await new Promise((resolve) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; resolve(); }; });
        }
        ch.send(buf);
        t.done += buf.byteLength;
        render();
      }
      ch.send(JSON.stringify({ t: "end" }));
      t.status = "done";
    } catch {
      t.status = "failed";
    }
    render();
  };
  if (ch.readyState === "open") start();
  else ch.onopen = start;
}

function download(peer, file) {
  if (!connected(peer)) return toast(`Still connecting to ${peer.name}…`);
  const ch = peer.pc.createDataChannel("dl:" + file.id);
  ch.binaryType = "arraybuffer";
  const t = { key: ++transferSeq, dir: "down", name: file.name, size: file.size, done: 0, who: peer.name, peerId: peer.id, fileId: file.id, status: "active", parts: [] };
  transfers.set(t.key, t);
  let type = "";
  ch.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.t === "start") { type = m.type || ""; t.size = m.size; }
      else if (m.t === "error") { t.status = "failed"; t.error = m.message; ch.close(); }
      else if (m.t === "end") {
        ch.close();
        if (t.done !== t.size) { t.status = "failed"; t.error = "The download was incomplete"; }
        else {
          t.status = "done";
          t.url = URL.createObjectURL(new Blob(t.parts, { type }));
          t.parts = null;
          save(t);
        }
      }
    } else {
      t.parts.push(e.data);
      t.done += e.data.byteLength;
    }
    render();
  };
  ch.onclose = () => {
    if (t.status === "active") { t.status = "failed"; t.error = "The connection dropped"; render(); }
  };
  render();
}

function save(t) {
  const a = el("a", { href: t.url, download: t.name });
  document.body.append(a);
  a.click();
  a.remove();
}

// --- the room --------------------------------------------------------------------

function enterRoom() {
  show("s-room");
  history.replaceState(null, "", "/" + code);
  $("invite-link").textContent = pierLink().replace(/^https?:\/\//, "");
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
    people.append(el("li", {},
      el("span", { class: "avatar" }, initial(p.name)),
      el("div", { class: "grow" },
        el("div", { class: "name" }, p.name),
        el("div", { class: "meta" }, [p.host ? "Host" : p.device || "Guest", on ? null : "connecting…"].filter(Boolean).join(" · "))),
      el("span", { class: "state" + (on ? " on" : ""), title: on ? "Connected" : "Connecting" }),
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
      const sending = [...transfers.values()].filter((t) => t.dir === "up" && t.name === f.name && t.status === "active");
      ul.append(el("li", {},
        typeTile(f.name),
        el("div", { class: "grow" },
          el("div", { class: "name", title: f.name }, f.name),
          el("div", { class: "meta" }, size(f.size) + (sending.length ? ` · sending to ${sending.map((t) => t.who).join(", ")}` : ""))),
        el("button", { class: "icon-btn", title: "Stop sharing", "aria-label": `Stop sharing ${f.name}`, onclick: () => unshare(id) }, "×"),
      ));
    }
    groups.push(el("div", { class: "group" }, el("h3", {}, "You're sharing"), ul));
  }
  for (const p of peers.values()) {
    if (!p.files.length) continue;
    const ul = el("ul", { class: "files" });
    for (const f of p.files) {
      const t = [...transfers.values()].reverse().find((x) => x.dir === "down" && x.peerId === p.id && x.fileId === f.id);
      let right;
      let meta = size(f.size);
      if (t && t.status === "active") {
        meta = `${size(t.done)} of ${size(t.size)}`;
        right = el("span", { class: "small muted" }, Math.floor((t.done / (t.size || 1)) * 100) + "%");
      } else if (t && t.status === "done") {
        meta = `${size(f.size)} · downloaded`;
        right = el("button", { onclick: () => save(t) }, "Save again");
      } else {
        if (t && t.status === "failed") meta = `${size(f.size)} · ${t.error || "failed"}`;
        right = el("button", { onclick: () => download(p, f), disabled: !connected(p) }, t ? "Try again" : "Download");
      }
      ul.append(el("li", { class: t ? t.status : null },
        typeTile(f.name),
        el("div", { class: "grow" },
          el("div", { class: "name", title: f.name }, f.name),
          el("div", { class: "meta" }, meta),
          t && t.status !== "failed" ? el("div", { class: "bar" }, el("div", { style: `width:${Math.min(100, (t.done / (t.size || 1)) * 100)}%` })) : null),
        right,
      ));
    }
    groups.push(el("div", { class: "group" }, el("h3", {}, `${p.name} is sharing`), ul));
  }
  if (groups.length) box.append(...groups);
  $("drop").hidden = false;
  $("drop").style.marginTop = groups.length ? "16px" : "0";
}

// --- start -------------------------------------------------------------------------

function startPier() {
  code = newCode();
  history.replaceState(null, "", "/" + code);
  connect({ create: 1, name: me.name, device: deviceLabel() });
}

$("name").value = localStorage.getItem("pierhop:name") || "";
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
    sessionStorage.removeItem("pierhop:host:" + code);
    message("You ended the pier", "Everyone has been disconnected.");
  } else {
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

(function init() {
  const path = location.pathname.replace(/\/$/, "").slice(1);
  if (path === "new") {
    show("s-name");
    $("name").focus();
    return;
  }
  if (!CODE_RE.test(path)) return message("Link not found", "Check the link, or create your own pier.");
  code = path;
  const token = sessionStorage.getItem("pierhop:host:" + code);
  if (token) {
    // The host refreshed their page: take the pier back.
    me.name = localStorage.getItem("pierhop:name") || "Host";
    me.isHost = true;
    connect({ host: token, name: me.name, device: deviceLabel() });
  } else {
    connect({});
  }
})();
