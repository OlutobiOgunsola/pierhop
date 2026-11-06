"use strict";
const KEY = document.querySelector('meta[name="pierhop-key"]').content;
const $ = (id) => document.getElementById(id);
const KIND_ICONS = { android: "📱", "android-tablet": "📱", iphone: "📱", ipad: "📱", mac: "💻", windows: "💻", linux: "💻", other: "🔗" };
const rendered = {};
const openTargets = new Set();
let state = null;

function el(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style") n.setAttribute("style", v);
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

function ago(t) {
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  const d = new Date(t * 1000);
  if (s < 20 * 3600) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 1800);
}

async function api(path, body) {
  const res = await fetch("/api/host/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-PierHop-Key": KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// Fire an action, refresh, and surface errors as a toast.
function act(path, body, done) {
  return api(path, body).then((r) => { if (done) toast(done); refresh(); return r; }, (e) => toast(e.message));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { toast("Couldn't copy"); }
}

// Only rebuild a section when its data actually changed, so hover and focus
// states survive the polling. A section with a focused text field is left
// alone so typing isn't interrupted.
function section(name, box, data, render) {
  if (box && box.contains(document.activeElement) && document.activeElement.matches("input[type=text]")) return;
  const sig = JSON.stringify(data);
  if (rendered[name] === sig) return;
  rendered[name] = sig;
  render(data);
}

function deviceNames(ids) {
  const byId = Object.fromEntries(state.devices.map((d) => [d.id, d.name]));
  return ids.map((id) => byId[id]).filter(Boolean);
}

function visibilityLabel(targets) {
  if (targets === null) return "All devices";
  if (!targets.length) return "No devices";
  const names = deviceNames(targets);
  return names.length === 1 ? "Only " + names[0] : names.length + " devices";
}

function render(s) {
  const online = s.devices.filter((d) => d.online).length;
  $("status").textContent = online ? `${online} device${online > 1 ? "s" : ""} connected` : "No devices connected";
  $("status").classList.toggle("on", online > 0);
  $("instance-name").textContent = s.name;
  document.title = "PierHop · " + s.name;

  section("connect", null, [s.device_url, s.pin, s.access, s.link, s.custom_link, s.remember], () => {
    const qr = qrcode(0, "M");
    qr.addData(s.device_url);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $("url").textContent = s.device_url;
    $("pin").textContent = s.pin;
    $("pin-wrap").hidden = s.access !== "pin";
    $("new-pin-row").hidden = s.access !== "pin";
    const note = $("access-note");
    note.hidden = s.access === "pin";
    note.textContent = s.access === "approve"
      ? "New devices need your approval. Requests show up at the top of this page."
      : "Anyone with the link can connect. Only use this on networks you trust.";
    for (const r of document.querySelectorAll('input[name="access"]')) r.checked = r.value === s.access;
    $("remember").checked = s.remember;
    $("devices-note").textContent = s.remember
      ? "These devices reconnect by themselves when PierHop restarts. Disconnect one to make it get in again."
      : "Devices need the PIN or your approval again when PierHop restarts.";
  });

  section("settings", $("name").parentNode, [s.name, s.custom_name, s.device_url, s.link, s.custom_link], () => {
    $("name").value = s.custom_name || "";
    $("name").placeholder = s.name;
    $("prefix").textContent = s.device_url.slice(0, s.device_url.length - s.link.length - 1);
    if (document.activeElement !== $("link")) $("link").value = s.custom_link ? s.link : "";
    $("random-link").disabled = !s.custom_link;
  });

  section("picker", null, s.native_picker, (native) => {
    $("pick-files").hidden = $("pick-folder").hidden = !native;
  });

  section("requests", null, s.requests, (reqs) => {
    const box = $("requests");
    box.replaceChildren();
    for (const r of reqs) {
      box.append(el("div", { class: "request" },
        el("span", { style: "font-size:20px" }, KIND_ICONS[r.kind] || "🔗"),
        el("div", { class: "grow" },
          el("div", {}, el("strong", {}, r.name), " wants to connect"),
          el("div", { class: "small muted" }, r.ip)),
        el("button", { class: "primary", onclick: () => act("devices/approve", { id: r.id }, `${r.name} connected`) }, "Allow"),
        el("button", { onclick: () => act("devices/deny", { id: r.id }) }, "Deny"),
      ));
    }
  });

  section("devices", $("devices"), s.devices, (devices) => {
    const ul = $("devices");
    ul.replaceChildren();
    $("remove-all").hidden = devices.length < 2;
    $("devices-note").hidden = !devices.length;
    if (!devices.length) ul.append(el("li", { class: "empty" }, "No devices yet. Scan the QR code to connect one."));
    for (const d of devices) {
      const input = el("input", {
        type: "text", class: "dev-name", value: d.name, maxLength: 40, title: "Rename",
        onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = d.name; e.target.blur(); } },
        onchange: (e) => { if (e.target.value.trim() && e.target.value !== d.name) act("devices/rename", { id: d.id, name: e.target.value }); },
      });
      ul.append(el("li", {},
        el("div", { class: "line" },
          el("span", { class: "dot" + (d.online ? " on" : ""), title: d.online ? "Online" : "Offline" }),
          el("span", {}, KIND_ICONS[d.kind] || "🔗"),
          input,
          el("button", { class: "link danger", onclick: () => act("devices/remove", { id: d.id }, `${d.name} disconnected`) }, "Disconnect")),
        el("div", { class: "small muted", style: "margin-left:40px" },
          [d.ip, d.online ? "online" : "last seen " + ago(d.last_seen)].filter(Boolean).join(" · ")),
      ));
    }
  });

  const deviceSig = s.devices.map((d) => [d.id, d.name]);
  section("text-target", null, deviceSig, () => {
    const sel = $("text-target");
    const keep = sel.value;
    sel.replaceChildren(el("option", { value: "" }, "All devices"),
      ...s.devices.map((d) => el("option", { value: d.id }, d.name)));
    sel.value = s.devices.some((d) => d.id === keep) ? keep : "";
  });

  section("shared", null, [s.shared, deviceSig, [...openTargets]], () => {
    const ul = $("shared");
    ul.replaceChildren();
    if (!s.shared.length) ul.append(el("li", { class: "empty" }, "Nothing shared yet."));
    for (const f of s.shared) {
      const li = el("li", {},
        el("div", { class: "line" },
          el("span", { class: "name", title: f.name }, (f.kind === "folder" ? "🗂 " : "") + f.name),
          el("span", { class: "muted small" }, (f.kind === "folder" ? `${f.count} file${f.count === 1 ? "" : "s"} · ` : "") + size(f.size)),
          el("button", {
            class: "link vis", title: "Choose which devices can see this",
            onclick: () => { openTargets.has(f.id) ? openTargets.delete(f.id) : openTargets.add(f.id); render(state); },
          }, visibilityLabel(f.targets) + " ▾"),
          el("button", { class: "icon", title: "Stop sharing", onclick: () => act("remove", { id: f.id }) }, "×")),
      );
      if (openTargets.has(f.id)) li.append(targetsPicker(f, s.devices));
      ul.append(li);
    }
  });

  section("transfers", null, s.transfers.map((t) => [t.id, t.done, t.status]), () => {
    const box = $("transfers");
    box.replaceChildren();
    if (!s.transfers.length) box.append(el("div", { class: "empty" }, "No transfers yet."));
    for (const t of s.transfers) {
      const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : 100;
      const speed = t.elapsed > 0 ? t.done / t.elapsed : 0;
      let right;
      if (t.status === "active") {
        const eta = speed > 0 ? Math.ceil((t.total - t.done) / speed) : null;
        right = `${size(speed)}/s` + (eta != null ? ` · ${eta < 60 ? eta + "s" : Math.ceil(eta / 60) + " min"} left` : "");
      } else if (t.status === "done") {
        right = `Done · ${size(speed)}/s`;
      } else {
        right = "Stopped";
      }
      box.append(el("div", { class: "t " + t.status },
        el("div", { class: "name", title: t.name }, (t.kind === "upload" ? `⬇ From ${t.device}: ` : `⬆ To ${t.device}: `) + t.name),
        el("div", { class: "bar" }, el("div", { style: `width:${pct}%` })),
        el("div", { class: "meta" }, el("span", {}, `${size(t.done)} of ${size(t.total)}`), el("span", {}, right)),
      ));
    }
  });

  section("received", null, [s.received, s.save_dir], () => {
    $("save-dir").textContent = "Saved to " + s.save_dir;
    const ul = $("received");
    ul.replaceChildren();
    if (!s.received.length) ul.append(el("li", { class: "empty" }, "Files sent from devices will appear here."));
    for (const r of s.received) {
      ul.append(el("li", {},
        el("div", { class: "line" },
          el("span", { class: "name", title: r.name }, r.name),
          el("span", { class: "muted small" }, size(r.size)),
          el("button", { class: "link", onclick: () => act("open", { id: r.id }) }, "Open"),
          s.native_picker ? el("button", { class: "link", onclick: () => act("reveal", { id: r.id }) }, "Show in Finder") : null),
        el("div", { class: "small muted" }, `From ${r.from} · ${ago(r.time)}`),
      ));
    }
  });

  section("texts", null, [s.texts, deviceSig], () => {
    const box = $("texts");
    box.replaceChildren();
    $("clear-texts").hidden = !s.texts.length;
    for (const t of s.texts) {
      const isUrl = /^https?:\/\/\S+$/i.test(t.text.trim());
      const who = t.from === "host"
        ? "You → " + (t.targets === null ? "all devices" : deviceNames(t.targets).join(", ") || "no devices")
        : "From " + t.from_name;
      box.append(el("div", { class: "text-item" },
        el("div", { class: "small muted" }, `${who} · ${ago(t.time)}`),
        el("div", { class: "text-body" }, t.text),
        el("div", { class: "row" },
          el("button", { class: "link", onclick: () => copy(t.text) }, "Copy"),
          isUrl ? el("a", { class: "link", href: t.text.trim(), target: "_blank", rel: "noopener noreferrer" }, "Open") : null),
      ));
    }
  });
}

function targetsPicker(f, devices) {
  const all = f.targets === null;
  const box = el("div", { class: "targets" });
  const set = (targets) => act("targets", { id: f.id, targets });
  box.append(el("label", {},
    el("input", { type: "checkbox", checked: all, onchange: (e) => set(e.target.checked ? null : []) }),
    "All devices, including new ones"));
  for (const d of devices) {
    const on = all || f.targets.includes(d.id);
    box.append(el("label", {},
      el("input", {
        type: "checkbox", checked: on,
        onchange: (e) => {
          const current = all ? devices.map((x) => x.id) : f.targets;
          set(e.target.checked ? [...current, d.id] : current.filter((id) => id !== d.id));
        },
      }),
      d.name));
  }
  if (!devices.length) box.append(el("span", { class: "small muted" }, "Connect a device to limit this file to it."));
  return box;
}

let failures = 0;
async function refresh() {
  try {
    state = await api("state");
    failures = 0;
    render(state);
  } catch (e) {
    if (++failures === 3) {
      $("status").textContent = "PierHop stopped. Run it again in the terminal.";
      $("status").classList.remove("on");
    }
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/host/upload");
    xhr.setRequestHeader("X-PierHop-Key", KEY);
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = "Couldn't add " + file.name;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Couldn't add " + file.name));
    xhr.send(file);
  });
}

async function addDropped(dt) {
  const files = [];
  let skippedFolders = 0;
  for (const item of dt.items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry && entry.isDirectory) { skippedFolders++; continue; }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  if (skippedFolders) toast($("pick-folder").hidden ? "Folders can't be dropped. Zip them first." : "Use “Add folder…” for folders");
  for (const f of files) {
    try { await uploadFile(f); } catch (e) { toast(e.message); }
    refresh();
  }
}

async function pick(kind) {
  const btns = [$("pick-files"), $("pick-folder")];
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await api("pick", { kind });
    if (r.added.length) toast(`Added ${r.added.length} item${r.added.length > 1 ? "s" : ""}`);
  } catch (e) { toast(e.message); }
  btns.forEach((b) => (b.disabled = false));
  refresh();
}

async function settings(body, done) {
  $("settings-err").textContent = "";
  try {
    await api("settings", body);
    if (done) toast(done);
    rendered.connect = rendered.settings = null;
    await refresh();
  } catch (e) {
    $("settings-err").textContent = e.message;
  }
}

$("copy-url").onclick = () => state && copy(state.device_url);
$("pick-files").onclick = () => pick("files");
$("pick-folder").onclick = () => pick("folder");
$("save-name").onclick = () => settings({ name: $("name").value }, "Name updated");
$("name").onkeydown = (e) => { if (e.key === "Enter") $("save-name").click(); };
$("save-link").onclick = () => settings({ link: $("link").value.trim() || null }, "Link updated");
$("link").onkeydown = (e) => { if (e.key === "Enter") $("save-link").click(); };
$("random-link").onclick = () => settings({ link: null }, "Link updated");
for (const r of document.querySelectorAll('input[name="access"]')) r.onchange = (e) => settings({ access: e.target.value });
$("remember").onchange = (e) => settings({ remember: e.target.checked },
  e.target.checked ? "Devices will be remembered" : "Devices will need to get in again after a restart");
$("new-pin").onclick = () => settings({ new_pin: true }, "New PIN set");
$("remove-all").onclick = () => act("devices/remove-all", {}, "All devices disconnected");
$("send-text").onclick = async () => {
  const text = $("text").value;
  if (!text.trim()) return;
  const target = $("text-target").value;
  try {
    await api("text", { text, targets: target ? [target] : null });
    $("text").value = "";
    refresh();
  } catch (e) { toast(e.message); }
};
$("text").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("send-text").click(); };
$("clear-texts").onclick = () => act("texts/clear", {});

const drop = $("drop");
["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || !e.relatedTarget) drop.classList.remove("over"); }));
document.addEventListener("drop", (e) => addDropped(e.dataTransfer));

refresh();
setInterval(refresh, 700);
