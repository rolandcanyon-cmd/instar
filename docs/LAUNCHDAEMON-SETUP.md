# Running Instar as a LaunchDaemon (macOS)

By default, Instar installs as a **LaunchAgent** — it runs when you log in. That's fine for most setups, but has a limitation: **the agent only runs when you're logged in.** If the Mac reboots while you're away (OS update, power event, etc.) and your user doesn't auto-login, the agent stays offline until someone logs in.

**LaunchDaemon mode** fixes this: the agent starts at boot, before any user login, and keeps running across all user sessions. This is useful for a dedicated "always-on" Mac that you access remotely.

There are three gotchas when running as a daemon. This document covers all of them.

## 1. Authentication (Claude OAuth doesn't work in daemons)

Claude Code's interactive mode reads OAuth credentials from the macOS login keychain. LaunchDaemons run without a user session, so they cannot access the user's login keychain — meaning OAuth-based auth silently fails.

**Solution:** Use a long-lived OAuth token via `CLAUDE_CODE_OAUTH_TOKEN` instead of keychain-backed OAuth.

### Generate a long-lived token

Requires a Claude subscription (Pro or Max).

```bash
claude setup-token
```

This launches an interactive browser flow. When complete, it prints a token starting with `sk-ant-oat01-...` that's valid for one year.

**Alternative:** Use an API key from [console.anthropic.com](https://console.anthropic.com/). That's pay-per-use rather than subscription-billed, but works identically.

### Configure Instar

Add to `.instar/config.json`:

```json
{
  "sessions": {
    "anthropicApiKey": "sk-ant-oat01-..."
  }
}
```

Instar auto-detects the format:
- `sk-ant-oat01-*` → routed to `CLAUDE_CODE_OAUTH_TOKEN` (subscription-billed, works in interactive mode)
- `sk-ant-api03-*` → routed to `ANTHROPIC_API_KEY` (pay-per-use API billing)

## 2. iMessage database access

The `~/Library/Messages/` directory is protected by macOS TCC. Granting Full Disk Access to the node binary would work but is overly broad — node could then access anything, and FDA has to be re-granted if Homebrew changes the node path.

**Instar handles this automatically.** On startup, the iMessage adapter hardlinks `chat.db` (plus WAL and SHM files) from `~/Library/Messages/` to `<stateDir>/imessage/`. Hardlinks share the same inode, so the server reads the current data, but the link path itself isn't inside the TCC-protected directory — no FDA required on node.

### How it works

- **First startup:** the adapter needs FDA to create the hardlinks. Run `instar server start` once from a terminal that has FDA granted (System Settings → Privacy & Security → Full Disk Access → add Terminal.app or iTerm). The hardlinks are created in `.instar/imessage/`.
- **All subsequent startups:** the hardlinks already exist. The adapter reads through them without needing FDA on node. Works fine from a LaunchDaemon.
- **If Messages.app resets** (new install, major macOS upgrade), the inode may change. The adapter detects this on startup and recreates the hardlinks — which again requires FDA for that one startup.

### Overriding the default

If you want to point at a different database location (e.g., a shared volume), set `dbPath` explicitly:

```json
{
  "type": "imessage",
  "enabled": true,
  "config": {
    "dbPath": "/path/to/your/chat.db",
    "authorizedContacts": ["+14081234567"]
  }
}
```

When `dbPath` is set, the adapter uses it as-is and does not create hardlinks.

### Note on sending

`imsg send` uses ScriptingBridge to talk to Messages.app, which requires a running user session with Automation permission granted. A daemon can send iMessages *if* a user is logged in when the daemon spawns `imsg`. If you need sending to work even before any user logs in, you'll need a LaunchAgent (not Daemon) for the sending path.

In practice: most setups have someone log in eventually, and sending works thereafter.

## 3. iMessage photo attachments (optional)

If your agent needs to receive and process **photo attachments** sent via iMessage (not just text), a second piece of infrastructure is required. The `chat.db` hardlink approach only covers message text — photo files live in `~/Library/Messages/Attachments/`, which is a separate TCC-protected directory.

### Why a dedicated binary

Granting FDA to a general-purpose binary like `bash`, `node`, or `fswatch` works but is broader than necessary — any process using that binary gets the same access. The right approach is a **purpose-built binary** whose name makes the FDA grant self-documenting: `instar-attachments-sync`.

### What it does

`instar-attachments-sync` is a small Go binary (~3MB) that:
1. On startup, hardlinks all existing image/video attachments from `~/Library/Messages/Attachments/` to `.instar/imessage/attachments/`
2. Watches for new files via FSEvents and hardlinks them within ~500ms of arrival
3. Prunes hardlinks whose source has been deleted

Hardlinks share the same inode as the originals, so the agent can read them without any FDA grant of its own.

### Build and install

```bash
# Requires Go (brew install go)
cd scripts/attachments-sync
go build -o ~/.instar/agents/AGENT/.instar/bin/instar-attachments-sync .
```

Or copy a pre-built binary from the [releases page](https://github.com/JKHeadley/instar/releases) *(coming soon)*.

### Grant Full Disk Access

In **System Settings → Privacy & Security → Full Disk Access**, click `+` and add:

```
~/.instar/agents/AGENT/.instar/bin/instar-attachments-sync
```

> **Important:** FDA is granted per resolved binary path. If you rebuild or replace the binary, you must re-grant FDA. Use the Cellar path or a stable location that won't change.

### LaunchAgent plist

The attachments watcher should run as a **LaunchAgent** (not a Daemon) because it needs a user session context to access the Messages sandbox. Save to `~/Library/LaunchAgents/ai.instar.AttachmentsWatcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.instar.AttachmentsWatcher</string>
    <key>Program</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/bin/instar-attachments-sync</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/attachments-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/attachments-watcher.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOU</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/ai.instar.AttachmentsWatcher.plist
```

### Verify

```bash
tail -f ~/.instar/agents/AGENT/.instar/logs/attachments-watcher.log
```

You should see:
```
2026-01-01T00:00:00Z instar-attachments-sync starting
2026-01-01T00:00:00Z initial sync: linked N new files
2026-01-01T00:00:00Z watching /Users/YOU/Library/Messages/Attachments
```

If you see `operation not permitted`, FDA has not been granted or was granted to a different binary path.

## 4. Node binary path

Instar symlinks `.instar/bin/node` to a node binary. If multiple Homebrew prefixes exist (e.g., `/opt/homebrew` and `/Users/you/homebrew`), the symlink may point to the wrong one. This matters if you've granted FDA to a specific binary — FDA is per-path.

**Solution:** Point the symlink at the binary that has FDA (if any), using the resolved Cellar path (not the `bin/` symlink):

```bash
ln -sf /Users/YOU/homebrew/Cellar/node/XX.Y.Z/bin/node /Users/YOU/.instar/agents/AGENT/.instar/bin/node
```

With the hardlink approach for chat.db, FDA isn't needed at all — this step can be skipped.

## LaunchDaemon plist template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.instar.AGENT</string>
    <key>UserName</key>
    <string>YOUR_USER</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/homebrew/Cellar/node/XX.Y.Z/bin/node</string>
        <string>/Users/YOU/.instar/agents/AGENT/.instar/instar-boot.js</string>
        <string>server</string>
        <string>start</string>
        <string>--foreground</string>
        <string>--dir</string>
        <string>/Users/YOU/.instar/agents/AGENT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOU/.instar/agents/AGENT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/server-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/.instar/agents/AGENT/.instar/logs/server-launchd.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/YOU</string>
        <key>PATH</key>
        <string>/Users/YOU/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

Install:

```bash
sudo cp my.plist /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo chown root:wheel /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.instar.AGENT.plist
```

Reload after changes:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/ai.instar.AGENT.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.instar.AGENT.plist
```

## Verifying the setup

After the daemon starts:

```bash
curl -s http://localhost:4040/health
curl -s -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('/Users/YOU/.instar/agents/AGENT/.instar/config.json'))['authToken'])")" \
  http://localhost:4040/imessage/status
```

Both should return healthy responses. The iMessage status should show `"state":"connected"` without any `"reason":"unable to open database file"` in the degradations log.

Send a test iMessage to the agent's authorized number. You should see:
1. An ack message back within ~2 seconds (if `immediateAck` is configured)
2. A real reply from a Claude session within 30–90 seconds

## Happy Path: What Success Looks Like

When everything is working, this is what you should see on each reboot:

**1. Check the LaunchAgent is registered and running:**
```bash
launchctl list | grep instar
# Expected output (one line per service):
# PID    LastExit  Label
# 12345  0         ai.instar.Roland
# 11234  0         ai.instar.AttachmentsWatcher
```

A non-zero PID means the process is running. `LastExit` of `0` means the previous restart was clean. A missing PID means the service crashed and `KeepAlive` hasn't restarted it yet (or it's stuck in crash-loop backoff).

**2. Check server health:**
```bash
curl -s http://localhost:4040/health
# Expected: {"status":"ok","uptime":...}
```

**3. Check iMessage is polling:**
```bash
AUTH=$(python3 -c "import json; print(json.load(open('~/.instar/agents/AGENT/.instar/config.json'))['authToken'])")
curl -s -H "Authorization: Bearer $AUTH" http://localhost:4040/imessage/status
# Expected: {"state":"connected","dbPath":"...imessage/chat.db",...}
```

**4. Send a test message** from an authorized number. Within ~2 seconds you should get a `...` ack, and within 30–90 seconds a full Claude reply.

That's the happy path. If any step fails, use the troubleshooting section below.

---

## Troubleshooting Auto-Start

### The LaunchAgent is installed but Instar didn't start after reboot

**Check:** `launchctl list | grep instar`

If the line for your agent shows a `-` instead of a PID, it's not running. Check the error log:
```bash
tail -50 ~/.instar/agents/AGENT/.instar/logs/server-launchd.err
```

**Common causes:**

**Port already in use** — If you see `Error: Port 4040 is already in use`, a previous instance is still running (or another process owns the port). The LaunchAgent will crash-loop with exponential backoff. Kill the orphan and it will recover:
```bash
lsof -ti tcp:4040 | xargs kill -9
# launchd will restart your agent within ~10 seconds
```

**LaunchAgent not loaded** — After creating or editing a `.plist`, it must be explicitly loaded:
```bash
launchctl load ~/Library/LaunchAgents/ai.instar.AGENT.plist
# Or for modern macOS:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.instar.AGENT.plist
```
Verify it was picked up: `launchctl list | grep instar`

**Node binary path changed** — If Homebrew was updated, the node symlink in `.instar/bin/node` may be stale. Repoint it:
```bash
ln -sf $(which node) ~/.instar/agents/AGENT/.instar/bin/node
# Then reload the LaunchAgent:
launchctl kickstart -k gui/$(id -u)/ai.instar.AGENT
```

---

### iMessage messages aren't being picked up

**Step 1 — Check the hardlinks are in place:**
```bash
ls -la ~/.instar/agents/AGENT/.instar/imessage/
# Expected: chat.db, chat.db-wal, chat.db-shm (all showing inode links > 1)
```

If the directory is empty or the files are missing, the hardlinks need to be recreated. Start instar once from a terminal that has Full Disk Access:
```bash
instar server start --dir ~/.instar/agents/AGENT
# Watch for: "[iMessage] Hardlinks created at .instar/imessage/"
# Then stop (Ctrl-C) and let launchd take over
```

**Step 2 — Check Messages.app is actually writing to chat.db:**
```bash
stat ~/.instar/agents/AGENT/.instar/imessage/chat.db
# The modification time should be recent (within the last few minutes if messages are flowing)
```

If `mtime` is frozen at an old timestamp, Messages.app has lost sync with iCloud. **Do NOT delete chat.db** — this breaks iCloud sync and can cause data loss. Instead, zero the file in-place to force a re-sync while preserving the inode:
```bash
# Zero the three chat.db files in-place (preserves inodes, forces iCloud re-sync)
cat /dev/null > ~/Library/Messages/chat.db
cat /dev/null > ~/Library/Messages/chat.db-wal
cat /dev/null > ~/Library/Messages/chat.db-shm
# Then reboot — Messages.app will re-sync from iCloud on startup
```

> **Why zeroing is safe but deleting is not:** Hardlinks track inodes. Deleting `chat.db` creates a new inode when Messages.app recreates it, which means all your hardlinks go stale silently. Zeroing the file keeps the same inode — the hardlinks remain valid and your sync history stays intact.

**Step 3 — Verify polling is running:**
```bash
tail -f ~/.instar/agents/AGENT/.instar/logs/server-launchd.log | grep -i imessage
# You should see periodic "[iMessage] polled N new messages" lines
```

---

### Welcome message not sent on startup

On first start after install (or after a clean reset), the agent should send a welcome message to configured contacts. If you got a `...` ack but no welcome message:

1. The session that sends the welcome may have failed — check the session logs:
   ```bash
   ls ~/.instar/agents/AGENT/.instar/logs/sessions/
   ```
2. If no session started at all, check that `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) is configured in `.instar/config.json` under `sessions.anthropicApiKey`.
3. A `...` sent immediately on server start (before any message from you) indicates the server-side ack script ran at startup — this is normal and not a welcome message.

---

### Crash-loop detection

If the server exits repeatedly, `instar-boot.js` enters crash-loop backoff (default: 4 crashes in 120s → 40s backoff). You'll see in the error log:
```
[instar-boot] Crash loop detected (4 crashes in 120s). Backing off 40s...
```

This is designed to prevent runaway restarts from burning API quota. To diagnose: read the error above the crash-loop message — it will tell you the real cause. Fix it, then the backoff will clear on the next restart cycle.
