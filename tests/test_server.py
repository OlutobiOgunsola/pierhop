"""End-to-end tests: a real server on a random port, driven over HTTP."""
import http.client
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
import zipfile
from urllib.parse import quote

from pierhop import server as server_mod
from pierhop.server import Server, State, lan_ip, load_instance_config

ANDROID = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
LAN = lan_ip()
needs_lan = unittest.skipIf(LAN == "127.0.0.1", "no LAN address on this machine")


class Device:
    """A browser on another device: keeps its own cookie."""

    def __init__(self, t, ua=ANDROID, ip="127.0.0.1"):
        self.t, self.ua, self.ip, self.cookie = t, ua, ip, None

    def call(self, method, rest, body=None, headers=None):
        h = {"User-Agent": self.ua}
        if self.cookie:
            h["Cookie"] = self.cookie
        h.update(headers or {})
        status, hdrs, data = self.t.request(method, f"/{self.t.state.link}/{rest}", body, h, host=self.ip)
        if "Set-Cookie" in hdrs:
            self.cookie = hdrs["Set-Cookie"].split(";")[0]
        return status, hdrs, data

    def json(self, method, rest, body=None, headers=None):
        status, _, data = self.call(method, rest, body, headers)
        return status, json.loads(data or b"{}")

    def hello(self):
        return self.json("POST", "api/hello", {})[1]

    def connect(self):
        """Gets this device fully connected in PIN mode."""
        self.hello()
        status, _ = self.json("POST", "api/login", {"pin": self.t.state.pin})
        self.t.assertEqual(status, 200)
        return self

    def state(self):
        return self.json("GET", "api/state")


class PierHopTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.save_dir = os.path.join(self.tmp, "received")
        self.config = os.path.join(self.tmp, "config.json")
        self.state = State(self.save_dir, config_path=self.config, notifications=False, quiet=True,
                           default_name="Test Mac")
        self.server = Server(0, self.state)
        self.state.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        status, _, page = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.key = page.decode().split('name="pierhop-key" content="')[1].split('"')[0]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.state.cleanup()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers ------------------------------------------------------------

    def request(self, method, path, body=None, headers=None, host="127.0.0.1", host_header=None):
        conn = http.client.HTTPConnection(host, self.state.port, timeout=10)
        h = {"Host": f"{host_header or host}:{self.state.port}"}
        h.update(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=h)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, dict(r.getheaders()), data

    def host(self, action, body=None, headers=None):
        method = "GET" if body is None and action == "state" else "POST"
        h = {"X-PierHop-Key": self.key}
        h.update(headers or {})
        status, _, data = self.request(method, "/api/host/" + action, body if body is not None else ({} if method == "POST" else None), h)
        return status, json.loads(data or b"{}")

    def snapshot(self):
        return self.host("state")[1]

    def share(self, name, content):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as f:
            f.write(content)
        return self.state.share_path(path)

    # --- host page protection -----------------------------------------------

    def test_host_api_needs_key(self):
        status, _, _ = self.request("GET", "/api/host/state")
        self.assertEqual(status, 403)

    def test_host_page_rejects_foreign_host_header(self):
        status, _, _ = self.request("GET", "/", host_header="evil.example")
        self.assertEqual(status, 404)

    @needs_lan
    def test_host_page_not_reachable_from_lan(self):
        self.assertEqual(self.request("GET", "/", host=LAN)[0], 404)
        self.assertEqual(self.request("GET", "/api/host/state", host=LAN, headers={"X-PierHop-Key": self.key})[0], 404)

    # --- access modes -------------------------------------------------------

    def test_pin_mode(self):
        d = Device(self)
        h = d.hello()
        self.assertEqual((h["status"], h["access"], h["instance"]), ("new", "pin", "Test Mac"))
        self.assertEqual(d.state()[0], 401)
        self.assertEqual(d.json("POST", "api/login", {"pin": "0" if self.state.pin != "0" else "1"})[0], 401)
        self.assertEqual(d.json("POST", "api/login", {"pin": self.state.pin})[0], 200)
        status, s = d.state()
        self.assertEqual((status, s["device"]["name"]), (200, "Android phone"))
        self.assertEqual([x["name"] for x in self.snapshot()["devices"]], ["Android phone"])

    def test_pin_lockout_is_per_ip(self):
        d = Device(self)
        d.hello()
        codes = [d.json("POST", "api/login", {"pin": "x"})[0] for _ in range(6)]
        self.assertEqual(codes, [401, 401, 401, 401, 429, 429])
        self.assertEqual(d.json("POST", "api/login", {"pin": self.state.pin})[0], 429)
        if LAN != "127.0.0.1":
            Device(self, ip=LAN).connect()

    def test_open_mode_lets_everyone_in(self):
        waiting = Device(self)
        waiting.hello()
        self.host("settings", {"access": "open"})
        self.assertEqual(waiting.state()[0], 200, "devices waiting for a PIN get in when the mode opens up")
        self.assertEqual(Device(self).hello()["status"], "approved")

    def test_approve_mode(self):
        self.host("settings", {"access": "approve"})
        a, b = Device(self), Device(self, ua=IPHONE)
        self.assertEqual(a.hello()["status"], "new")
        b.hello()
        reqs = self.snapshot()["requests"]
        self.assertEqual([r["name"] for r in reqs], ["Android phone", "iPhone"])
        self.assertEqual(a.json("POST", "api/login", {"pin": self.state.pin})[0], 401, "PIN can't bypass approval")

        self.host("devices/approve", {"id": reqs[0]["id"]})
        self.assertEqual(a.state()[0], 200)
        self.host("devices/deny", {"id": reqs[1]["id"]})
        h = b.hello()
        self.assertEqual(h["status"], "denied")
        self.assertGreater(h["retry_in"], 0)
        self.assertEqual(b.state()[0], 401)
        self.assertEqual(self.snapshot()["requests"], [])

    def test_disconnect(self):
        a, b = Device(self).connect(), Device(self).connect()
        a_id = a.state()[1]["device"]["id"]
        self.host("devices/remove", {"id": a_id})
        status, body = a.state()
        self.assertEqual((status, body["status"]), (401, "unknown"))
        self.assertEqual(a.hello()["status"], "new", "a disconnected device has to get in again")
        self.assertEqual(b.state()[0], 200)
        self.host("devices/remove-all")
        self.assertEqual(b.state()[0], 401)
        self.assertEqual(self.snapshot()["devices"], [])

    def test_new_pin_keeps_connected_devices(self):
        d = Device(self).connect()
        old = self.state.pin
        self.host("settings", {"new_pin": True})
        self.assertNotEqual(self.state.pin, old)
        self.assertEqual(d.state()[0], 200)

    # --- device names ------------------------------------------------------

    def test_device_names(self):
        a, b, c = Device(self).connect(), Device(self).connect(), Device(self, ua=IPHONE).connect()
        self.assertEqual([x["name"] for x in self.snapshot()["devices"]], ["Android phone", "Android phone 2", "iPhone"])
        status, r = a.json("POST", "api/rename", {"name": "  Tobi's\x00 Pixel  "})
        self.assertEqual((status, r["name"]), (200, "Tobi's Pixel"))
        b_id = b.state()[1]["device"]["id"]
        self.host("devices/rename", {"id": b_id, "name": "tobi's pixel"})
        self.assertEqual(b.state()[1]["device"]["name"], "tobi's pixel 2", "names stay unique")
        self.assertEqual(c.json("POST", "api/rename", {"name": "   "})[0], 400)

    # --- per-device sharing ------------------------------------------------

    def test_targets(self):
        a, b = Device(self).connect(), Device(self).connect()
        a_id = a.state()[1]["device"]["id"]
        only_a = self.share("only-a.txt", b"a")
        everyone = self.share("everyone.txt", b"e")
        self.assertEqual(self.host("targets", {"id": only_a["id"], "targets": [a_id, "bogus"]})[0], 200)
        self.assertEqual(self.host("targets", {"id": only_a["id"], "targets": "nope"})[0], 400)

        names = lambda d: sorted(f["name"] for f in d.state()[1]["files"])
        self.assertEqual(names(a), ["everyone.txt", "only-a.txt"])
        self.assertEqual(names(b), ["everyone.txt"])
        self.assertEqual(b.call("GET", "dl/" + only_a["id"])[0], 404)
        self.assertEqual(a.call("GET", "dl/" + only_a["id"])[2], b"a")
        self.assertEqual(names(Device(self).connect()), ["everyone.txt"], "new devices see 'all devices' files")

        self.host("devices/remove", {"id": a_id})
        shared = {f["name"]: f["targets"] for f in self.snapshot()["shared"]}
        self.assertEqual(shared, {"only-a.txt": [], "everyone.txt": None})

    def test_texts_are_private_per_device(self):
        a, b = Device(self).connect(), Device(self).connect()
        b_id = b.state()[1]["device"]["id"]
        a.json("POST", "api/text", {"text": "from a"})
        self.host("text", {"text": "to b", "targets": [b_id]})
        self.host("text", {"text": "to all", "targets": None})
        texts = lambda d: [t["text"] for t in d.state()[1]["texts"]]
        self.assertEqual(texts(a), ["to all", "from a"])
        self.assertEqual(texts(b), ["to all", "to b"])
        self.assertEqual([t["text"] for t in self.snapshot()["texts"]], ["to all", "to b", "from a"])
        self.assertTrue(a.state()[1]["texts"][1]["mine"])
        self.host("settings", {"name": "Renamed Mac"})
        self.assertEqual(a.state()[1]["texts"][0]["from_name"], "Renamed Mac", "host texts use the current name")
        self.assertEqual(self.host("text", {"text": "  "})[0], 400)

    # --- transfers ----------------------------------------------------------

    def test_downloads(self):
        content = os.urandom(300_000)
        item = self.share("song.wav", content)
        d = Device(self).connect()
        status, h, data = d.call("GET", "dl/" + item["id"])
        self.assertEqual((status, data), (200, content))
        self.assertIn("attachment", h["Content-Disposition"])
        status, h, data = d.call("GET", "dl/" + item["id"], headers={"Range": "bytes=100-199"})
        self.assertEqual((status, data, h["Content-Range"]), (206, content[100:200], f"bytes 100-199/{len(content)}"))
        self.assertEqual(d.call("GET", "dl/" + item["id"], headers={"Range": "bytes=-50"})[2], content[-50:])
        self.assertEqual(d.call("GET", "dl/" + item["id"], headers={"Range": f"bytes={len(content) + 5}-"})[0], 416)
        self.assertEqual(d.call("GET", "dl/nope")[0], 404)
        self.assertEqual(Device(self).call("GET", "dl/" + item["id"])[0], 401)
        t = self.snapshot()["transfers"][0]
        self.assertEqual((t["kind"], t["device"], t["status"]), ("download", "Android phone", "done"))

    def make_album(self):
        folder = os.path.join(self.tmp, "album")
        os.makedirs(os.path.join(folder, "disc 2"))
        os.makedirs(os.path.join(folder, ".git"))
        files = {"a.txt": b"a", "track 10.mp3": b"10", "track 2.mp3": b"2", "disc 2/b.txt": b"b" * 5000,
                 ".DS_Store": b"x", ".git/config": b"x"}
        for rel, content in files.items():
            with open(os.path.join(folder, rel), "wb") as f:
                f.write(content)
        return folder

    def unzip(self, data):
        zf = zipfile.ZipFile(io.BytesIO(data))
        self.assertIsNone(zf.testzip())
        return {n: zf.read(n) for n in zf.namelist()}

    def test_folder_zip_is_streamed(self):
        item = self.state.share_path(self.make_album())
        self.assertEqual((item["name"], item["kind"], item["count"]), ("album", "folder", 4))
        d = Device(self).connect()
        status, h, data = d.call("GET", "dl/" + item["id"])
        self.assertEqual((status, h["Content-Type"]), (200, "application/zip"))
        self.assertEqual(int(h["Content-Length"]), len(data))
        self.assertIn('filename="album.zip"', h["Content-Disposition"])
        self.assertEqual(self.unzip(data), {"album/a.txt": b"a", "album/track 2.mp3": b"2",
                                            "album/track 10.mp3": b"10", "album/disc 2/b.txt": b"b" * 5000})
        t = self.snapshot()["transfers"][0]
        self.assertEqual((t["name"], t["done"], t["total"], t["status"]), ("album.zip", len(data), len(data), "done"))

    def test_zip64_layout(self):
        old = server_mod.ZIP64_LIMIT
        server_mod.ZIP64_LIMIT = 100  # every file and offset past 100 bytes uses the ZIP64 fields
        try:
            item = self.state.share_path(self.make_album())
            status, h, data = Device(self).connect().call("GET", "dl/" + item["id"])
        finally:
            server_mod.ZIP64_LIMIT = old
        self.assertEqual(int(h["Content-Length"]), len(data))
        self.assertEqual(self.unzip(data)["album/disc 2/b.txt"], b"b" * 5000)

    def test_browse_folder(self):
        item = self.state.share_path(self.make_album())
        d = Device(self).connect()
        status, top = d.json("GET", "api/browse?ref=" + item["id"])
        self.assertEqual(status, 200)
        self.assertEqual([(e["name"], e["kind"]) for e in top["entries"]],
                         [("disc 2", "folder"), ("a.txt", "file"), ("track 2.mp3", "file"), ("track 10.mp3", "file")])
        self.assertEqual([e["preview"] for e in top["entries"][1:]], ["text", "audio", "audio"])
        sub_ref = top["entries"][0]["ref"]
        self.assertEqual(sub_ref, item["id"] + "/disc%202")
        status, sub = d.json("GET", "api/browse?ref=" + quote(sub_ref))
        self.assertEqual([c["name"] for c in sub["crumbs"]], ["album", "disc 2"])
        self.assertEqual(d.call("GET", "dl/" + sub["entries"][0]["ref"])[2], b"b" * 5000)
        self.assertEqual(self.unzip(d.call("GET", "dl/" + sub_ref)[2]), {"disc 2/b.txt": b"b" * 5000})

        other = Device(self).connect()
        other_id = other.state()[1]["device"]["id"]
        self.host("targets", {"id": item["id"], "targets": [other_id]})
        self.assertEqual(d.json("GET", "api/browse?ref=" + item["id"])[0], 404, "visibility covers the whole folder")
        self.assertEqual(d.call("GET", "dl/" + sub_ref)[0], 404)

    def test_browse_stays_inside_the_folder(self):
        folder = self.make_album()
        secret = os.path.join(self.tmp, "secret.txt")
        with open(secret, "w") as f:
            f.write("secret")
        os.symlink(secret, os.path.join(folder, "link.txt"))
        os.symlink(self.tmp, os.path.join(folder, "linkdir"))
        item = self.state.share_path(folder)
        d = Device(self).connect()
        names = [e["name"] for e in d.json("GET", "api/browse?ref=" + item["id"])[1]["entries"]]
        self.assertNotIn("link.txt", names)
        self.assertNotIn("linkdir", names)
        for rest in ("/..%2Fsecret.txt", "/../secret.txt", "/%2E%2E/secret.txt", "/link.txt", "/linkdir/secret.txt",
                     "/.DS_Store", "/.git/config", "/disc%202/..", "//a.txt"):
            self.assertEqual(d.call("GET", "dl/" + item["id"] + rest)[0], 404, rest)
        files = self.state.zip_plan([item["id"]], d.state()[1]["device"]["id"])
        self.assertNotIn("album/link.txt", [f[0] for f in files])
        file_item = self.share("plain.txt", b"p")
        self.assertEqual(d.call("GET", f"dl/{file_item['id']}/x")[0], 404)

    def test_zip_of_selection(self):
        album = self.state.share_path(self.make_album())
        loose = self.share("a.txt", b"loose")
        d = Device(self).connect()
        q = "&".join("f=" + quote(r, safe="") for r in (album["id"], loose["id"], album["id"] + "/a.txt"))
        status, h, data = d.call("GET", "zip?name=" + quote("My/../pick") + "&" + q)
        self.assertEqual(status, 200)
        self.assertIn('filename="pick.zip"', h["Content-Disposition"])
        files = self.unzip(data)
        self.assertEqual(files["a.txt"], b"loose")
        self.assertEqual(files["a (1).txt"], b"a", "same names get numbered")
        self.assertIn("album/disc 2/b.txt", files)
        self.assertEqual(d.call("GET", "zip?f=nope")[0], 404)
        self.assertEqual(d.call("GET", "zip")[0], 400)
        self.assertEqual(Device(self).call("GET", "zip?f=" + loose["id"])[0], 401)

    def test_inline_preview(self):
        img = self.share("photo.jpg", b"\xff\xd8jpeg")
        page = self.share("page.html", b"<script>alert(1)</script>")
        note = self.share("notes.md", "héllo".encode())
        d = Device(self).connect()
        files = {f["name"]: f["preview"] for f in d.state()[1]["files"]}
        self.assertEqual(files, {"photo.jpg": "image", "page.html": None, "notes.md": "text"})
        status, h, _ = d.call("GET", f"dl/{img['id']}?inline=1")
        self.assertEqual((status, h["Content-Type"], h["Content-Security-Policy"]), (200, "image/jpeg", "sandbox"))
        self.assertTrue(h["Content-Disposition"].startswith("inline"))
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        _, h, _ = d.call("GET", f"dl/{page['id']}?inline=1")
        self.assertTrue(h["Content-Disposition"].startswith("attachment"), "HTML is never shown inline")
        _, h, data = d.call("GET", f"dl/{note['id']}?inline=1")
        self.assertEqual((h["Content-Type"], data.decode()), ("text/plain; charset=utf-8", "héllo"))
        self.assertEqual([t["name"] for t in self.snapshot()["transfers"]], ["page.html"], "previews aren't transfers")

    # --- remembered devices -------------------------------------------------

    def restart(self):
        """A new State on the same port and config, as after quitting and running pierhop again."""
        cfg = load_instance_config(self.config, self.state.port)
        st = State(self.save_dir, config_path=self.config, notifications=False, quiet=True, default_name="Test Mac")
        st.port = self.state.port
        st.restore_devices(cfg.get("devices"))
        return st

    def test_devices_are_forgotten_by_default(self):
        d = Device(self).connect()
        self.assertEqual(load_instance_config(self.config, self.state.port)["devices"], [])
        st = self.restart()
        self.assertIsNone(st.device_for(d.cookie.split("=", 1)[1]), "a restart asks for the PIN again")
        st.cleanup()

    def test_devices_are_remembered_when_enabled(self):
        self.host("settings", {"remember": True})
        a, b = Device(self).connect(), Device(self).connect()
        a.json("POST", "api/rename", {"name": "Pixel"})
        b_id = b.state()[1]["device"]["id"]
        self.host("devices/remove", {"id": b_id})
        with open(self.config) as f:
            raw = f.read()
        self.assertNotIn(a.cookie.split("=", 1)[1], raw, "only a hash of the token is saved")
        self.assertEqual(os.stat(self.config).st_mode & 0o777, 0o600)

        st = self.restart()
        token = a.cookie.split("=", 1)[1]
        dev = st.device_for(token)
        self.assertEqual((dev["name"], dev["status"]), ("Pixel", "approved"))
        self.assertIsNone(st.device_for(b.cookie.split("=", 1)[1]), "disconnected devices stay disconnected")
        self.assertEqual([d["name"] for d in st.host_snapshot()["devices"]], ["Pixel"])
        self.assertEqual(load_instance_config(self.config, self.state.port)["random_link"], self.state.random_link,
                         "the random link is saved so remembered devices can find PierHop again")
        st.cleanup()

        self.host("settings", {"remember": False})
        self.assertEqual(load_instance_config(self.config, self.state.port)["devices"], [],
                         "turning it off deletes the saved devices")

    def test_restore_skips_bad_and_stale_entries(self):
        self.host("settings", {"remember": True})
        Device(self).connect()
        good = load_instance_config(self.config, self.state.port)["devices"][0]
        stale = dict(good, id="00000000", token_hash="0" * 64, last_seen=0)
        st = State(self.save_dir, notifications=False, quiet=True)
        st.restore_devices([good, stale, {"id": "zz"}, "junk", dict(good, token_hash="x")])
        self.assertEqual(list(st.devices), [good["id"]])
        st.cleanup()

    def test_uploads(self):
        d = Device(self).connect()
        content = os.urandom(200_000)
        for _ in range(2):
            status, _ = d.json("POST", "api/upload", content, {"X-Filename": quote("../../évil:name.txt")})
            self.assertEqual(status, 200)
        self.assertEqual(sorted(os.listdir(self.save_dir)), ["évilname (1).txt", "évilname.txt"])
        with open(os.path.join(self.save_dir, "évilname.txt"), "rb") as f:
            self.assertEqual(f.read(), content)
        self.assertEqual(Device(self).json("POST", "api/upload", b"x", {"X-Filename": "a"})[0], 401)
        received = self.snapshot()["received"]
        self.assertEqual([(r["name"], r["from"]) for r in received],
                         [("évilname (1).txt", "Android phone"), ("évilname.txt", "Android phone")])

    def test_host_drop_is_not_a_transfer(self):
        status, _ = self.host_upload("drop.txt", b"dropped")
        self.assertEqual(status, 200)
        s = self.snapshot()
        self.assertEqual([f["name"] for f in s["shared"]], ["drop.txt"])
        self.assertEqual(s["transfers"], [])
        self.assertTrue(self.host("remove", {"id": s["shared"][0]["id"]})[1]["ok"])
        self.assertEqual(self.snapshot()["shared"], [])

    def host_upload(self, name, content):
        status, _, data = self.request("POST", "/api/host/upload", content,
                                       {"X-PierHop-Key": self.key, "X-Filename": quote(name)})
        return status, json.loads(data)

    # --- settings -----------------------------------------------------------

    def test_custom_link_and_saved_settings(self):
        d = Device(self).connect()
        old = self.state.link
        self.assertEqual(self.host("settings", {"link": "api"})[0], 400)
        self.assertEqual(self.host("settings", {"link": "bad link!"})[0], 400)
        self.assertEqual(self.host("settings", {"link": "music", "name": "Studio", "access": "approve"})[0], 200)
        self.assertEqual(self.request("GET", f"/{old}/api/state")[0], 404)
        self.assertEqual(d.state()[0], 200, "connected devices survive a link change")
        status, h, _ = self.request("GET", "/music")
        self.assertEqual((status, h["Location"]), (301, "/music/"))
        self.assertEqual(self.snapshot()["name"], "Studio")
        saved = load_instance_config(self.config, self.state.port)
        self.assertEqual({k: saved[k] for k in ("link", "access", "name")},
                         {"link": "music", "access": "approve", "name": "Studio"})
        self.host("settings", {"link": None, "name": ""})
        self.assertNotEqual(self.state.link, "music")
        self.assertEqual(self.snapshot()["name"], "Test Mac")
        self.assertEqual(self.host("settings", {"access": "everyone"})[0], 400)

    def test_cookie_is_scoped_to_port(self):
        d = Device(self)
        d.hello()
        self.assertTrue(d.cookie.startswith(f"ph_device_{self.state.port}="))

    # --- misc ---------------------------------------------------------------

    def test_device_page_and_not_found(self):
        self.assertEqual(self.request("GET", f"/{self.state.link}/")[0], 200)
        status, _, body = self.request("GET", "/typo/", headers={"Accept": "text/html"})
        self.assertEqual(status, 404)
        self.assertIn(b"Link not found", body)

    def test_static_whitelist(self):
        for name in ("qrcode.min.js", "host.js", "device.js", "favicon.svg"):
            self.assertEqual(self.request("GET", "/static/" + name)[0], 200)
        self.assertEqual(self.request("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.request("GET", "/static/host.html")[0], 404)


if __name__ == "__main__":
    unittest.main()
