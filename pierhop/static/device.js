"use strict";
const $ = (id) => document.getElementById(id);
const rendered = {};
const GATES = { pin: "gate-pin", wait: "gate-wait", denied: "gate-denied", app: "app" };
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
const MAX_URL = 60000;  // the server reads request lines up to 64 KB
let mode = null;

// What the file list shows: the shared items (ref null) or a shared folder.
// The ref lives in the URL hash so the phone's back button goes up a level.
let view = { ref: location.hash.slice(1) || null, folder: null };
let topFiles = [];
let selecting = false;
const selected = new Map();  // ref -> entry
let ticks = 0;

function el(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style" || k.includes("-")) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of children) if (c != null) n.append(c.nodeType ? c : String(c));
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
  t._h = setTimeout(() => t.classList.remove("show"), 1800);
}

// navigator.clipboard needs HTTPS, which a LAN address doesn't have.
function copy(text) {
  const ta = el("textarea", { value: text, style: "position:fixed;opacity:0" });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  toast(ok ? "Copied" : "Couldn't copy. Long-press the text instead.");
}

function section(name, data, render) {
  const sig = JSON.stringify(data);
  if (rendered[name] === sig) return;
  rendered[name] = sig;
  render(data);
}

async function api(path, body) {
  const res = await fetch("api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong.");
    err.status = res.status;
    throw err;
  }
  return data;
}

function show(next) {
  if (mode === next) return;
  mode = next;
  for (const [key, id] of Object.entries(GATES)) $(id).hidden = key !== next;
  $("me").hidden = next !== "app";
  if (next !== "app") $("rename-form").hidden = true;
  if (next === "pin") $("pin").focus();
}

function setOnline(ok) {
  $("offline").hidden = ok;
}

// Registers this device (or recognises it from its cookie) and shows the
// screen that matches its status.
async function hello() {
  let h;
  try {
    h = await api("hello", {});
    setOnline(true);
  } catch (e) {
    if (e.status === 429) { $("sub").textContent = e.message; return; }
    setOnline(false);
    return;
  }
  $("me-name").textContent = h.device.name;
  if (h.status === "approved") {
    $("sub").textContent = "Connected to " + h.instance;
    show("app");
    await refresh();
  } else if (h.status === "denied") {
    $("sub").textContent = h.instance;
    $("denied-msg").textContent = `${h.instance} declined this device. You can ask again in ${h.retry_in}s.`;
    show("denied");
  } else {
    $("sub").textContent = h.instance;
    show(h.access === "approve" ? "wait" : "pin");
  }
}

async function refresh() {
  let s;
  try {
    s = await api("state");
    setOnline(true);
  } catch (e) {
    if (e.status === 401) return hello();
    setOnline(false);
    return;
  }
  $("sub").textContent = "Connected to " + s.instance;
  if (document.activeElement !== $("rename-input")) $("me-name").textContent = s.device.name;

  topFiles = s.files;
  if (view.ref && !s.files.some((f) => f.id === view.ref.split("/")[0])) {
    toast("That folder isn't shared anymore.");
    return setView(null, "replace");
  }
  // Folders are re-read every 10s rather than every tick; they can be big.
  if (view.ref && (!view.folder || ++ticks % 5 === 0)) loadFolder();
  renderFiles();

  section("texts", s.texts, (texts) => {
    const box = $("texts");
    box.replaceChildren();
    for (const t of texts) {
      const isUrl = /^https?:\/\/\S+$/i.test(t.text.trim());
      box.append(el("div", { class: "text-item" },
        el("div", { class: "small" }, t.mine ? "You" : "From " + t.from_name),
        el("div", { class: "text-body" }, t.text),
        el("div", { class: "row" },
          el("button", { class: "link", onclick: () => copy(t.text) }, "Copy"),
          isUrl ? el("a", { class: "link", href: t.text.trim(), target: "_blank", rel: "noopener noreferrer" }, "Open") : null,
        ),
      ));
    }
  });
}

// --- browsing ---------------------------------------------------------------

function entries() {
  return view.ref ? (view.folder ? view.folder.entries : []) : topFiles;
}

// A small tile showing the file's extension, or a folder shape.
function typeTile(name, kind) {
  if (kind === "folder") {
    const t = el("span", { class: "ft folder" });
    t.innerHTML = FOLDER_SVG;
    return t;
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1) : "file";
  return el("span", { class: "ft", "aria-hidden": "true" }, ext);
}

function countLabel(n) {
  return n + (n === 1 ? " file" : " files");
}

function setView(ref, how = "push") {
  if (how === "push") history.pushState({ ref }, "", ref ? "#" + ref : location.pathname + location.search);
  if (how === "replace") history.replaceState({ ref }, "", ref ? "#" + ref : location.pathname + location.search);
  if (ref === view.ref && view.folder) return;
  view = { ref, folder: null };
  setSelecting(false);
  renderFiles();
  if (ref) loadFolder();
  window.scrollTo(0, 0);
}

async function loadFolder() {
  const ref = view.ref;
  try {
    const f = await api("browse?ref=" + encodeURIComponent(ref));
    if (view.ref !== ref) return;
    view.folder = f;
    renderFiles();
  } catch (e) {
    if (e.status === 401) return hello();
    if (e.status === 404 && view.ref === ref) {
      toast(e.message);
      setView(null, "replace");
    }
  }
}

function zipUrl(refs, name) {
  const q = new URLSearchParams();
  for (const r of refs) q.append("f", r);
  if (name) q.set("name", name);
  return "zip?" + q;
}

function renderFiles() {
  const list = entries();
  const crumbs = view.folder ? view.folder.crumbs : [];
  section("files", [view.ref, crumbs, list, selecting, [...selected.keys()]], () => {
    const nav = $("crumbs");
    nav.hidden = !view.ref;
    nav.replaceChildren(el("button", { onclick: () => setView(null) }, "All files"));
    crumbs.forEach((c, i) => {
      nav.append(el("span", { class: "sep" }, "›"));
      nav.append(i === crumbs.length - 1 ? el("span", {}, c.name) : el("button", { onclick: () => setView(c.ref) }, c.name));
    });

    const box = $("files");
    box.replaceChildren();
    if (view.ref && !view.folder) box.append(el("div", { class: "empty" }, "Loading…"));
    else if (!list.length) {
      box.append(el("div", { class: "empty" }, view.ref ? "This folder is empty." : "Nothing here yet. Files the computer shares will show up here."));
    }
    for (const f of list) box.append(fileRow(f));

    $("select-toggle").hidden = !list.length;
    $("select-toggle").textContent = selecting ? "Done" : "Select";
    $("folder-actions").hidden = !view.folder || !list.length || selecting;
    if (view.folder) {
      $("folder-zip").href = "dl/" + view.ref;
      $("folder-zip").download = view.folder.name + ".zip";
    }
    renderSelectBar();
  });
}

function fileRow(f) {
  const folder = f.kind === "folder";
  const sub = folder
    ? (f.count != null ? `${countLabel(f.count)} · ${size(f.size)}` : "Folder")
    : size(f.size);
  const inner = [
    typeTile(f.name, f.kind),
    el("span", { class: "text" }, el("span", { class: "name" }, f.name), el("span", { class: "size" }, sub)),
  ];

  if (selecting) {
    const on = selected.has(f.ref);
    return el("label", { class: "file" + (on ? " picked" : "") },
      el("input", { type: "checkbox", checked: on, onchange: () => toggle(f) }),
      el("span", { class: "main" }, ...inner));
  }
  let main;
  if (folder) main = el("button", { class: "main", onclick: () => setView(f.ref) }, ...inner);
  else if (f.preview) main = el("button", { class: "main", onclick: () => openViewer(f) }, ...inner);
  else main = el("a", { class: "main", href: "dl/" + f.ref, download: f.name }, ...inner);
  return el("div", { class: "file" }, main,
    folder && view.ref ? el("span", { class: "chev" }, "›")
      : el("a", { class: "dl", href: "dl/" + f.ref, download: folder ? f.name + ".zip" : f.name }, folder ? "Zip" : "Download"));
}

// --- selecting several -------------------------------------------------------

function setSelecting(on) {
  selecting = on;
  selected.clear();
  document.body.classList.toggle("selecting", on);
}

function toggle(f) {
  selected.has(f.ref) ? selected.delete(f.ref) : selected.set(f.ref, f);
  renderFiles();
}

function renderSelectBar() {
  $("selbar").hidden = !selecting;
  if (!selecting) return;
  const list = entries();
  const picked = [...selected.values()];
  const all = list.length > 0 && picked.length === list.length;
  $("select-all").textContent = all ? "Select none" : "Select all";
  const known = picked.every((f) => f.size != null);
  $("select-count").textContent = picked.length
    ? `${picked.length} selected` + (known ? " · " + size(picked.reduce((n, f) => n + f.size, 0)) : "")
    : "Tap items to select them";

  const dl = $("select-download");
  dl.removeAttribute("href");
  dl.classList.toggle("primary", picked.length > 0);
  if (!picked.length) return;
  if (picked.length === 1 && picked[0].kind === "file") {
    dl.href = "dl/" + picked[0].ref;
    dl.download = picked[0].name;
    dl.textContent = "Download";
  } else if (all && view.folder) {
    // The whole folder: a short URL however many files it has.
    dl.href = "dl/" + view.ref;
    dl.download = view.folder.name + ".zip";
    dl.textContent = "Download zip";
  } else {
    const name = view.folder ? view.folder.name : "";
    dl.href = zipUrl(picked.map((f) => f.ref), name);
    dl.download = (name || "PierHop files") + ".zip";
    dl.textContent = "Download zip";
  }
}

$("select-toggle").onclick = () => { setSelecting(!selecting); renderFiles(); };
$("select-all").onclick = () => {
  const list = entries();
  if (selected.size === list.length) selected.clear();
  else for (const f of list) selected.set(f.ref, f);
  renderFiles();
};
$("select-download").onclick = (e) => {
  const a = e.currentTarget;
  if (!a.href) return e.preventDefault();
  if (a.href.length > MAX_URL) {
    e.preventDefault();
    return toast("That's too many to pick one by one. Download the whole folder instead.");
  }
  toast("Download started");
  setTimeout(() => { setSelecting(false); renderFiles(); }, 0);
};

// --- viewer ------------------------------------------------------------------

let viewing = { list: [], index: -1 };

function openViewer(f) {
  const list = entries().filter((x) => x.preview);
  viewing = { list, index: list.findIndex((x) => x.ref === f.ref) };
  if ($("viewer").hidden) history.pushState({ ref: view.ref, viewer: true }, "", location.href);
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  showViewerItem();
}

function closeViewer() {
  $("viewer").hidden = true;
  $("viewer-body").replaceChildren();  // stops anything that's playing
  document.body.style.overflow = "";
}

function viewerFailed(f) {
  $("viewer-body").replaceChildren(el("div", { class: "viewer-msg" },
    el("p", {}, "This browser can't show this file."),
    el("a", { class: "btn primary", href: "dl/" + f.ref, download: f.name }, "Download it")));
}

function showViewerItem() {
  const { list, index } = viewing;
  const f = list[index];
  const src = "dl/" + f.ref + "?inline=1";
  $("viewer-name").textContent = f.name;
  $("viewer-dl").href = "dl/" + f.ref;
  $("viewer-dl").download = f.name;
  $("viewer-prev").hidden = index <= 0;
  $("viewer-next").hidden = index >= list.length - 1;
  const fail = () => viewerFailed(f);
  let node;
  if (f.preview === "image") node = el("img", { src, alt: f.name, onerror: fail });
  else if (f.preview === "video") node = el("video", { src, controls: true, autoplay: true, playsInline: true, onerror: fail });
  else if (f.preview === "audio") node = el("audio", { src, controls: true, autoplay: true, onerror: fail });
  else {
    node = el("pre", {}, "Loading…");
    fetch(src).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => { node.textContent = t; }, fail);
  }
  $("viewer-body").replaceChildren(node);
}

function step(d) {
  const i = viewing.index + d;
  if (i < 0 || i >= viewing.list.length) return;
  viewing.index = i;
  showViewerItem();
}

$("viewer-close").onclick = () => (history.state && history.state.viewer ? history.back() : closeViewer());
$("viewer-prev").onclick = () => step(-1);
$("viewer-next").onclick = () => step(1);
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden) return;
  if (e.key === "Escape") $("viewer-close").click();
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});
let touchX = null;
$("viewer-body").addEventListener("touchstart", (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
$("viewer-body").addEventListener("touchend", (e) => {
  if (touchX === null || viewing.list[viewing.index]?.preview !== "image") return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  touchX = null;
});

window.addEventListener("popstate", () => {
  const st = history.state || {};
  if (!st.viewer && !$("viewer").hidden) closeViewer();
  const ref = st.ref !== undefined ? st.ref : location.hash.slice(1) || null;
  if (ref !== view.ref) setView(ref, "none");
});
history.replaceState({ ref: view.ref }, "", location.href);

// While in the app, poll the state; at a gate, keep saying hello so the page
// moves on by itself once the computer approves or the access mode changes.
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try { await (mode === "app" ? refresh() : hello()); } finally { busy = false; }
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  $("login-err").textContent = "";
  try {
    await api("login", { pin: $("pin").value.trim() });
    $("pin").value = "";
    await hello();
  } catch (err) {
    if (err.status === undefined) return setOnline(false);
    $("login-err").textContent = err.message;
    $("pin").select();
  }
};

$("rename").onclick = () => {
  $("rename-input").value = $("me-name").textContent;
  $("rename-form").hidden = false;
  $("rename-input").focus();
  $("rename-input").select();
};
$("rename-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api("rename", { name: $("rename-input").value });
    $("me-name").textContent = r.name;
    $("rename-form").hidden = true;
    toast("Renamed");
  } catch (err) {
    toast(err.message);
  }
};

// Uploads go one at a time so each gets the full Wi-Fi bandwidth and the
// progress bars are meaningful.
const queue = [];
let uploading = false;

function addUploads(files) {
  for (const file of files) {
    const bar = el("div");
    const meta = el("div", { class: "meta" }, "Waiting…");
    const row = el("div", { class: "up" },
      el("div", { class: "top" }, el("span", {}, file.name), el("span", { class: "small" }, size(file.size))),
      el("div", { class: "bar" }, bar), meta);
    $("uploads").prepend(row);
    queue.push({ file, row, bar, meta });
  }
  $("upload-hint").hidden = false;
  runQueue();
}

async function runQueue() {
  if (uploading) return;
  uploading = true;
  while (queue.length) await upload(queue.shift());
  uploading = false;
  $("upload-hint").hidden = true;
}

function upload({ file, row, bar, meta }) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const started = Date.now();
    xhr.open("POST", "api/upload");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const secs = (Date.now() - started) / 1000;
      const speed = secs > 0 ? e.loaded / secs : 0;
      const eta = speed > 0 ? Math.ceil((e.total - e.loaded) / speed) : null;
      bar.style.width = (e.loaded / e.total) * 100 + "%";
      meta.textContent = `${size(e.loaded)} of ${size(e.total)} · ${size(speed)}/s` +
        (eta != null ? ` · ${eta < 60 ? eta + "s" : Math.ceil(eta / 60) + " min"} left` : "");
    };
    const fail = (msg) => {
      row.classList.add("failed");
      meta.textContent = msg;
      resolve();
    };
    xhr.onload = () => {
      if (xhr.status === 401) { fail("Disconnected by the computer."); hello(); return; }
      if (xhr.status >= 300) {
        let msg = "Upload failed.";
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        return fail(msg);
      }
      const secs = (Date.now() - started) / 1000;
      bar.style.width = "100%";
      row.classList.add("done");
      meta.textContent = `Sent · ${size(file.size)} in ${secs < 1 ? "<1" : Math.round(secs)}s`;
      resolve();
    };
    xhr.onerror = () => fail("Connection lost. Check the Wi-Fi and try again.");
    meta.textContent = "Starting…";
    xhr.send(file);
  });
}

$("choose").onclick = () => $("picker").click();
$("picker").onchange = (e) => {
  addUploads([...e.target.files]);
  e.target.value = "";
};

$("send-text").onclick = async () => {
  const text = $("text").value;
  if (!text.trim()) return;
  try {
    await api("text", { text });
    $("text").value = "";
    toast("Sent");
    refresh();
  } catch (e) {
    if (e.status === 401) hello();
    else toast(e.message);
  }
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick();
});

tick();
setInterval(tick, 2000);
