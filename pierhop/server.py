"""HTTP server and shared state for pierhop.

Two audiences talk to the same server:

* the host (this computer) gets a control page at http://127.0.0.1:PORT/.
  Host routes only answer loopback requests with a loopback Host header, and
  the API also needs a per-run key embedded in the page, so other websites
  and other devices can't drive it.
* devices (phones, tablets, other computers) get http://LAN-IP:PORT/<link>/
  where <link> is random or a custom path. Every device gets its own identity
  cookie; depending on the access mode it is let in straight away, after
  entering the PIN, or after the host approves it.
"""
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import CookieError, SimpleCookie
from urllib.parse import parse_qs, quote, unquote, urlsplit

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
STATIC_FILES = {
    "qrcode.min.js": "application/javascript",
    "host.js": "application/javascript",
    "device.js": "application/javascript",
}
CHUNK = 1024 * 1024
LINK_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
PIN_RE = re.compile(r"^[0-9]{4,12}$")
RESERVED_LINKS = {"api", "static"}
ACCESS_MODES = ("pin", "approve", "open")
MAX_JSON = 1_000_000
MAX_TEXT = 100_000
MAX_TEXTS = 50
MAX_NAME = 40
MAX_FINISHED_TRANSFERS = 20
MAX_UNAPPROVED_DEVICES = 20
UNAPPROVED_TTL = 300  # forget devices that never got in after 5 minutes
LOGIN_ATTEMPTS = 5
LOCKOUT_SECONDS = 60
DENY_COOLDOWN = 60
ONLINE_SECONDS = 10
REQUEST_SECONDS = 30  # an approval request disappears once the device stops asking
REMEMBER_DAYS = 90  # saved devices not seen for this long have to connect again
MAX_ZIP_REFS = 1000
MAX_TEXT_PREVIEW = 5_000_000
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
    ".ini", ".cfg", ".conf", ".toml", ".srt", ".vtt", ".py", ".js", ".ts", ".css", ".sh",
}
ZIP64_LIMIT = 0xFFFFFFFF  # tests lower this to exercise the ZIP64 layout
LOOPBACK_IPS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_DEVICE_NAMES = {
    "android": "Android phone",
    "android-tablet": "Android tablet",
    "iphone": "iPhone",
    "ipad": "iPad",
    "mac": "Mac",
    "windows": "Windows PC",
    "linux": "Linux PC",
    "other": "Device",
}


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def computer_name():
    if sys.platform == "darwin":
        try:
            r = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=2)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    return socket.gethostname().split(".")[0]


def new_pin():
    return "".join(secrets.choice("0123456789") for _ in range(6))


def valid_link(link):
    return isinstance(link, str) and bool(LINK_RE.match(link)) and link.lower() not in RESERVED_LINKS


def clean_name(name):
    """A display name from untrusted input, or None if nothing usable is left."""
    if not isinstance(name, str):
        return None
    name = " ".join("".join(c for c in name if c.isprintable()).split())
    return name[:MAX_NAME] or None


def device_kind(user_agent):
    ua = (user_agent or "").lower()
    if "ipad" in ua:
        return "ipad"
    if "iphone" in ua:
        return "iphone"
    if "android" in ua:
        return "android" if "mobile" in ua else "android-tablet"
    if "macintosh" in ua or "mac os x" in ua:
        return "mac"
    if "windows" in ua:
        return "windows"
    if "linux" in ua or "cros" in ua:
        return "linux"
    return "other"


def safe_name(name):
    name = name.replace("\\", "/").split("/")[-1]
    name = "".join(c for c in name if c.isprintable() and c not in '<>:"|?*')
    name = name.strip().lstrip(".").strip()
    if not name:
        name = "file"
    if len(name.encode()) > 200:
        root, ext = os.path.splitext(name)
        name = root[:100] + ext[:20]
    return name


def unique_path(directory, name):
    root, ext = os.path.splitext(name)
    candidate = os.path.join(directory, name)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{root} ({n}){ext}")
        n += 1
    return candidate


def token_hash(token):
    """Device tokens are stored hashed, so the config file can't be used to log in."""
    return hashlib.sha256(token.encode()).hexdigest()


def is_hidden(name):
    return name.startswith(".")


def inside(root, path):
    """True if path, with symlinks resolved, is root or somewhere under it."""
    root = os.path.realpath(root)
    path = os.path.realpath(path)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def natural_key(name):
    """Sorts "IMG 2" before "IMG 10"."""
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"(\d+)", name.lower())]


def preview_kind(name, size):
    """How a device can show this file in the browser: image, video, audio, text, or None."""
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_EXTS:
        return "text" if size <= MAX_TEXT_PREVIEW else None
    mime = mimetypes.guess_type(name)[0] or ""
    if mime.startswith(("video/", "audio/")):
        return mime.split("/")[0]
    # SVG can carry scripts, so it's never shown inline.
    if mime.startswith("image/") and mime != "image/svg+xml":
        return "image"
    return None


def walk_files(root):
    """Yields (relative path, absolute path, stat) for the regular files under root.

    Hidden files and folders are skipped (.DS_Store, .git and the like), and so
    is anything whose real location is outside root.
    """
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted((d for d in dirnames if not is_hidden(d)), key=natural_key)
        for f in sorted(filenames, key=natural_key):
            full = os.path.join(dirpath, f)
            if is_hidden(f) or not inside(root, full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and os.access(full, os.R_OK):
                yield os.path.relpath(full, root), full, st


def dos_time(mtime):
    t = time.localtime(max(mtime, 315532800))  # zip dates start in 1980
    return (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2), ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday


class ZipStream:
    """An uncompressed zip written straight to a socket, without a temp file.

    Each file's size comes from stat(), so the archive's total length is known
    before sending and devices can show real progress. CRCs are only known once
    a file has been read, so each one goes in a data descriptor after the file.
    """

    def __init__(self, files):
        """files: [(name inside the archive, path, stat)]."""
        self.entries = []
        offset = 0
        for arcname, path, st in files:
            name = arcname.encode()
            big = st.st_size >= ZIP64_LIMIT
            e = {"name": name, "path": path, "size": st.st_size, "offset": offset, "big": big,
                 "mode": stat.S_IMODE(st.st_mode) or 0o644, "time": dos_time(st.st_mtime), "crc": 0}
            self.entries.append(e)
            offset += 30 + len(name) + (20 if big else 0) + st.st_size + (24 if big else 16)
        self.cd_offset = offset
        self.cd_size = sum(46 + len(e["name"]) + len(self._central_extra(e)) for e in self.entries)
        self.zip64_end = (len(self.entries) >= 0xFFFF or self.cd_offset >= ZIP64_LIMIT
                          or self.cd_size >= ZIP64_LIMIT)
        self.size = self.cd_offset + self.cd_size + (76 if self.zip64_end else 0) + 22

    @staticmethod
    def _central_extra(e):
        fields = [e["size"], e["size"]] if e["big"] else []
        if e["offset"] >= ZIP64_LIMIT:
            fields.append(e["offset"])
        if not fields:
            return b""
        return struct.pack("<HH", 1, 8 * len(fields)) + struct.pack("<" + "Q" * len(fields), *fields)

    def write(self, out, progress):
        """Writes the archive to out, calling progress(n) after every n bytes."""
        flags = 0x08 | 0x800  # data descriptor follows; names are UTF-8
        for e in self.entries:
            version = 45 if e["big"] else 20
            sentinel = 0xFFFFFFFF if e["big"] else 0
            extra = struct.pack("<HHQQ", 1, 16, 0, 0) if e["big"] else b""
            header = struct.pack("<IHHHHHIIIHH", 0x04034B50, version, flags, 0, *e["time"],
                                 0, sentinel, sentinel, len(e["name"]), len(extra)) + e["name"] + extra
            out.write(header)
            progress(len(header))
            crc, remaining = 0, e["size"]
            with open(e["path"], "rb") as f:
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        raise OSError(f"{e['path']} got shorter while it was being sent")
                    crc = zlib.crc32(chunk, crc)
                    out.write(chunk)
                    remaining -= len(chunk)
                    progress(len(chunk))
            e["crc"] = crc
            if e["big"]:
                desc = struct.pack("<IIQQ", 0x08074B50, crc, e["size"], e["size"])
            else:
                desc = struct.pack("<IIII", 0x08074B50, crc, e["size"], e["size"])
            out.write(desc)
            progress(len(desc))

        tail = b""
        for e in self.entries:
            extra = self._central_extra(e)
            size32 = 0xFFFFFFFF if e["big"] else e["size"]
            offset32 = 0xFFFFFFFF if e["offset"] >= ZIP64_LIMIT else e["offset"]
            tail += struct.pack(
                "<IHHHHHHIIIHHHHHII", 0x02014B50, (3 << 8) | 45, 45 if e["big"] else 20, flags, 0,
                *e["time"], e["crc"], size32, size32, len(e["name"]), len(extra), 0, 0, 0,
                (stat.S_IFREG | e["mode"]) << 16, offset32,
            ) + e["name"] + extra
        n = len(self.entries)
        if self.zip64_end:
            end64 = self.cd_offset + self.cd_size
            tail += struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, n, n, self.cd_size, self.cd_offset)
            tail += struct.pack("<IIQI", 0x07064B50, 0, end64, 1)
            # macOS's unzipper (ditto, Archive Utility) only reads the ZIP64
            # record when the classic one is all sentinels.
            count, cd_size, cd_offset = 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF
        else:
            count, cd_size, cd_offset = n, self.cd_size, self.cd_offset
        tail += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, count, count, cd_size, cd_offset, 0)
        out.write(tail)
        progress(len(tail))


def notify(message):
    """Show a macOS notification; silently does nothing elsewhere."""
    if sys.platform != "darwin":
        return
    try:
        subprocess.Popen(
            ["osascript", "-e", "on run argv", "-e",
             'display notification (item 1 of argv) with title "PierHop"', "-e", "end run", message],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


def native_pick(kind):
    """Open the macOS file/folder chooser. Returns a list of paths ([] if cancelled)."""
    what = "folder" if kind == "folder" else "file"
    script = [
        "activate",
        f'set picked to choose {what} with prompt "Choose {what}s to share" with multiple selections allowed',
        'set out to ""',
        "repeat with p in picked",
        "set out to out & POSIX path of p & linefeed",
        "end repeat",
        "return out",
    ]
    args = ["osascript"]
    for line in script:
        args += ["-e", line]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:  # -128 = user cancelled
        return []
    return [line for line in r.stdout.splitlines() if line]


def default_config_path():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support/pierhop")
    else:
        base = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "pierhop")
    return os.path.join(base, "config.json")


def load_instance_config(path, port):
    """Settings are saved per port, so two PierHop instances keep their own."""
    try:
        with open(path) as f:
            cfg = json.load(f)
        inst = cfg.get("instances", {}).get(str(port), {})
        return inst if isinstance(inst, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def save_instance_config(path, port, settings):
    """Read-modify-write under a file lock, since other instances share the file."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".lock", "w") as lock:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                with open(path) as f:
                    cfg = json.load(f)
                if not isinstance(cfg, dict):
                    cfg = {}
            except (OSError, ValueError):
                cfg = {}
            if not isinstance(cfg.get("instances"), dict):
                cfg["instances"] = {}
            cfg["instances"][str(port)] = settings
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
                json.dump(cfg, f, indent=2)
            os.replace(tmp, path)
    except OSError as e:
        print(f"  !! couldn't save settings: {e}")


class State:
    def __init__(self, save_dir, access="pin", pin=None, link=None, name=None,
                 default_name=None, config_path=None, notifications=True, quiet=False):
        self.lock = threading.Lock()
        self.save_lock = threading.Lock()
        self.tmpdir = tempfile.mkdtemp(prefix="pierhop-")
        self.save_dir = save_dir
        self.access = access
        self.pin = pin or new_pin()
        self.custom_link = link
        self.random_link = secrets.token_urlsafe(6)
        self.custom_name = name
        self.default_name = default_name or computer_name()
        self.config_path = config_path
        self.notifications = notifications
        self.quiet = quiet
        # Off by default: after a restart every device needs the PIN or the
        # host's approval again, so nobody gets back in without the host knowing.
        self.remember = False
        self.host_key = secrets.token_urlsafe(24)
        self.port = None
        self.failures = {}  # ip -> [failed PIN attempts, locked until]
        self.devices = {}  # id -> device
        self.by_hash = {}  # token_hash(cookie token) -> device
        self.shared = {}  # id -> {id, name, path, size, count, kind, temp, targets}
        self.received = []
        self.texts = []
        self.transfers = {}

    @property
    def link(self):
        return self.custom_link or self.random_link

    @property
    def name(self):
        return self.custom_name or self.default_name

    @property
    def cookie_name(self):
        # Cookies ignore ports, so two instances on one Mac need different names.
        return f"ph_device_{self.port}"

    def device_url(self):
        return f"http://{lan_ip()}:{self.port}/{self.link}/"

    def log(self, msg):
        if not self.quiet:
            print(f"  {time.strftime('%H:%M:%S')}  {msg}", flush=True)

    def notify(self, msg):
        if self.notifications:
            notify(msg)

    def persist(self):
        """Saves this port's settings and the devices that are let in."""
        if not self.config_path or self.port is None:
            return
        with self.lock:
            settings = {
                "link": self.custom_link,
                "random_link": self.random_link,  # keeps the link (and bookmarks of it) the same
                "access": self.access,
                "name": self.custom_name,
                "remember": self.remember,
                "devices": [
                    {k: d[k] for k in ("id", "token_hash", "name", "kind", "created", "last_seen")}
                    for d in sorted(self.devices.values(), key=lambda d: d["created"])
                    if d["status"] == "approved"
                ] if self.remember else [],
            }
        with self.save_lock:
            save_instance_config(self.config_path, self.port, settings)

    def restore_devices(self, saved):
        """Brings back devices let in on an earlier run, so they reconnect without the PIN."""
        if not isinstance(saved, list):
            return
        cutoff = time.time() - REMEMBER_DAYS * 86400
        with self.lock:
            for s in saved:
                try:
                    dev_id, h, kind = s["id"], s["token_hash"], s["kind"]
                    name = clean_name(s["name"])
                    created, last_seen = float(s["created"]), float(s["last_seen"])
                except (KeyError, TypeError, ValueError):
                    continue
                if (not isinstance(dev_id, str) or not re.fullmatch(r"[0-9a-f]{8}", dev_id)
                        or not isinstance(h, str) or not re.fullmatch(r"[0-9a-f]{64}", h)
                        or not name or kind not in DEFAULT_DEVICE_NAMES or last_seen < cutoff
                        or dev_id in self.devices or h in self.by_hash):
                    continue
                dev = {"id": dev_id, "token_hash": h, "name": self._unique_name(name), "kind": kind, "ip": "",
                       "status": "approved", "created": created, "last_seen": last_seen,
                       "denied_until": 0, "notified": True}
                self.devices[dev_id] = dev
                self.by_hash[h] = dev

    # --- devices ------------------------------------------------------------

    def hello(self, token, ip, user_agent, requested_name=None):
        """Finds the device for a cookie token, or registers a new one.

        Returns (device copy, is_new_request, cookie token), or (None, False,
        None) when too many devices are already waiting to get in.
        """
        now = time.time()
        joined = False
        with self.lock:
            self._prune(now)
            dev = self.by_hash.get(token_hash(token)) if token else None
            if dev is None:
                waiting = sum(1 for d in self.devices.values() if d["status"] != "approved")
                if waiting >= MAX_UNAPPROVED_DEVICES:
                    return None, False, None
                kind = device_kind(user_agent)
                token = secrets.token_urlsafe(24)
                dev = {
                    "id": secrets.token_hex(4),
                    "token_hash": token_hash(token),
                    "name": self._unique_name(clean_name(requested_name) or DEFAULT_DEVICE_NAMES[kind]),
                    "kind": kind,
                    "ip": ip,
                    "status": "new",
                    "created": now,
                    "last_seen": now,
                    "denied_until": 0,
                    "notified": False,
                }
                self.devices[dev["id"]] = dev
                self.by_hash[dev["token_hash"]] = dev
            dev["ip"] = ip
            dev["last_seen"] = now
            if dev["status"] == "denied" and dev["denied_until"] <= now:
                dev["status"] = "new"
                dev["notified"] = False
            if dev["status"] == "new" and self.access == "open":
                dev["status"] = "approved"
                joined = True
            is_request = dev["status"] == "new" and self.access == "approve" and not dev["notified"]
            if is_request:
                dev["notified"] = True
            dev = dict(dev)
        if joined:
            self.persist()
        return dev, is_request, token

    def device_for(self, token, ip=None):
        """The device behind a cookie token (a copy), refreshing last_seen if it's approved."""
        if not token:
            return None
        with self.lock:
            dev = self.by_hash.get(token_hash(token))
            if dev is None:
                return None
            if dev["status"] == "approved":
                dev["last_seen"] = time.time()
                if ip:
                    dev["ip"] = ip
            return dict(dev)

    def _prune(self, now):
        for dev in list(self.devices.values()):
            if dev["status"] != "approved" and now - dev["last_seen"] > UNAPPROVED_TTL:
                self._remove_device(dev["id"])

    def _remove_device(self, device_id):
        dev = self.devices.pop(device_id, None)
        if dev:
            self.by_hash.pop(dev["token_hash"], None)
        return dev

    def _unique_name(self, name, exclude_id=None):
        taken = {d["name"].lower() for d in self.devices.values() if d["id"] != exclude_id}
        candidate, n = name, 2
        while candidate.lower() in taken:
            suffix = f" {n}"
            candidate = name[:MAX_NAME - len(suffix)] + suffix
            n += 1
        return candidate

    def login(self, token, ip, pin):
        """PIN login for a registered device. Returns (ok, seconds_locked)."""
        now = time.time()
        with self.lock:
            dev = self.by_hash.get(token_hash(token)) if token else None
            if dev is None or self.access != "pin" or dev["status"] == "denied":
                return False, 0
            count, until = self.failures.get(ip, [0, 0])
            if until > now:
                return False, int(until - now) + 1
            if not secrets.compare_digest(str(pin).encode(), self.pin.encode()):
                count += 1
                if count >= LOGIN_ATTEMPTS:
                    self.failures[ip] = [0, now + LOCKOUT_SECONDS]
                    return False, LOCKOUT_SECONDS
                self.failures[ip] = [count, 0]
                return False, 0
            self.failures.pop(ip, None)
            dev["status"] = "approved"
        self.persist()
        return True, 0

    def approve_device(self, device_id):
        with self.lock:
            dev = self.devices.get(device_id)
            if not dev or dev["status"] == "approved":
                return None
            dev["status"] = "approved"
            name = dev["name"]
        self.persist()
        return name

    def deny_device(self, device_id):
        with self.lock:
            dev = self.devices.get(device_id)
            if not dev or dev["status"] == "approved":
                return None
            dev["status"] = "denied"
            dev["denied_until"] = time.time() + DENY_COOLDOWN
            return dev["name"]

    def remove_device(self, device_id):
        with self.lock:
            dev = self._remove_device(device_id)
            if dev:
                self._forget_targets([device_id])
        self.persist()
        return dev["name"] if dev else None

    def remove_all_devices(self):
        with self.lock:
            ids = list(self.devices)
            for device_id in ids:
                self._remove_device(device_id)
            self._forget_targets(ids)
        self.persist()
        return len(ids)

    def _forget_targets(self, device_ids):
        gone = set(device_ids)
        for item in list(self.shared.values()) + self.texts:
            if item["targets"] is not None:
                item["targets"] = [t for t in item["targets"] if t not in gone]

    def rename_device(self, device_id, name):
        name = clean_name(name)
        if not name:
            return None
        with self.lock:
            dev = self.devices.get(device_id)
            if not dev:
                return None
            dev["name"] = self._unique_name(name, exclude_id=device_id)
            name = dev["name"]
        self.persist()
        return name

    def set_access(self, mode):
        with self.lock:
            self.access = mode
            if mode == "open":
                for dev in self.devices.values():
                    if dev["status"] == "new":
                        dev["status"] = "approved"

    def regenerate_pin(self):
        with self.lock:
            self.pin = new_pin()
            self.failures.clear()

    def _valid_targets(self, targets):
        """None means every device; otherwise a list of known approved device ids."""
        if targets is None:
            return None
        if not isinstance(targets, list):
            raise ValueError("targets must be a list or null")
        return [t for t in dict.fromkeys(targets) if t in self.devices and self.devices[t]["status"] == "approved"]

    # --- shared files -------------------------------------------------------

    def share_path(self, path):
        path = os.path.abspath(os.path.expanduser(path))
        if os.path.isdir(path):
            # Folders are shared as they are: devices browse them, or download
            # them as a zip that's built while it's being sent.
            files = list(walk_files(path))
            return self._share(path, kind="folder", temp=False,
                               size=sum(st.st_size for _, _, st in files), count=len(files))
        if os.path.isfile(path):
            return self._share(path, kind="file", temp=False)
        raise FileNotFoundError(path)

    def share_temp_file(self, path):
        return self._share(path, kind="file", temp=True)

    def _share(self, path, kind, temp, size=None, count=None):
        item = {
            "id": secrets.token_hex(4),
            "name": os.path.basename(path.rstrip(os.sep)) or path,
            "path": path,
            "size": os.path.getsize(path) if size is None else size,
            "count": count,
            "kind": kind,
            "temp": temp,
            "targets": None,
        }
        with self.lock:
            self.shared[item["id"]] = item
        self.log(f"sharing {item['name']}")
        return item

    def unshare(self, item_id):
        with self.lock:
            item = self.shared.pop(item_id, None)
        if item and item["temp"]:
            shutil.rmtree(os.path.dirname(item["path"]), ignore_errors=True)
        return item is not None

    def set_targets(self, item_id, targets):
        with self.lock:
            item = self.shared.get(item_id)
            if not item:
                return False
            item["targets"] = self._valid_targets(targets)
            return True

    def shared_for(self, item_id, device_id):
        with self.lock:
            item = self.shared.get(item_id)
            if item and (item["targets"] is None or device_id in item["targets"]):
                return dict(item)
            return None

    def resolve(self, ref, device_id):
        """Turns a reference from a device into (item, path, name, is_folder), or None.

        A ref is "<item id>" for a shared item, or "<item id>/<path>" for
        something inside a shared folder, with each path segment URL-encoded.
        """
        item_id, _, rest = ref.partition("/")
        item = self.shared_for(item_id, device_id)
        if not item:
            return None
        if not rest:
            return item, item["path"], item["name"], item["kind"] == "folder"
        if item["kind"] != "folder":
            return None
        parts = [unquote(p) for p in rest.split("/")]
        if any(not p or is_hidden(p) or "/" in p or "\\" in p or "\0" in p for p in parts):
            return None
        path = os.path.join(item["path"], *parts)
        if not inside(item["path"], path):
            return None
        if os.path.isdir(path):
            return item, path, parts[-1], True
        if os.path.isfile(path):
            return item, path, parts[-1], False
        return None

    @staticmethod
    def list_folder(root, path, ref):
        entries = []
        with os.scandir(path) as it:
            for e in it:
                if is_hidden(e.name) or not inside(root, e.path):
                    continue
                try:
                    is_dir = e.is_dir()
                    st = e.stat()
                except OSError:
                    continue
                if not is_dir and not stat.S_ISREG(st.st_mode):
                    continue
                entry = {"name": e.name, "ref": ref + "/" + quote(e.name, safe=""),
                         "kind": "folder" if is_dir else "file", "mtime": st.st_mtime}
                if not is_dir:
                    entry["size"] = st.st_size
                    entry["preview"] = preview_kind(e.name, st.st_size)
                entries.append(entry)
        entries.sort(key=lambda x: (x["kind"] != "folder", natural_key(x["name"])))
        return entries

    def zip_plan(self, refs, device_id):
        """The files for a zip of several refs, as [(name in archive, path, stat)]; None if a ref is bad."""
        files, used = [], set()
        for ref in refs:
            r = self.resolve(ref, device_id)
            if not r:
                return None
            _, path, name, is_dir = r
            top, n = name, 1
            root, ext = ("", "") if is_dir else os.path.splitext(name)
            while top.lower() in used:
                top = f"{name} ({n})" if is_dir else f"{root} ({n}){ext}"
                n += 1
            used.add(top.lower())
            if is_dir:
                files += [(top + "/" + rel.replace(os.sep, "/"), full, st) for rel, full, st in walk_files(path)]
            else:
                try:
                    files.append((top, path, os.stat(path)))
                except OSError:
                    return None
        return files

    # --- received files -----------------------------------------------------

    def add_received(self, path, device):
        item = {
            "id": secrets.token_hex(4),
            "name": os.path.basename(path),
            "path": path,
            "size": os.path.getsize(path),
            "time": time.time(),
            "from": device["name"],
        }
        with self.lock:
            self.received.insert(0, item)
        self.log(f"received {item['name']} from {device['name']} -> {path}")
        self.notify(f"Received {item['name']} from {device['name']}")

    def get_received(self, item_id):
        with self.lock:
            return next((dict(r) for r in self.received if r["id"] == item_id), None)

    # --- text snippets ------------------------------------------------------

    def add_text(self, text, device=None, targets=None):
        """device=None means the host sent it. Device texts are only seen by the host and the sender."""
        with self.lock:
            item = {
                "id": secrets.token_hex(4),
                "text": text,
                "from": device["id"] if device else "host",
                "from_name": device["name"] if device else self.name,
                "targets": self._valid_targets(targets) if device is None else [],
                "time": time.time(),
            }
            self.texts.insert(0, item)
            del self.texts[MAX_TEXTS:]
        if device:
            preview = text if len(text) <= 60 else text[:57] + "..."
            self.notify(f"{device['name']}: {preview}")
        return item

    def clear_texts(self):
        with self.lock:
            self.texts.clear()

    # --- transfers ----------------------------------------------------------

    def start_transfer(self, kind, name, total, device_name):
        t = {
            "id": secrets.token_hex(4), "kind": kind, "name": name, "total": total, "done": 0,
            "device": device_name, "started": time.time(), "finished": None, "status": "active",
        }
        with self.lock:
            self.transfers[t["id"]] = t
        return t["id"]

    def progress(self, tid, n):
        if tid is None:
            return
        with self.lock:
            self.transfers[tid]["done"] += n

    def finish_transfer(self, tid, status="done"):
        if tid is None:
            return None
        with self.lock:
            t = self.transfers[tid]
            t["status"] = status
            t["finished"] = time.time()
            finished = sorted(
                (x for x in self.transfers.values() if x["finished"]), key=lambda x: x["finished"]
            )
            for old in finished[:-MAX_FINISHED_TRANSFERS]:
                del self.transfers[old["id"]]
            return dict(t)

    # --- snapshots for the two UIs -----------------------------------------

    def host_snapshot(self):
        now = time.time()
        with self.lock:
            transfers = [
                dict(t, elapsed=(t["finished"] or now) - t["started"])
                for t in self.transfers.values()
                # Android's downloader often opens and drops a connection
                # before the real download; don't show those as failures.
                if not (t["status"] == "stopped" and t["done"] < 256 * 1024)
            ]
            devices = [
                {"id": d["id"], "name": d["name"], "kind": d["kind"], "ip": d["ip"],
                 "online": now - d["last_seen"] < ONLINE_SECONDS, "last_seen": d["last_seen"]}
                for d in sorted(self.devices.values(), key=lambda d: d["created"])
                if d["status"] == "approved"
            ]
            requests = [
                {"id": d["id"], "name": d["name"], "kind": d["kind"], "ip": d["ip"]}
                for d in sorted(self.devices.values(), key=lambda d: d["created"])
                if d["status"] == "new" and self.access == "approve" and now - d["last_seen"] < REQUEST_SECONDS
            ]
            return {
                "name": self.name,
                "custom_name": self.custom_name,
                "device_url": self.device_url(),
                "link": self.link,
                "custom_link": self.custom_link is not None,
                "access": self.access,
                "remember": self.remember,
                "pin": self.pin,
                "save_dir": self.save_dir,
                "native_picker": sys.platform == "darwin",
                "devices": devices,
                "requests": requests,
                "shared": [{k: i[k] for k in ("id", "name", "size", "count", "kind", "targets")}
                           for i in self.shared.values()],
                "received": [{k: r[k] for k in ("id", "name", "size", "time", "from")} for r in self.received],
                "texts": [dict(t) for t in self.texts],
                "transfers": sorted(transfers, key=lambda t: t["started"], reverse=True),
            }

    def device_snapshot(self, device_id):
        with self.lock:
            dev = self.devices[device_id]
            return {
                "instance": self.name,
                "device": {"id": dev["id"], "name": dev["name"]},
                "files": [
                    {"id": i["id"], "ref": i["id"], "name": i["name"], "size": i["size"], "count": i["count"],
                     "kind": i["kind"], "preview": preview_kind(i["name"], i["size"]) if i["kind"] == "file" else None}
                    for i in self.shared.values()
                    if i["targets"] is None or device_id in i["targets"]
                ],
                "texts": [
                    {"id": t["id"], "text": t["text"], "mine": t["from"] == device_id,
                     "from_name": self.name if t["from"] == "host" else t["from_name"], "time": t["time"]}
                    for t in self.texts
                    if t["from"] == device_id
                    or (t["from"] == "host" and (t["targets"] is None or device_id in t["targets"]))
                ],
            }

    def cleanup(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)


def disposition(kind, name):
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "_")
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


class Handler(BaseHTTPRequestHandler):
    server_version = "pierhop"
    timeout = 120  # a device that stalls mid-upload shouldn't hold a thread forever

    @property
    def state(self):
        return self.server.state

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, socket.timeout):
            pass

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    # --- routing ------------------------------------------------------------

    def route(self, method):
        path = urlsplit(self.path).path
        if method == "GET" and path.startswith("/static/"):
            return self.send_static(path[len("/static/"):])
        if self.is_host():
            if method == "GET" and path == "/":
                return self.send_page("host.html", {"__HOST_KEY__": self.state.host_key})
            if path.startswith("/api/host/"):
                key = self.headers.get("X-PierHop-Key", "")
                if not secrets.compare_digest(key.encode(), self.state.host_key.encode()):
                    return self.send_json({"error": "forbidden"}, 403)
                return self.host_api(method, path[len("/api/host/"):])

        segs = path.split("/")  # "/link/rest" -> ["", "link", "rest"...]
        if len(segs) < 2 or not secrets.compare_digest(segs[1].encode(), self.state.link.encode()):
            if method == "GET" and "text/html" in self.headers.get("Accept", ""):
                return self.send_not_found_page()
            return self.send_json({"error": "not found"}, 404)
        if len(segs) == 2:
            return self.redirect(f"/{self.state.link}/")
        return self.device_route(method, "/".join(segs[2:]))

    def is_host(self):
        if self.client_address[0] not in LOOPBACK_IPS:
            return False
        host = self.headers.get("Host", "")
        # Checking Host as well as the client IP defeats DNS rebinding.
        hostname = host[1:host.find("]")] if host.startswith("[") else host.split(":")[0]
        return hostname in LOOPBACK_HOSTS

    def host_api(self, method, action):
        st = self.state
        if method == "GET" and action == "state":
            return self.send_json(st.host_snapshot())
        if method != "POST":
            return self.send_json({"error": "not found"}, 404)

        if action == "upload":
            dest = tempfile.mkdtemp(dir=st.tmpdir)
            # The host's own browser handing over a dropped file isn't a
            # transfer to or from a device, so it isn't tracked as one.
            saved = self.receive_upload(dest, device_name=None)
            if saved:
                item = st.share_temp_file(saved)
                self.send_json({"ok": True, "id": item["id"]})
            return

        body = self.read_json()
        if body is None:
            return
        item_id = body.get("id")

        if action == "pick":
            if sys.platform != "darwin":
                return self.send_json({"error": "The native picker is macOS only. Drag files onto the page."}, 400)
            added = []
            for p in native_pick(body.get("kind")):
                try:
                    added.append(st.share_path(p)["name"])
                except OSError as e:
                    st.log(f"!! couldn't share {p}: {e}")
            return self.send_json({"ok": True, "added": added})
        if action == "remove":
            return self.send_json({"ok": st.unshare(item_id)})
        if action == "targets":
            try:
                ok = st.set_targets(item_id, body.get("targets"))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_json({"ok": ok}, 200 if ok else 404)
        if action == "text":
            text = str(body.get("text", ""))
            if not text.strip() or len(text) > MAX_TEXT:
                return self.send_json({"error": "Text is empty or too long."}, 400)
            try:
                st.add_text(text, targets=body.get("targets"))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_json({"ok": True})
        if action == "texts/clear":
            st.clear_texts()
            return self.send_json({"ok": True})
        if action == "settings":
            return self.update_settings(body)
        if action.startswith("devices/"):
            return self.device_admin(action[len("devices/"):], body)
        if action in ("reveal", "open"):
            item = st.get_received(item_id)
            if not item or not os.path.exists(item["path"]):
                return self.send_json({"error": "That file has been moved or deleted."}, 404)
            if sys.platform == "darwin":
                subprocess.Popen(["open", "-R", item["path"]] if action == "reveal" else ["open", item["path"]])
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def device_admin(self, action, body):
        st = self.state
        device_id = body.get("id")
        if action == "approve":
            name = st.approve_device(device_id)
            if name:
                st.log(f"approved {name}")
        elif action == "deny":
            name = st.deny_device(device_id)
            if name:
                st.log(f"denied {name}")
        elif action == "remove":
            name = st.remove_device(device_id)
            if name:
                st.log(f"disconnected {name}")
        elif action == "remove-all":
            st.remove_all_devices()
            st.log("disconnected all devices")
            return self.send_json({"ok": True})
        elif action == "rename":
            name = st.rename_device(device_id, body.get("name"))
        else:
            return self.send_json({"error": "not found"}, 404)
        return self.send_json({"ok": True}) if name else self.send_json({"error": "No such device."}, 404)

    def update_settings(self, body):
        st = self.state
        if "link" in body:
            link = body["link"]
            if link is not None and not valid_link(link):
                return self.send_json(
                    {"error": "Use 1–40 letters, numbers, - or _ (and not 'api' or 'static')."}, 400
                )
            if link is None:
                st.random_link = secrets.token_urlsafe(6)
            st.custom_link = link
        if "name" in body:
            st.custom_name = clean_name(body["name"])
        if "access" in body:
            if body["access"] not in ACCESS_MODES:
                return self.send_json({"error": "Unknown access mode."}, 400)
            st.set_access(body["access"])
        if "remember" in body:
            st.remember = bool(body["remember"])
        if body.get("new_pin"):
            st.regenerate_pin()
        st.persist()
        return self.send_json({"ok": True})

    def device_route(self, method, rest):
        st = self.state
        ip = self.client_address[0]
        if method == "GET" and rest == "":
            return self.send_page("device.html")

        if method == "POST" and rest == "api/hello":
            body = self.read_json()
            if body is None:
                return
            dev, is_request, token = st.hello(self.cookie_token(), ip, self.headers.get("User-Agent", ""),
                                              body.get("name"))
            if dev is None:
                return self.send_json({"error": "Too many devices are waiting to connect. Try again later."}, 429)
            if is_request:
                st.log(f"{dev['name']} ({ip}) is asking to connect")
                st.notify(f"{dev['name']} wants to connect")
            cookie = f"{st.cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000"
            return self.send_json(self.device_status(dev), headers={"Set-Cookie": cookie})

        if method == "POST" and rest == "api/login":
            body = self.read_json()
            if body is None:
                return
            ok, locked = st.login(self.cookie_token(), ip, body.get("pin", ""))
            if ok:
                return self.send_json({"ok": True})
            if locked:
                return self.send_json({"error": f"Too many tries. Wait {locked}s."}, 429)
            return self.send_json({"error": "Wrong PIN."}, 401)

        dev = st.device_for(self.cookie_token(), ip)
        if not dev or dev["status"] != "approved":
            status = self.device_status(dev) if dev else {"status": "unknown"}
            return self.send_json(dict(status, error="not connected"), 401)

        query = parse_qs(urlsplit(self.path).query)
        if method == "GET" and rest == "api/state":
            return self.send_json(st.device_snapshot(dev["id"]))
        if method == "GET" and rest == "api/browse":
            return self.browse((query.get("ref") or [""])[0], dev)
        if method == "GET" and rest.startswith("dl/"):
            r = st.resolve(rest[3:], dev["id"])
            if not r:
                return self.send_json({"error": "not found"}, 404)
            _, path, name, is_dir = r
            if is_dir:
                return self.send_zip(name + ".zip", list(walk_files(path)), dev, prefix=name + "/")
            return self.send_path(path, name, dev, inline=query.get("inline") == ["1"])
        if method == "GET" and rest == "zip":
            refs = query.get("f", [])
            if not 0 < len(refs) <= MAX_ZIP_REFS:
                return self.send_json({"error": "Choose between 1 and 1000 items."}, 400)
            files = st.zip_plan(refs, dev["id"])
            if files is None:
                return self.send_json({"error": "not found"}, 404)
            name = safe_name((query.get("name") or ["PierHop files"])[0]) + ".zip"
            return self.send_zip(name, files, dev)
        if method == "POST" and rest == "api/upload":
            saved = self.receive_upload(st.save_dir, device_name=dev["name"])
            if saved:
                st.add_received(saved, dev)
                self.send_json({"ok": True, "name": os.path.basename(saved)})
            return
        if method == "POST" and rest == "api/text":
            body = self.read_json()
            if body is None:
                return
            text = str(body.get("text", ""))
            if not text.strip() or len(text) > MAX_TEXT:
                return self.send_json({"error": "Text is empty or too long."}, 400)
            st.add_text(text, device=dev)
            return self.send_json({"ok": True})
        if method == "POST" and rest == "api/rename":
            body = self.read_json()
            if body is None:
                return
            name = st.rename_device(dev["id"], body.get("name"))
            if not name:
                return self.send_json({"error": "Enter a name."}, 400)
            return self.send_json({"ok": True, "name": name})
        return self.send_json({"error": "not found"}, 404)

    def device_status(self, dev):
        out = {"status": dev["status"], "access": self.state.access, "instance": self.state.name,
               "device": {"name": dev["name"]}}
        if dev["status"] == "denied":
            out["retry_in"] = max(1, int(dev["denied_until"] - time.time()) + 1)
        return out

    def cookie_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        morsel = cookie.get(self.state.cookie_name)
        return morsel.value if morsel else None

    def browse(self, ref, dev):
        st = self.state
        r = st.resolve(ref, dev["id"])
        if not r or not r[3]:
            return self.send_json({"error": "That folder isn't shared anymore."}, 404)
        item, path, name, _ = r
        try:
            entries = st.list_folder(item["path"], path, ref)
        except OSError:
            return self.send_json({"error": "That folder isn't shared anymore."}, 404)
        segs = ref.split("/")
        crumbs = [{"name": item["name"], "ref": segs[0]}]
        for i in range(1, len(segs)):
            crumbs.append({"name": unquote(segs[i]), "ref": "/".join(segs[:i + 1])})
        return self.send_json({"ref": ref, "name": name, "crumbs": crumbs, "entries": entries})

    # --- transfers ----------------------------------------------------------

    def send_path(self, path, name, dev, inline=False):
        """Sends one file, with Range support. inline=True is a preview in the
        browser: it's only allowed for safe types and isn't shown as a transfer."""
        st = self.state
        try:
            size = os.path.getsize(path)
            f = open(path, "rb")
        except OSError:
            return self.send_json({"error": "That file has been moved or deleted on the computer."}, 404)
        preview = preview_kind(name, size) if inline else None
        with f:
            start, end, status = 0, size - 1, 200
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    status = 206
            length = end - start + 1
            self.send_response(status)
            if preview == "text":
                self.send_header("Content-Type", "text/plain; charset=utf-8")
            else:
                self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Disposition", disposition("inline" if preview else "attachment", name))
            self.send_header("X-Content-Type-Options", "nosniff")
            if preview:
                self.send_header("Content-Security-Policy", "sandbox")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()

            # Previews aren't transfers: a video that's being scrubbed makes
            # dozens of range requests.
            tid = None if preview else st.start_transfer("download", name, length, dev["name"])
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
                    st.progress(tid, len(chunk))
            except (ConnectionError, socket.timeout):
                t = st.finish_transfer(tid, "stopped")
                if t and t["done"] >= 256 * 1024:
                    st.log(f"!! {name}: {dev['name']} stopped the download")
                return
            st.finish_transfer(tid)
            if start == 0 and not preview:
                st.log(f"sent {name} to {dev['name']}")

    def send_zip(self, name, files, dev, prefix=""):
        st = self.state
        z = ZipStream([(prefix + rel.replace(os.sep, "/"), path, s) for rel, path, s in files])
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(z.size))
        self.send_header("Content-Disposition", disposition("attachment", name))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        tid = st.start_transfer("download", name, z.size, dev["name"])
        try:
            z.write(self.wfile, lambda n: st.progress(tid, n))
        except (ConnectionError, socket.timeout):
            t = st.finish_transfer(tid, "stopped")
            if t["done"] >= 256 * 1024:
                st.log(f"!! {name}: {dev['name']} stopped the download")
            return
        except OSError as e:
            # Headers are gone already; cutting the connection short is the
            # only way left to tell the device the zip is broken.
            st.finish_transfer(tid, "stopped")
            st.log(f"!! {name}: {e}")
            self.close_connection = True
            return
        st.finish_transfer(tid)
        st.log(f"sent {name} ({len(files)} files) to {dev['name']}")

    def receive_upload(self, dest_dir, device_name):
        """Streams the request body to dest_dir. Returns the saved path, or None after replying with an error.

        device_name=None means the upload isn't shown as a transfer.
        """
        st = self.state
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json({"error": "Content-Length required."}, 411)
            return None
        name = safe_name(unquote(self.headers.get("X-Filename", "")))
        try:
            os.makedirs(dest_dir, exist_ok=True)
            if shutil.disk_usage(dest_dir).free < length:
                self.send_json({"error": "Not enough space on the computer."}, 507)
                return None
            fd, part = tempfile.mkstemp(prefix=".pierhop-", suffix=".part", dir=dest_dir)
        except OSError as e:
            self.send_json({"error": f"Can't save to {dest_dir}: {e.strerror}"}, 500)
            return None

        tid = st.start_transfer("upload", name, length, device_name) if device_name else None
        remaining = length
        try:
            with os.fdopen(fd, "wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise ConnectionResetError("upload ended early")
                    out.write(chunk)
                    remaining -= len(chunk)
                    st.progress(tid, len(chunk))
        except (OSError, socket.timeout) as e:
            os.unlink(part)
            st.finish_transfer(tid, "stopped")
            st.log(f"!! upload of {name} failed: {e}")
            if not isinstance(e, ConnectionError):
                try:
                    self.send_json({"error": "Upload failed on the computer."}, 500)
                except OSError:
                    pass
            return None

        with st.lock:
            final = unique_path(dest_dir, name)
            os.rename(part, final)
        st.finish_transfer(tid)
        return final

    # --- response helpers ---------------------------------------------------

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_JSON:
                raise ValueError
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
            return body
        except ValueError:
            self.send_json({"error": "bad request"}, 400)
            return None

    def send_json(self, obj, code=200, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_page(self, name, replacements=None):
        with open(os.path.join(STATIC, name), encoding="utf-8") as f:
            page = f.read()
        for k, v in (replacements or {}).items():
            page = page.replace(k, v)
        body = page.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")  # the link itself is a secret
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, name):
        if name not in STATIC_FILES:
            return self.send_json({"error": "not found"}, 404)
        with open(os.path.join(STATIC, name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_FILES[name])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_not_found_page(self):
        body = (
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            "<title>PierHop</title><body style=\"font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:480px;margin:auto\">"
            "<h1 style=\"font-size:20px\">Link not found</h1>"
            "<p>Check the link on the computer's PierHop page. It may have changed, or PierHop may have been restarted "
            "with a new random link.</p></body>"
        ).encode()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(301)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, state):
        self.state = state
        super().__init__(("0.0.0.0", port), Handler)

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, socket.timeout)):
            return
        super().handle_error(request, client_address)
