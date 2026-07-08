// instar-attachments-sync
//
// Purpose-built binary for mirroring iMessage photo attachments to a
// readable location for the Instar agent. This binary is granted Full
// Disk Access in macOS Privacy settings — nothing else needs it.
//
// What it does (and only what it does):
//   1. On startup: hardlink all existing image/video attachments from
//      ~/Library/Messages/Attachments/ to DEST_DIR.
//   2. Continuously watch for new files via FSEvents and hardlink them.
//   3. Prune dead hardlinks (source deleted, link count == 1).
//
// Naming convention: {first8ofUUID}__{original-filename}
// This mirrors the bash script it replaces, so existing hardlinks remain valid.

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

var (
	homeDir     = os.Getenv("HOME")
	srcDir      = filepath.Join(homeDir, "Library/Messages/Attachments")
	messagesDir = filepath.Join(homeDir, "Library/Messages")
	destDir     string
	chatDbDir   string
	logFile     string
)

// chatDbFiles are the SQLite files the node daemon reads through hardlinks.
// The daemon runs WITHOUT Full Disk Access; this binary (which HAS FDA) keeps
// these hardlinks fresh so the daemon can read the live database — including
// the write-ahead log where brand-new messages live before a checkpoint.
var chatDbFiles = []string{"chat.db", "chat.db-wal", "chat.db-shm"}

// How often to re-verify the chat.db hardlinks. Cheap (a few stat() calls);
// it only re-links when an inode has actually drifted. Override with
// CHATDB_SYNC_INTERVAL_MS for testing.
const defaultChatDbSyncInterval = 2 * time.Second

// Supported extensions to mirror
var exts = map[string]bool{
	".jpeg": true, ".jpg": true, ".png": true, ".heic": true,
	".mov": true, ".mp4": true, ".pdf": true, ".gif": true,
	".caf": true, ".m4a": true, ".3gpp": true,
}

func main() {
	// Resolve paths relative to this binary's location.
	// Binary lives at <agentRoot>/.instar/bin/instar-attachments-sync
	// So .instar dir is filepath.Dir(filepath.Dir(exe))
	exe, err := os.Executable()
	if err != nil {
		log.Fatalf("cannot resolve executable path: %v", err)
	}
	dotInstar := filepath.Dir(filepath.Dir(exe)) // <agentRoot>/.instar
	destDir = filepath.Join(dotInstar, "imessage/attachments")
	chatDbDir = filepath.Join(dotInstar, "imessage")
	logFile = filepath.Join(dotInstar, "logs/attachments-watcher.log")

	// Override via env for testing
	if v := os.Getenv("ATTACHMENTS_DEST"); v != "" {
		destDir = v
	}
	if v := os.Getenv("CHATDB_DEST"); v != "" {
		chatDbDir = v
	}
	if v := os.Getenv("ATTACHMENTS_LOG"); v != "" {
		logFile = v
	}

	if err := os.MkdirAll(destDir, 0755); err != nil {
		log.Fatalf("cannot create dest dir: %v", err)
	}
	if err := os.MkdirAll(chatDbDir, 0755); err != nil {
		log.Fatalf("cannot create chatdb dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(logFile), 0755); err != nil {
		log.Fatalf("cannot create log dir: %v", err)
	}

	lf, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("cannot open log: %v", err)
	}
	log.SetOutput(lf)
	log.SetFlags(0) // we write our own timestamps

	logMsg("instar-attachments-sync starting")
	logMsg("src=%s dest=%s", srcDir, destDir)

	// Initial sync
	n, err := syncOnce()
	if err != nil {
		logMsg("initial sync error: %v", err)
	} else {
		logMsg("initial sync: linked %d new files", n)
	}

	// Initial chat.db hardlink sync — critical after a reboot, when macOS
	// Messages recreates the -wal file with a fresh inode and the daemon's
	// old hardlink goes stale. Re-linking here restores it immediately.
	if r, err := syncChatDb(); err != nil {
		logMsg("initial chatdb sync error: %v", err)
	} else {
		logMsg("initial chatdb sync: relinked %d file(s)", r)
	}

	// Continuous chat.db hardlink maintenance. This is what makes iMessage
	// robust to WAL-inode churn: the daemon never needs Full Disk Access and
	// its view of the database self-heals within one interval of any drift.
	go chatDbLoop()

	// Watch for new files
	if err := watch(); err != nil {
		logMsg("watcher error: %v", err)
		os.Exit(1)
	}
}

// chatDbSyncInterval returns the re-link cadence (env-overridable for tests).
func chatDbSyncInterval() time.Duration {
	if v := os.Getenv("CHATDB_SYNC_INTERVAL_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultChatDbSyncInterval
}

// chatDbLoop re-verifies the chat.db hardlinks on a ticker forever.
func chatDbLoop() {
	ticker := time.NewTicker(chatDbSyncInterval())
	defer ticker.Stop()
	for range ticker.C {
		if r, err := syncChatDb(); err != nil {
			logMsg("chatdb sync error: %v", err)
		} else if r > 0 {
			logMsg("chatdb relinked %d file(s)", r)
		}
	}
}

// syncChatDb hardlinks chat.db + chat.db-wal + chat.db-shm from
// ~/Library/Messages into the agent's private imessage dir, recreating any
// link whose inode has drifted from the live file (or is missing). Returns
// the count of links (re)created.
//
// Safety: it only ever removes/creates links UNDER chatDbDir. Removing a
// hardlink never affects the live file's data — hardlinks are peers, not
// parent/child. It never opens or writes the live database.
func syncChatDb() (int, error) {
	relinked := 0
	var firstErr error
	for _, name := range chatDbFiles {
		src := filepath.Join(messagesDir, name)
		dst := filepath.Join(chatDbDir, name)

		if _, err := os.Stat(src); err != nil {
			// -wal / -shm are legitimately absent when the DB isn't in WAL
			// mode at that instant; skip quietly rather than error.
			if os.IsNotExist(err) {
				continue
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		// Already pointing at the live inode? Nothing to do — live writes are
		// already visible through the shared inode.
		if isSameInode(src, dst) {
			continue
		}

		// Stale (drifted inode) or missing — recreate.
		if _, err := os.Lstat(dst); err == nil {
			os.Remove(dst)
		}
		if err := os.Link(src, dst); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("link %s: %w", name, err)
			}
			continue
		}
		relinked++
	}
	return relinked, firstErr
}

// syncOnce walks srcDir and hardlinks any new supported files to destDir.
// Returns count of newly linked files.
func syncOnce() (int, error) {
	count := 0
	err := filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			// Skip dirs/files we can't read — log once at top level
			if path == srcDir {
				return fmt.Errorf("cannot read source dir %s: %w", srcDir, err)
			}
			return nil
		}
		if info.IsDir() || strings.HasPrefix(info.Name(), ".") {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(info.Name()))
		if !exts[ext] {
			return nil
		}
		if linked, err := linkFile(path); err != nil {
			logMsg("link error %s: %v", path, err)
		} else if linked {
			count++
		}
		return nil
	})
	// Prune dead hardlinks
	pruneDeadLinks()
	return count, err
}

// linkFile creates a hardlink in destDir for the given source file.
// Returns true if a new link was created, false if it already existed.
func linkFile(src string) (bool, error) {
	base := filepath.Base(src)
	// Parent dir is the UUID directory
	uuid := filepath.Base(filepath.Dir(src))
	prefix := uuid
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	destName := prefix + "__" + base
	dest := filepath.Join(destDir, destName)

	// Check if already linked (same inode)
	if isSameInode(src, dest) {
		return false, nil
	}

	// Remove stale dest if present
	if _, err := os.Lstat(dest); err == nil {
		os.Remove(dest)
	}

	if err := os.Link(src, dest); err != nil {
		return false, err
	}
	return true, nil
}

// isSameInode returns true if both paths exist and share an inode.
func isSameInode(a, b string) bool {
	sa, err := os.Stat(a)
	if err != nil {
		return false
	}
	sb, err := os.Stat(b)
	if err != nil {
		return false
	}
	sia, ok1 := sa.Sys().(*syscall.Stat_t)
	sib, ok2 := sb.Sys().(*syscall.Stat_t)
	return ok1 && ok2 && sia.Ino == sib.Ino
}

// pruneDeadLinks removes hardlinks whose source has been deleted (link count == 1).
func pruneDeadLinks() {
	entries, err := os.ReadDir(destDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(destDir, e.Name())
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink == 1 {
			os.Remove(path)
		}
	}
}

// watch uses fsnotify to watch srcDir and re-runs syncOnce on changes.
func watch() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("fsnotify: %w", err)
	}
	defer watcher.Close()

	// Watch top-level src dir; we'll add subdirs as they appear
	if err := watcher.Add(srcDir); err != nil {
		return fmt.Errorf("watch %s: %w", srcDir, err)
	}

	// Also watch existing subdirs (Messages uses 2-level nesting)
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			watcher.Add(path) //nolint
		}
		return nil
	})

	logMsg("watching %s", srcDir)

	debounce := time.NewTimer(0)
	<-debounce.C // drain initial fire

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return fmt.Errorf("watcher channel closed")
			}
			// Watch new subdirectories as they're created
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					watcher.Add(event.Name) //nolint
				}
			}
			// Debounce: wait 500ms after last event before syncing
			debounce.Reset(500 * time.Millisecond)

		case err, ok := <-watcher.Errors:
			if !ok {
				return fmt.Errorf("watcher error channel closed")
			}
			logMsg("watcher error: %v", err)

		case <-debounce.C:
			n, err := syncOnce()
			if err != nil {
				logMsg("sync error: %v", err)
			} else if n > 0 {
				logMsg("linked %d new files", n)
			}
		}
	}
}

func logMsg(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("%s %s", time.Now().UTC().Format("2006-01-02T15:04:05Z"), msg)
}
