// PierHop's only server code: one small "front desk" (a Durable Object) per
// pier. It keeps the guest list, passes knocks to the host and relays the
// messages browsers need to connect to each other. Files never pass through
// here; they go browser to browser over WebRTC.
//
// This code never sees a pier code. Pier pages are served by the static file
// layer before any of this runs, and browsers address a pier by its room id: a
// slow, one-way fingerprint of the code (PBKDF2, then HKDF) that can't be
// turned back into the code or the keys derived from it.

const ROOM_RE = /^[0-9a-f]{32}$/;
const MAX_WAITING = 20;
const MAX_ON_PIER = 50;
const MAX_MESSAGE = 64 * 1024;
const HOST_GRACE_MS = 30_000; // a host who refreshes the page gets this long to come back

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ws = url.pathname.match(/^\/api\/piers\/([0-9a-f]+)\/ws$/);
    if (ws && ROOM_RE.test(ws[1])) return env.PIERS.get(env.PIERS.idFromName(ws[1])).fetch(request);
    return env.ASSETS.fetch(request);
  },
};

function clean(text, max) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
}

// Uses the WebSocket Hibernation API: between messages the pier sleeps and
// costs nothing, so anything that must survive lives either on the socket
// (serializeAttachment: who this person is) or in storage.
//
// Storage holds only what the guest list needs: "meta" (who the host is) and
// one "g:<ticket>" entry per person let in, so they can rejoin after a
// dropped connection or a refresh without knocking again. Each person keeps
// the same id across reconnects, which lets browsers resume transfers.
// Nothing here ever carries a file, a file name or the pier's secret key:
// those only travel inside the encrypted browser-to-browser connections.
export class Pier {
  constructor(state) {
    this.state = state;
  }

  // --- state helpers ---

  sockets() {
    return this.state.getWebSockets();
  }

  info(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }

  find(id) {
    return this.sockets().find((ws) => { const p = this.info(ws); return p.id === id && p.status !== "gone"; });
  }

  async meta() {
    return (await this.state.storage.get("meta")) || null; // { hostToken, hostId, hostName }
  }

  hostOnline(meta) {
    return !!meta && !!this.find(meta.hostId) && this.info(this.find(meta.hostId)).status === "in";
  }

  public(p, meta) {
    return { id: p.id, name: p.name, device: p.device, host: !!meta && p.id === meta.hostId };
  }

  onPier(meta, exceptId) {
    return this.sockets().map((ws) => this.info(ws)).filter((p) => p.status === "in" && p.id !== exceptId).map((p) => this.public(p, meta));
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast(msg, exceptId) {
    for (const ws of this.sockets()) {
      const p = this.info(ws);
      if (p.status === "in" && p.id !== exceptId) this.send(ws, msg);
    }
  }

  // A returning person's old connection may not have noticed it's dead yet.
  dropOld(id) {
    for (const ws of this.sockets()) {
      const p = this.info(ws);
      if (p.id === id && p.status !== "gone") {
        ws.serializeAttachment({ ...p, status: "gone" });
        try { ws.close(4001, "replaced"); } catch {}
      }
    }
  }

  // --- connections ---

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    const meta = await this.meta();
    const q = (k) => url.searchParams.get(k);

    if (q("create") === "1") {
      // A code is only ever used once, so an old link can't lead to someone else's pier.
      if (meta || (await this.state.storage.get("used"))) {
        this.send(server, { type: "error", reason: "taken" });
        server.close(4000, "taken");
      } else {
        const person = { id: newId(), status: "in", ...this.details(url, "Host") };
        server.serializeAttachment(person);
        const fresh = { hostToken: token(), hostId: person.id, hostName: person.name };
        await this.state.storage.put({ used: true, meta: fresh });
        this.send(server, { type: "created", you: person.id, token: fresh.hostToken });
      }
    } else if (meta && q("host") && q("host") === meta.hostToken) {
      // The host is back (refresh or new network): same id, same pier.
      await this.state.storage.deleteAlarm();
      this.dropOld(meta.hostId);
      const person = { id: meta.hostId, status: "in", ...this.details(url, meta.hostName) };
      server.serializeAttachment(person);
      if (person.name !== meta.hostName) await this.state.storage.put("meta", { ...meta, hostName: person.name });
      this.send(server, { type: "created", you: person.id, token: meta.hostToken, peers: this.onPier(meta, person.id), rejoined: true });
      this.broadcast({ type: "peer-joined", peer: this.public(person, meta) }, person.id);
      for (const ws of this.sockets()) {
        const p = this.info(ws);
        if (p.status === "waiting") this.send(server, { type: "knock", peer: this.public(p, meta) });
      }
    } else if (meta && q("guest") && (await this.state.storage.get("g:" + q("guest")))) {
      // Someone the host already let in, coming back: no need to knock again.
      const ticket = q("guest");
      const rec = await this.state.storage.get("g:" + ticket);
      this.dropOld(rec.id);
      const person = { id: rec.id, name: rec.name, device: rec.device, status: "in", ticket };
      server.serializeAttachment(person);
      this.send(server, { type: "welcome", you: person.id, hostId: meta.hostId, peers: this.onPier(meta, person.id), ticket, rejoined: true });
      this.broadcast({ type: "peer-joined", peer: this.public(person, meta) }, person.id);
    } else if (!meta) {
      this.send(server, { type: "no-pier" });
      server.close(4004, "no pier");
    } else {
      server.serializeAttachment({ id: newId(), name: "", device: "", status: "new" });
      this.send(server, { type: "hello", hostName: meta.hostName, hostOnline: this.hostOnline(meta) });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  details(url, fallbackName) {
    return { name: clean(url.searchParams.get("name"), 40) || fallbackName, device: clean(url.searchParams.get("device"), 20) };
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const person = this.info(ws);
    if (!person.id || person.status === "gone") return;
    const meta = await this.meta();
    if (!meta) return;
    const isHost = person.id === meta.hostId;

    if (msg.type === "knock" && person.status === "new") {
      const all = this.sockets().map((s) => this.info(s));
      if (all.filter((p) => p.status === "waiting").length >= MAX_WAITING || all.filter((p) => p.status === "in").length >= MAX_ON_PIER) {
        this.send(ws, { type: "full" });
        return ws.close(4029, "full");
      }
      person.name = clean(msg.name, 40) || "Guest";
      person.device = clean(msg.device, 20);
      person.status = "waiting";
      ws.serializeAttachment(person);
      this.send(ws, { type: "waiting" });
      const host = this.find(meta.hostId);
      if (host) this.send(host, { type: "knock", peer: this.public(person, meta) });
      return;
    }

    if (isHost && (msg.type === "allow" || msg.type === "deny" || msg.type === "remove")) {
      const target = this.find(msg.id);
      if (!target || msg.id === meta.hostId) return;
      const p = this.info(target);
      if (msg.type === "allow" && p.status === "waiting") {
        const ticket = token();
        await this.state.storage.put("g:" + ticket, { id: p.id, name: p.name, device: p.device });
        const admitted = { ...p, status: "in", ticket };
        target.serializeAttachment(admitted);
        this.send(target, { type: "welcome", you: p.id, hostId: meta.hostId, peers: this.onPier(meta, p.id), ticket });
        this.broadcast({ type: "peer-joined", peer: this.public(admitted, meta) }, p.id);
      } else if (msg.type === "deny" && p.status === "waiting") {
        target.serializeAttachment({ ...p, status: "gone" });
        this.send(target, { type: "denied" });
        target.close(4003, "denied");
      } else if (msg.type === "remove" && p.status === "in") {
        if (p.ticket) await this.state.storage.delete("g:" + p.ticket);
        target.serializeAttachment({ ...p, status: "gone" });
        this.send(target, { type: "removed" });
        target.close(4003, "removed");
        this.broadcast({ type: "peer-left", id: p.id });
      }
      return;
    }

    // WebRTC setup messages, only between people who are on the pier. They are
    // signed in the browser with a key from the pier link, which this server
    // never sees, so tampering with them here would be detected and refused.
    if (msg.type === "signal" && person.status === "in") {
      const to = this.find(msg.to);
      if (to && this.info(to).status === "in") this.send(to, { type: "signal", from: person.id, data: msg.data });
      return;
    }

    if (msg.type === "end" && isHost) await this.end();
  }

  async webSocketClose(ws) {
    await this.left(ws);
    try { ws.close(1000, "bye"); } catch {}
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  async left(ws) {
    const person = this.info(ws);
    if (!person.id || person.status === "gone") return;
    ws.serializeAttachment({ ...person, status: "gone" });
    const meta = await this.meta();
    if (!meta) return;
    if (person.status === "waiting") {
      const host = this.find(meta.hostId);
      if (host) this.send(host, { type: "knock-gone", id: person.id });
    } else if (person.status === "in") {
      this.broadcast({ type: "peer-left", id: person.id }, person.id);
      if (person.id === meta.hostId) await this.state.storage.setAlarm(Date.now() + HOST_GRACE_MS);
    }
  }

  // The host didn't come back in time.
  async alarm() {
    const meta = await this.meta();
    if (meta && !this.hostOnline(meta)) await this.end();
  }

  async end() {
    const tickets = await this.state.storage.list({ prefix: "g:" });
    await this.state.storage.delete([...tickets.keys(), "meta"]);
    await this.state.storage.deleteAlarm();
    for (const ws of this.sockets()) {
      ws.serializeAttachment({ ...this.info(ws), status: "gone" });
      this.send(ws, { type: "ended" });
      try { ws.close(4010, "ended"); } catch {}
    }
  }
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}
