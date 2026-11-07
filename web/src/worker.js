// PierHop's only server code. It serves the website and runs one small
// "front desk" (a Durable Object) per pier: it keeps the guest list, passes
// knocks to the host and relays the messages browsers need to connect to each
// other. Files never pass through here; they go browser to browser over WebRTC.

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const MAX_WAITING = 20;
const MAX_ON_PIER = 50;
const MAX_MESSAGE = 64 * 1024;
const HOST_GRACE_MS = 30_000; // a host who refreshes the page gets this long to come back

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ws = url.pathname.match(/^\/api\/piers\/([a-z-]+)\/ws$/);
    if (ws) {
      if (!CODE_RE.test(ws[1])) return new Response("Not found", { status: 404 });
      return env.PIERS.get(env.PIERS.idFromName(ws[1])).fetch(request);
    }
    // /new and /<pier code> are both the pier app.
    const path = url.pathname.replace(/\/$/, "").slice(1);
    if (path === "new" || CODE_RE.test(path)) {
      return env.ASSETS.fetch(new Request(new URL("/pier", url), request));
    }
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

export class Pier {
  constructor(state) {
    this.state = state;
    this.people = new Map(); // id -> { id, ws, name, device, status: "waiting" | "in" }
    this.hostId = null;
    this.hostToken = null;
    this.hostTimer = null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const person = { id: crypto.randomUUID().slice(0, 8), ws: server, name: "", device: "", status: "new" };
    server.addEventListener("message", (e) => this.onMessage(person, e.data));
    server.addEventListener("close", () => this.onClose(person));
    server.addEventListener("error", () => this.onClose(person));

    if (url.searchParams.get("create") === "1") {
      // A code is only ever used once, so an old link can't lead to someone else's pier.
      if (this.hostToken || (await this.state.storage.get("used"))) {
        this.send(person, { type: "error", reason: "taken" });
        server.close(4000, "taken");
      } else {
        await this.state.storage.put("used", true);
        this.hostToken = token();
        this.makeHost(person, url);
        this.send(person, { type: "created", you: person.id, token: this.hostToken });
      }
    } else if (url.searchParams.get("host") && url.searchParams.get("host") === this.hostToken && !this.isHostOnline()) {
      clearTimeout(this.hostTimer);
      this.makeHost(person, url);
      this.send(person, { type: "created", you: person.id, token: this.hostToken, peers: this.publicPeers(person.id), rejoined: true });
      this.broadcast({ type: "peer-joined", peer: this.public(person), host: true }, person.id);
      for (const p of this.people.values()) if (p.status === "waiting") this.send(person, { type: "knock", peer: this.public(p) });
    } else if (!this.hostToken) {
      this.send(person, { type: "no-pier" });
      server.close(4004, "no pier");
    } else {
      this.send(person, { type: "hello", hostName: this.hostName, hostOnline: this.isHostOnline() });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  makeHost(person, url) {
    person.status = "in";
    person.name = clean(url.searchParams.get("name"), 40) || "Host";
    person.device = clean(url.searchParams.get("device"), 20);
    this.hostId = person.id;
    this.hostName = person.name;
    this.people.set(person.id, person);
  }

  isHostOnline() {
    return this.hostId !== null && this.people.has(this.hostId);
  }

  public(p) {
    return { id: p.id, name: p.name, device: p.device, host: p.id === this.hostId };
  }

  publicPeers(exceptId) {
    return [...this.people.values()].filter((p) => p.status === "in" && p.id !== exceptId).map((p) => this.public(p));
  }

  send(p, msg) {
    try { p.ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast(msg, exceptId) {
    for (const p of this.people.values()) if (p.status === "in" && p.id !== exceptId) this.send(p, msg);
  }

  onMessage(person, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const isHost = person.id === this.hostId;

    if (msg.type === "knock" && person.status === "new" && this.hostToken) {
      const waiting = [...this.people.values()].filter((p) => p.status === "waiting").length;
      if (waiting >= MAX_WAITING || this.people.size >= MAX_ON_PIER) {
        this.send(person, { type: "full" });
        return person.ws.close(4029, "full");
      }
      person.name = clean(msg.name, 40) || "Guest";
      person.device = clean(msg.device, 20);
      person.status = "waiting";
      this.people.set(person.id, person);
      this.send(person, { type: "waiting" });
      const host = this.people.get(this.hostId);
      if (host) this.send(host, { type: "knock", peer: this.public(person) });
      return;
    }

    if (isHost && (msg.type === "allow" || msg.type === "deny" || msg.type === "remove")) {
      const p = this.people.get(msg.id);
      if (!p || p.id === this.hostId) return;
      if (msg.type === "allow" && p.status === "waiting") {
        p.status = "in";
        this.send(p, { type: "welcome", you: p.id, hostId: this.hostId, peers: this.publicPeers(p.id) });
        this.broadcast({ type: "peer-joined", peer: this.public(p) }, p.id);
      } else if (msg.type === "deny" && p.status === "waiting") {
        this.people.delete(p.id);
        this.send(p, { type: "denied" });
        p.ws.close(4003, "denied");
      } else if (msg.type === "remove" && p.status === "in") {
        this.people.delete(p.id);
        this.send(p, { type: "removed" });
        p.ws.close(4003, "removed");
        this.broadcast({ type: "peer-left", id: p.id });
      }
      return;
    }

    // WebRTC setup messages, only between people who are on the pier.
    if (msg.type === "signal" && person.status === "in") {
      const to = this.people.get(msg.to);
      if (to && to.status === "in") this.send(to, { type: "signal", from: person.id, data: msg.data });
      return;
    }

    if (msg.type === "end" && isHost) this.end();
  }

  onClose(person) {
    if (!this.people.has(person.id) || this.people.get(person.id).ws !== person.ws) return;
    this.people.delete(person.id);
    if (person.status === "waiting") {
      const host = this.people.get(this.hostId);
      if (host) this.send(host, { type: "knock-gone", id: person.id });
    } else if (person.status === "in") {
      this.broadcast({ type: "peer-left", id: person.id });
      if (person.id === this.hostId) {
        this.hostTimer = setTimeout(() => this.end(), HOST_GRACE_MS);
      }
    }
  }

  end() {
    clearTimeout(this.hostTimer);
    for (const p of this.people.values()) {
      this.send(p, { type: "ended" });
      try { p.ws.close(4010, "ended"); } catch {}
    }
    this.people.clear();
    this.hostId = null;
    this.hostToken = null;
  }
}
