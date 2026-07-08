# iMessage chat.db self-heal — plain-English overview

## The problem in one breath

Our agent reads your iMessages out of a copy of the macOS Messages database. It can't read the *real* database directly, because macOS locks that folder behind a permission called Full Disk Access, and the main server process deliberately doesn't have that permission (the permission is lost every time Node updates, so we don't rely on it). Instead, a small separate helper program — `instar-attachments-sync`, which *does* have Full Disk Access — makes "hardlinks" (a second name pointing at the exact same file) into a folder the server is allowed to read.

Here's the catch. Messages keeps brand-new texts in a side file called the "write-ahead log" (`chat.db-wal`). Every time the Mac reboots, macOS throws that side file away and makes a fresh one. The fresh one is technically a *different* file, so our old hardlink now points at the deleted one. The server keeps reading — but it's reading a frozen, out-of-date copy, so it silently stops seeing any new texts. To you it looks like "the agent stopped answering iMessages after I restarted."

## What already exists

The helper already watches your Messages *attachments* (photos, videos) and hardlinks those so the agent can see pictures. It already has Full Disk Access. It already runs as its own background service that starts at login.

## What's new

We taught that same helper to *also* keep the three database files (`chat.db`, `chat.db-wal`, `chat.db-shm`) freshly hardlinked. Every 2 seconds it checks: "does my link still point at the real, current file?" If a reboot swapped the file out, it re-links within 2 seconds — automatically, with no human involved. That's the whole change: about a hundred lines added to one small Go program.

## The safeguards, in plain terms

- It only ever touches the *copies* in the agent's own folder. It never opens, writes, or deletes anything inside the real Messages folder — re-linking is safe by construction.
- It makes no decisions about your messages. It doesn't block, filter, or read message content. It only keeps a file pointer current.
- If it can't do its job (permission missing), it fails loudly in its own log rather than corrupting anything.

## What you actually need to decide

Nothing about the code — it's built and tested. The one human step is a macOS quirk: rebuilding the helper changes its digital "fingerprint," and macOS then requires you to re-approve Full Disk Access for it once, by hand, in System Settings. After that single approval, the fix is permanent and reboots heal themselves.
