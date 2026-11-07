"use strict";
// Writes downloads into the browser's private storage (the origin private file
// system) as they arrive, so a transfer can carry on from where it stopped,
// even after a refresh. Sync access handles write in place and only exist in
// workers, which is why this is a worker. Nothing here leaves the device.
//
// Every handle call is awaited: older Safari versions return promises from
// getSize/write/flush/truncate/close, newer browsers return values directly.

const handles = new Map(); // name -> FileSystemSyncAccessHandle
let root = null;

async function dir() {
  if (!root) root = await navigator.storage.getDirectory();
  return root;
}

async function open(name) {
  if (handles.has(name)) return handles.get(name);
  const file = await (await dir()).getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handles.set(name, handle);
  return handle;
}

async function close(name) {
  const h = handles.get(name);
  if (!h) return;
  handles.delete(name);
  try { await h.flush(); } catch {}
  try { await h.close(); } catch {}
}

const ops = {
  // Opens the file, cuts off anything past the last confirmed byte, and reports its size.
  async open({ name, keep }) {
    const h = await open(name);
    if (typeof keep === "number" && (await h.getSize()) > keep) await h.truncate(keep);
    return await h.getSize();
  },
  async write({ name, at, data }) {
    const h = await open(name);
    return await h.write(new Uint8Array(data), { at });
  },
  async flush({ name }) {
    const h = handles.get(name);
    if (h) await h.flush();
    return true;
  },
  async close({ name }) {
    await close(name);
    return true;
  },
  async remove({ name }) {
    await close(name);
    try { await (await dir()).removeEntry(name); } catch {}
    return true;
  },
  async list() {
    const names = [];
    for await (const [name] of (await dir()).entries()) names.push(name);
    return names;
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    self.postMessage({ id, ok: true, value: await ops[op](args || {}) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
