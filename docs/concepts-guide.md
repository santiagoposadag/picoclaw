# PicoClaw Concepts & Terminology Guide

> A learning document built from the picoclaw codebase. Each concept gets a
> plain-English definition, a motivation for why it exists, and a real code
> reference. Concepts are ordered from simple primitives to composite patterns
> so the guide can be read linearly.

---

## Table of Contents

1. [Go Language Primitives](#1-go-language-primitives)
   - [goroutine](#11-goroutine)
   - [channel (chan)](#12-channel-chan)
   - [select](#13-select)
   - [sync.Mutex / sync.RWMutex](#14-syncmutex--syncrwmutex)
   - [sync.WaitGroup](#15-syncwaitgroup)
   - [context.Context](#16-contextcontext)
   - [defer](#17-defer)
   - [interface](#18-interface)
2. [OS-Level Operations](#2-os-level-operations)
   - [os.OpenFile flags](#21-osopenfile-flags)
   - [f.Sync() — fsync](#22-fsync--fsync)
   - [os.Rename — atomic swap](#23-osrename--atomic-swap)
   - [File permissions](#24-file-permissions-osfilemode)
   - [os.Getpid()](#25-osgetpid)
3. [Design Patterns](#3-design-patterns)
   - [Atomic file write](#31-atomic-file-write-temp--fsync--rename)
   - [Append-only storage with skip offset](#32-append-only-storage-with-logical-skip-offset)
   - [Sharded locking](#33-sharded-locking-fnv-hash--fixed-mutex-pool)
   - [Channel-based semaphore](#34-channel-based-semaphore)
   - [Stop channel pattern](#35-stop-channel-pattern)
4. [Agent System Concepts](#4-agent-system-concepts)
   - [Agent execution loop](#41-agent-execution-loop)
   - [Tool system](#42-tool-system)
   - [Model routing](#43-model-routing)
   - [Three-layer architecture](#44-three-layer-architecture)

---

## 1. Go Language Primitives

### 1.1 goroutine

**What it is:** A goroutine is a lightweight function running concurrently with
the rest of the program. You launch one by putting `go` in front of any
function call. The Go runtime multiplexes all goroutines onto a small pool of
OS threads, so you can have thousands without paying the overhead of a full OS
thread per concurrent task.

**Why picoclaw uses it:** Background tasks (cleanup, scheduling, message loops)
must not block the code that serves the next user request. Goroutines let these
tasks run independently at near-zero cost.

**Example — media TTL cleanup goroutine** (`pkg/media/store.go:242-258`):

```go
go func() {
    ticker := time.NewTicker(s.cleanerCfg.Interval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            if n := s.CleanExpired(); n > 0 {
                logger.InfoCF("media", "cleanup: removed expired entries", ...)
            }
        case <-s.stop:
            return
        }
    }
}()
```

The anonymous function runs independently. The outer function returns
immediately after calling `go func()`, while the cleanup loop keeps ticking in
the background until told to stop.

---

### 1.2 channel (chan)

**What it is:** A channel is a typed pipe between goroutines. One goroutine
sends a value into the channel; another receives it. A buffered channel
(`make(chan T, n)`) can hold up to `n` values without a receiver being ready.
An unbuffered channel (`make(chan T)`) forces sender and receiver to rendezvous
at the same instant.

**Why picoclaw uses it:** Channels are the safest way to pass signals and data
between goroutines without shared memory races.

Three different roles appear in the codebase:

**Signal channel** — `stop chan struct{}` in `pkg/media/store.go:62`. The empty
struct `struct{}` carries no data; it is used purely as a signal:

```go
stop chan struct{}   // closing this channel tells the goroutine to exit
```

**Result aggregation** — `resultsCh chan regResult` in
`pkg/skills/registry.go:147`. Each registry goroutine writes its result here;
the caller reads them after all goroutines finish:

```go
resultsCh := make(chan regResult, len(regs))
```

**Semaphore** — `sem chan struct{}` in `pkg/skills/registry.go:146`. A buffered
channel of size N limits how many goroutines run at once (see §3.4 for the full
pattern).

---

### 1.3 select

**What it is:** `select` is like a `switch` for channels. It blocks until one
of its `case` branches has data ready, then executes that branch. If multiple
cases are ready simultaneously, Go picks one at random.

**Why picoclaw uses it:** Goroutines often need to react to whichever of
several events happens first — a tick, a stop signal, a timeout, or user input.
`select` expresses this cleanly with no polling loop.

**Example 1 — cron tick vs stop** (`pkg/cron/service.go:125-133`):

```go
for {
    select {
    case <-stopChan:
        return
    case <-ticker.C:
        cs.checkJobs()
    }
}
```

Every second the ticker fires and jobs are checked. If `stopChan` is closed
first the goroutine exits immediately — no separate "are we stopping?" flag.

**Example 2 — OAuth race** (`pkg/auth/oauth.go:152-176`):

```go
select {
case result := <-resultCh:        // browser callback arrived
    ...
case manualInput := <-manualCh:   // user pasted code manually
    ...
case <-time.After(5 * time.Minute): // neither arrived in time
    return nil, fmt.Errorf("authentication timed out after 5 minutes")
}
```

Whichever of browser callback, manual paste, or timeout happens first wins.
This lets the same code work on a desktop (browser) or a headless server
(manual paste) without polling.

---

### 1.4 sync.Mutex / sync.RWMutex

**What they are:** A `sync.Mutex` is a binary lock: only one goroutine may hold
it at a time. A `sync.RWMutex` is a reader-writer lock: multiple goroutines may
hold the read lock simultaneously, but taking the write lock requires exclusive
access — all readers must finish first.

Use `RWMutex` when reads are frequent and writes are rare; reads do not block
each other, which reduces contention.

**Why picoclaw uses them:** Maps, slices, and multi-field structs are not safe
to access from multiple goroutines without coordination. Mutexes serialize
access without data races.

**Example — sharded mutex array** (`pkg/memory/jsonl.go:58`):

```go
type JSONLStore struct {
    dir   string
    locks [numLockShards]sync.Mutex   // 64 mutexes, one per hash bucket
}
```

Each session is assigned to one of the 64 mutexes based on its key hash
(see §3.3). This is more efficient than a single global mutex because two
sessions in different shards can be written concurrently.

**Example — RWMutex for registry** (`pkg/skills/registry.go:85`):

```go
mu sync.RWMutex
```

`GetRegistry` uses `mu.RLock()` — multiple goroutines can look up a registry
concurrently. `AddRegistry` uses `mu.Lock()` — adding a new registry excludes
everyone else.

---

### 1.5 sync.WaitGroup

**What it is:** A `WaitGroup` is a counter. Call `wg.Add(n)` to register `n`
goroutines, `wg.Done()` from each goroutine when it finishes, and `wg.Wait()`
to block until the counter reaches zero.

**Why picoclaw uses it:** The skills registry fans out a search to all
configured registries concurrently and must wait for all of them before merging
results.

**Example** (`pkg/skills/registry.go:149-181`):

```go
var wg sync.WaitGroup
for _, reg := range regs {
    wg.Add(1)
    go func(r SkillRegistry) {
        defer wg.Done()
        // ... search r ...
        resultsCh <- regResult{results: results}
    }(reg)
}

// Close results channel after all goroutines complete.
go func() {
    wg.Wait()
    close(resultsCh)
}()
```

The range loop launches one goroutine per registry. The separate goroutine
waits for all of them and then closes `resultsCh`. The main goroutine reads
from `resultsCh` until it's closed, then knows all results are in.

---

### 1.6 context.Context

**What it is:** A `Context` is an object passed down the call chain that carries
two things:

1. A **cancellation signal** — any function holding the context can check
   whether it has been cancelled and stop early.
2. A **deadline or timeout** — the context automatically cancels itself at a
   specified time.

`context.WithTimeout(parent, d)` returns a new context that cancels after
duration `d`. `context.WithCancel(parent)` returns a context you cancel
manually. Always call the returned `cancel()` function to release resources.

**Why picoclaw uses it:** Long-running operations (LLM calls, web searches,
OAuth servers) must be bounded. A context timeout ensures they don't hang
forever, especially important on edge hardware where hangs are hard to recover
from.

**Example 1 — 1-minute search timeout** (`pkg/skills/registry.go:164-165`):

```go
searchCtx, cancel := context.WithTimeout(ctx, 1*time.Minute)
defer cancel()
results, err := r.Search(searchCtx, query, limit)
```

If the registry server doesn't respond within a minute, `searchCtx` is
cancelled and `r.Search` returns an error. The `defer cancel()` ensures the
timeout goroutine is cleaned up even if `Search` returns early.

**Example 2 — 2-second OAuth server shutdown** (`pkg/auth/oauth.go:124-127`):

```go
defer func() {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()
    server.Shutdown(ctx)
}()
```

After the OAuth code is received (or times out), the temporary HTTP server must
be shut down gracefully. The 2-second context ensures that shutdown does not
block indefinitely.

---

### 1.7 defer

**What it is:** `defer` schedules a function call to execute when the
surrounding function returns, regardless of how it returns (normal return,
error return, or panic). Deferred calls are run in LIFO (last-in, first-out)
order.

**Why picoclaw uses it:** It guarantees cleanup code runs even when a function
returns early on error. Without `defer`, every early return would need its own
cleanup call — easy to forget.

**Example 1 — always unlock after lock** (`pkg/memory/jsonl.go:219-221`):

```go
l := s.sessionLock(sessionKey)
l.Lock()
defer l.Unlock()
```

No matter how `addMsg` exits — success, marshal error, write error — the mutex
is released. This prevents deadlocks.

**Example 2 — temp file cleanup on error** (`pkg/fileutil/file.go:70-77`):

```go
cleanup := true

defer func() {
    if cleanup {
        tmpFile.Close()
        _ = os.Remove(tmpPath)
    }
}()
```

If any step fails, the deferred closure removes the temp file. At the very end
of the function, `cleanup = false` is set so the successful rename path does
not delete the file it just moved.

---

### 1.8 interface

**What it is:** An interface in Go is a named set of method signatures. Any
type that implements all the methods satisfies the interface automatically —
there is no `implements` keyword. This is called *structural typing* or *duck
typing*.

**Why picoclaw uses it:** Interfaces allow swappable implementations. Tests can
use a fake; production uses the real thing. New backends (e.g. a database-backed
store) can be added without changing callers.

**Key interfaces in the codebase:**

| Interface | File | Purpose |
|-----------|------|---------|
| `Store` | `pkg/memory/store.go:11` | Session storage operations |
| `Classifier` | `pkg/routing/classifier.go:4` | Score a feature set → routing decision |
| `SkillRegistry` | `pkg/skills/registry.go:47` | Search & install skills |
| `MediaStore` | `pkg/media/store.go:23` | Store/resolve media file refs |

**Example — `Store` interface** (`pkg/memory/store.go:11-42`):

```go
type Store interface {
    AddMessage(ctx context.Context, sessionKey, role, content string) error
    GetHistory(ctx context.Context, sessionKey string) ([]providers.Message, error)
    TruncateHistory(ctx context.Context, sessionKey string, keepLast int) error
    Compact(ctx context.Context, sessionKey string) error
    // ...
}
```

`JSONLStore` in `pkg/memory/jsonl.go` is the production implementation. Any
code that depends on `Store` works with any future implementation (in-memory,
Redis, SQLite) without modification.

**Example — `Classifier` interface** (`pkg/routing/classifier.go:10-12`):

```go
type Classifier interface {
    Score(f Features) float64
}
```

`RuleClassifier` is the current implementation. The comment explicitly calls
out that ML-based or embedding-based classifiers could replace it later — the
routing infrastructure doesn't need to change.

---

## 2. OS-Level Operations

### 2.1 os.OpenFile flags

**What they are:** Flags are bit flags passed to `os.OpenFile` that control how
the file is opened. They compose with `|` (bitwise OR).

| Flag | Meaning |
|------|---------|
| `O_CREATE` | Create the file if it does not exist |
| `O_WRONLY` | Open write-only (no reads) |
| `O_APPEND` | All writes go to the end of the file |
| `O_EXCL` | Fail if the file already exists (used with `O_CREATE`) |

**Why picoclaw uses them:** Different operations need different semantics.
Appending a message to a JSONL log needs `O_APPEND` (never overwrites existing
data). Creating a temporary file needs `O_EXCL` (fails if another process
already created the same name, preventing race conditions).

**Example 1 — append to JSONL** (`pkg/memory/jsonl.go:230-234`):

```go
f, err := os.OpenFile(
    s.jsonlPath(sessionKey),
    os.O_CREATE|os.O_WRONLY|os.O_APPEND,
    0o644,
)
```

`O_CREATE|O_WRONLY|O_APPEND`: create the file on first use, open write-only,
and position the cursor at the end so new lines are always added after existing
ones.

**Example 2 — exclusive temp file creation** (`pkg/fileutil/file.go:60-64`):

```go
tmpFile, err := os.OpenFile(
    filepath.Join(dir, fmt.Sprintf(".tmp-%d-%d", os.Getpid(), time.Now().UnixNano())),
    os.O_WRONLY|os.O_CREATE|os.O_EXCL,
    perm,
)
```

`O_EXCL` guarantees that if two processes somehow pick the same temp filename
(extremely unlikely given the PID + nanosecond suffix), one will fail with
`EEXIST` instead of both overwriting the same file silently.

---

### 2.2 f.Sync() — fsync

**What it is:** When you write to a file, the OS typically keeps the data in an
in-kernel page cache for performance. `f.Sync()` issues an `fsync` system call
that forces the OS to flush the page cache to the physical storage device and
waits until the device confirms the write.

**Why picoclaw uses it:** PicoClaw targets edge hardware (Sipeed LicheeRV Nano,
Raspberry Pi) that uses SD cards or eMMC flash storage. These devices have weak
write-ordering guarantees. Without `fsync`, a power cut immediately after
`f.Write()` may leave the file empty or partially written. After `f.Sync()`, the
data is physically on the storage medium.

**Example 1 — sync after JSONL append** (`pkg/memory/jsonl.go:247-250`):

```go
if syncErr := f.Sync(); syncErr != nil {
    f.Close()
    return fmt.Errorf("memory: sync jsonl: %w", syncErr)
}
```

Each message append is individually synced. This matches the durability
guarantee of the atomic write path used for metadata.

**Example 2 — sync temp file before rename** (`pkg/fileutil/file.go:88-90`):

```go
if err := tmpFile.Sync(); err != nil {
    return fmt.Errorf("failed to sync temp file: %w", err)
}
```

The temp file is synced *before* the rename. This ensures the data is
physically written before the atomic rename makes it visible.

---

### 2.3 os.Rename — atomic swap

**What it is:** On POSIX systems (Linux, macOS), `rename(old, new)` is an atomic
system call. The kernel either swaps the directory entry in one indivisible
operation or does nothing. There is no intermediate state where neither the old
nor the new file exists.

**Why picoclaw uses it:** If you wrote directly to the target file and the
process crashed mid-write, you would have a truncated or corrupted file. By
writing to a temp file and then renaming, the target is always either the old
complete version or the new complete version — never a partial write.

**Example** (`pkg/fileutil/file.go:105-107`):

```go
if err := os.Rename(tmpPath, path); err != nil {
    return fmt.Errorf("failed to rename temp file: %w", err)
}
```

This is the final step of `WriteFileAtomic`. The full sequence is:
write → sync → rename. See §3.1 for the complete walkthrough.

---

### 2.4 File permissions (os.FileMode)

**What they are:** Unix file permissions are expressed as a three-digit octal
number. Each digit controls access for owner, group, and others:
`4` = read, `2` = write, `1` = execute.

| Mode | Owner | Group | Others | Use case |
|------|-------|-------|--------|----------|
| `0o644` | rw | r | r | Public readable file (JSONL logs, metadata) |
| `0o600` | rw | — | — | Sensitive file (OAuth tokens, cron store) |
| `0o755` | rwx | rx | rx | Executable directory |

**Why picoclaw uses them:** Credentials and session data must be protected from
other users on shared systems. Log files and conversation history are not
sensitive and can be world-readable for easier inspection.

**Example — `WriteFileAtomic` signature** (`pkg/fileutil/file.go:52`):

```go
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
```

Callers decide the permission. JSONL stores use `0o644`
(`pkg/memory/jsonl.go:124`), cron state uses `0o600`
(`pkg/cron/service.go:360`).

---

### 2.5 os.Getpid()

**What it is:** `os.Getpid()` returns the process ID (PID) of the current
process — a unique integer assigned by the OS kernel at process startup.

**Why picoclaw uses it:** Temp file names must be unique. On a system where
multiple picoclaw processes run simultaneously (e.g. separate test processes),
they should not overwrite each other's temp files. Including the PID in the
filename makes collisions between processes impossible.

**Example** (`pkg/fileutil/file.go:61`):

```go
fmt.Sprintf(".tmp-%d-%d", os.Getpid(), time.Now().UnixNano())
```

Two components: `os.Getpid()` (unique per process) + `time.Now().UnixNano()`
(unique per call within a process). Together they guarantee uniqueness across
concurrent calls from multiple processes.

---

## 3. Design Patterns

### 3.1 Atomic file write (temp + fsync + rename)

**What it is:** A crash-safe pattern for updating a file. The core insight:
never modify the target file in place. Instead:

1. Write new content to a temporary file in the **same directory**.
2. `fsync` the temp file (flush to physical storage).
3. `os.Rename` the temp file onto the target path (atomic directory update).

The rename is the only moment the change becomes visible, and it is atomic —
it either happens completely or not at all.

**Why picoclaw uses it:** Edge devices can lose power at any moment. A direct
overwrite that crashes midway leaves a corrupt file. This pattern leaves the
original untouched until the last safe moment.

**Full walkthrough** (`pkg/fileutil/file.go:52-119`):

```
WriteFileAtomic(path, data, perm)
    |
    |  1. os.MkdirAll(dir)             — ensure parent directory exists
    |
    |  2. os.OpenFile(".tmp-PID-ns", O_WRONLY|O_CREATE|O_EXCL)
    |     — create temp file in same directory (ensures rename crosses no
    |       filesystem boundary)
    |
    |  3. defer cleanup()
    |     — if anything fails, delete the temp file
    |
    |  4. tmpFile.Write(data)           — write new content to temp
    |
    |  5. tmpFile.Sync()                — flush to physical storage
    |     — CRITICAL: without this, data may still be in the OS page cache
    |       when we rename; a crash after rename would find an empty file
    |
    |  6. tmpFile.Chmod(perm)           — set permissions before closing
    |
    |  7. tmpFile.Close()               — required before rename on Windows
    |
    |  8. os.Rename(tmpPath, path)      — atomic swap; target is now new
    |
    |  9. dirFile.Sync()                — sync directory metadata so the
    |     — rename survives a crash (prevents orphaned inode)
    |
    | 10. cleanup = false               — success: nothing to clean up
```

If steps 4-7 fail, the deferred cleanup deletes the temp file. The target is
never touched. If step 8 fails, the target is still the old version. There is
no state where the target is partially written.

---

### 3.2 Append-only storage with logical skip offset

**What it is:** Instead of physically deleting old messages from a JSONL file,
advance a `skip` counter in a separate metadata file. Readers skip the first
`skip` lines without unmarshaling them. The file only ever grows; writes are
always appends.

**Why picoclaw uses it:** Append-only writes are faster and safer than
in-place modifications. Deletion is expensive (requires rewriting the entire
file). The `skip` trick gives O(1) logical truncation with no data loss — the
history is preserved and can be compacted later when disk space matters.

**Data model** (`pkg/memory/jsonl.go:36-43`):

```go
type sessionMeta struct {
    Key       string    `json:"key"`
    Skip      int       `json:"skip"`    // <-- how many lines to ignore
    Count     int       `json:"count"`   // <-- total lines in the file
    // ...
}
```

**How truncation works** (`pkg/memory/jsonl.go:327-361`):

```
TruncateHistory(sessionKey, keepLast=10)
    |
    |  1. Read metadata (meta.Count = current line count)
    |
    |  2. Re-count lines on disk (reconcile stale meta after a crash)
    |
    |  3. meta.Skip = meta.Count - keepLast
    |     (keep only the last 10 lines)
    |
    |  4. WriteFileAtomic(meta) — persist the new skip offset
    |
    |  — The JSONL file is NOT modified.
```

**How reading works** (`pkg/memory/jsonl.go:131-176`):

```go
lineNum := 0
for scanner.Scan() {
    lineNum++
    if lineNum <= skip {
        continue   // skip without unmarshaling — cheap!
    }
    json.Unmarshal(line, &msg)
    msgs = append(msgs, msg)
}
```

**Compaction** (`pkg/memory/jsonl.go:402-439`): When you want to reclaim disk
space, `Compact()` reads the active messages, rewrites the JSONL file using
`WriteFileAtomic`, and resets `skip` to 0. It is safe to skip compaction
indefinitely; the `skip` mechanism handles it.

---

### 3.3 Sharded locking (FNV hash → fixed mutex pool)

**What it is:** Instead of one global mutex for all sessions (a bottleneck) or
a map of per-session mutexes (unbounded memory), use a fixed array of `N`
mutexes and assign sessions to them by hashing the session key modulo `N`.

**Why picoclaw uses it:** The agent is a long-running daemon that may accumulate
thousands of sessions over its lifetime. A map of mutexes would grow without
bound. A single global mutex would serialize all session writes. 64 mutexes is
a practical sweet spot: bounded memory, and 64× less contention than a single
lock.

**Implementation** (`pkg/memory/jsonl.go:22-26` and `73-77`):

```go
const numLockShards = 64

type JSONLStore struct {
    locks [numLockShards]sync.Mutex   // fixed array, never grows
}

func (s *JSONLStore) sessionLock(key string) *sync.Mutex {
    h := fnv.New32a()
    h.Write([]byte(key))
    return &s.locks[h.Sum32()%numLockShards]  // deterministic bucket
}
```

**FNV (Fowler-Noll-Vo)** is a fast non-cryptographic hash function. For any
given key, it always returns the same bucket, so the same session always uses
the same mutex — correct serialization with no extra bookkeeping.

**Usage** (`pkg/memory/jsonl.go:219-221`):

```go
l := s.sessionLock(sessionKey)
l.Lock()
defer l.Unlock()
```

Every read and write operation acquires the shard lock for the session key.
Two sessions in different shards can proceed concurrently.

---

### 3.4 Channel-based semaphore

**What it is:** A buffered channel of size `N` acts as a semaphore that limits
concurrent goroutines to at most `N`. Before starting work, a goroutine sends a
token into the channel (acquiring the semaphore). When done, it receives a
token back (releasing the semaphore). If `N` goroutines are already running,
the send blocks until one finishes.

**Why picoclaw uses it:** Unlimited concurrency would overwhelm external
registries with requests. The semaphore provides back-pressure — at most
`maxConcurrent` (default: 2) searches run at any time.

**Example** (`pkg/skills/registry.go:145-165`):

```go
sem := make(chan struct{}, rm.maxConcurrent)   // capacity = max concurrent

go func(r SkillRegistry) {
    defer wg.Done()

    // Acquire: blocks if N goroutines are already running
    select {
    case sem <- struct{}{}:
        defer func() { <-sem }()   // Release when done
    case <-ctx.Done():
        resultsCh <- regResult{err: ctx.Err()}
        return
    }

    // ... do search work here ...
}(reg)
```

The `select` also handles context cancellation — if the overall operation is
cancelled before a slot is available, the goroutine exits cleanly instead of
blocking forever.

---

### 3.5 Stop channel pattern

**What it is:** A `chan struct{}` is used as a one-way shutdown signal. The
goroutine that owns the background loop selects on the channel. The controller
calls `close(stop)` to broadcast the signal to all listeners. `close()` on a
channel unblocks all current and future receives on that channel.

**Why picoclaw uses it:** It is idiomatic Go for cooperative goroutine
termination. No shared boolean flag, no mutex, no polling — just a closed
channel that is always immediately readable.

**Example — media cleanup** (`pkg/media/store.go:62,85-87,254-269`):

```go
// Struct field
stop chan struct{}

// Initialization (in NewFileMediaStoreWithCleanup)
stop: make(chan struct{}),

// Goroutine listens
case <-s.stop:
    return

// Controller signals shutdown (once, safely)
func (s *FileMediaStore) Stop() {
    s.stopOnce.Do(func() {
        close(s.stop)
    })
}
```

`sync.Once` (`stopOnce`) ensures `close` is called at most once — closing an
already-closed channel would panic.

**Same pattern in cron** (`pkg/cron/service.go:99-101,127`):

```go
cs.stopChan = make(chan struct{})
go cs.runLoop(cs.stopChan)
// ...
case <-stopChan:
    return
```

---

## 4. Agent System Concepts

### 4.1 Agent execution loop

**What it is:** The core cycle that the agent runs for every user message. It
alternates between calling the LLM and executing tools until the LLM produces a
final text answer with no more tool calls.

**The 5-step cycle** (from `docs/agent-architecture.md`, §6):

```
1. RECEIVE MESSAGE
   User sends: "List the files in /tmp and summarize them"

2. CALL LLM
   Send: system prompt + conversation history + available tools
   LLM responds: ToolCall{ name: "list_dir", args: {path: "/tmp"} }

3. EXECUTE TOOL
   Agent runs list_dir("/tmp") → returns file listing

4. FEED RESULT BACK
   Append ToolResult to conversation history
   Call LLM again with updated history

5. CHECK FOR MORE TOOL CALLS
   LLM sees the result and responds with plain text: "There are 3 files..."
   No tool calls → exit loop → send answer to user
```

The loop repeats steps 2-4 until the LLM responds without any tool calls, or
until `MaxIterations` is reached (default: 20). This prevents runaway loops.

**Implementation reference:** `pkg/agent/loop.go` — `Run()` (outer message
loop, line 243) and `processMessage()` (inner LLM iteration loop, line 675).
See `docs/agent-architecture.md` §6 for a detailed step-by-step walkthrough.

---

### 4.2 Tool system

**What it is:** A tool is a named action the LLM can request (read a file, run
a command, search the web). The agent maintains a `ToolRegistry` — a map from
tool name to tool implementation. During the agent loop, when the LLM returns a
`ToolCall`, the agent looks up the tool, executes it, and wraps the result in a
`ToolResult` message fed back to the LLM.

**Data flow:**

```
LLM response:
  ToolCall {
      id:   "call_abc123"
      name: "read_file"
      args: {"path": "/etc/hosts"}
  }
         |
         v
  AgentLoop.executeTool(toolCall)
         |
         v
  registry.Get("read_file").Execute(args)
         |
         v
  ToolResult {
      call_id: "call_abc123"
      content: "127.0.0.1 localhost\n..."
  }
         |
         v
  Appended to conversation history → next LLM call
```

**Built-in tools registered per agent** (from `docs/agent-architecture.md` §3):

| Tool | What it does |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `list_dir` | List directory contents |
| `exec` | Execute shell commands |
| `edit_file` | Edit file ranges |
| `append_file` | Append to file |

**Shared tools registered by AgentLoop** (from `docs/agent-architecture.md`
§5):

| Tool | What it does |
|------|-------------|
| `web` | Web search |
| `web_fetch` | Fetch and parse URLs |
| `message` | Send messages to users/channels |
| `find_skills` | Search skill registry |
| `install_skill` | Install a skill |
| `spawn` | Create subagent background tasks |

---

### 4.3 Model routing

**What it is:** Before each LLM call, the router decides whether to send the
request to the primary (heavy/expensive) model or a lighter (cheap/fast) model.
The decision is made by extracting structural features from the message and
computing a complexity score.

**Why picoclaw uses it:** LLM API costs scale with model capability. Simple
questions ("what time is it?") do not need a heavy model. Routing saves cost on
edge devices where API spend matters.

**Step 1 — Feature extraction** (`pkg/routing/features.go:43-51`):

```go
func ExtractFeatures(msg string, history []providers.Message) Features {
    return Features{
        TokenEstimate:     estimateTokens(msg),      // CJK-aware token proxy
        CodeBlockCount:    countCodeBlocks(msg),      // ``` pair count
        RecentToolCalls:   countRecentToolCalls(history), // last 6 history entries
        ConversationDepth: len(history),              // total message count
        HasAttachments:    hasAttachments(msg),       // images/audio/video
    }
}
```

All features are structural (counts, lengths) — no keyword matching. This makes
routing locale-agnostic.

**Step 2 — Weighted scoring** (`pkg/routing/classifier.go:40-80`):

```go
func (c *RuleClassifier) Score(f Features) float64 {
    if f.HasAttachments { return 1.0 }  // hard gate: always heavy

    var score float64
    switch {
    case f.TokenEstimate > 200: score += 0.35
    case f.TokenEstimate > 50:  score += 0.15
    }
    if f.CodeBlockCount > 0 { score += 0.40 }
    switch {
    case f.RecentToolCalls > 3: score += 0.25
    case f.RecentToolCalls > 0: score += 0.10
    }
    if f.ConversationDepth > 10 { score += 0.10 }
    if score > 1.0 { score = 1.0 }
    return score
}
```

**Step 3 — Threshold decision:**

| Score | Decision | Example |
|-------|----------|---------|
| `>= 0.35` | Heavy model | Message with code block (score = 0.40) |
| `< 0.35` | Light model | Short greeting (score = 0.00) |
| `1.00` | Heavy (forced) | Any attachment |

The `Classifier` interface (`pkg/routing/classifier.go:10`) means this scoring
logic can be swapped for an ML model or embedding-based classifier without
changing the routing infrastructure.

---

### 4.4 Three-layer architecture

**What it is:** The agent system is split into three layers with distinct
responsibilities. Each layer in its own file.

```
┌─────────────────────────────────────────────────────┐
│                   AgentLoop                         │  pkg/agent/loop.go
│         The engine: runs forever,                   │
│    consumes messages, drives the think-act cycle    │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │              AgentRegistry                    │  │  pkg/agent/registry.go
│  │    A phonebook of all configured agents       │  │
│  │                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │AgentInstance  │  │AgentInstance │  ...     │  │  pkg/agent/instance.go
│  │  │ id: "main"   │  │ id: "research"│         │  │
│  │  │ model: gpt-4 │  │ model: gpt-3 │         │  │
│  │  │ tools: [...]  │  │ tools: [...]  │         │  │
│  │  └──────────────┘  └──────────────┘          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Layer 1 — AgentInstance** (`pkg/agent/instance.go`): A fully configured agent
identity. It is a *data structure*, not a running process. It holds: which AI
model to use, fallback models, workspace directory, tool registry, session
store, context builder, and optional model router. Think of it as a parked car:
engine off, fully assembled.

**Layer 2 — AgentRegistry** (`pkg/agent/registry.go`): A map of all configured
agents. Routes incoming messages to the right agent based on channel, sender, or
guild membership. Uses `sync.RWMutex` for thread-safe access. If no agents are
configured, automatically creates an implicit "main" agent.

**Layer 3 — AgentLoop** (`pkg/agent/loop.go`): The runtime engine. Runs
forever in a goroutine, blocking on `bus.ConsumeInbound()`. When a message
arrives, it calls `processMessage()` which resolves the route, optionally runs
the model router, then runs the LLM iteration cycle. Uses `sync.WaitGroup` to
track in-flight requests for safe shutdown.

**Why this separation matters:** The same `AgentLoop` can serve multiple agents
simultaneously (different channels, different bots). Swapping the model or tools
for one agent doesn't affect the others. The loop itself knows nothing about
which model or tools are in use — it just calls the interface.

For the full detailed walkthrough of each layer, see `docs/agent-architecture.md`.
