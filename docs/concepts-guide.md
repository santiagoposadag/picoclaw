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

**Everyday analogy:** Imagine you hire a helper robot to clean your room while
you keep playing video games. You don't stop what you're doing — the robot just
works in the background until the job is done. A goroutine is that helper robot:
you kick it off with `go`, and your program keeps running without waiting for it.

**Real-world example:** A web server that handles thousands of requests at the
same time uses one goroutine per request. Each request is served independently
without blocking the others.

**What it is:** A goroutine is a lightweight function running at the same time as
the rest of the program. You launch one by putting `go` in front of any
function call. The Go runtime fits all goroutines onto a small pool of
real threads, so you can have thousands without the heavy cost of one thread
per task.

**Why picoclaw uses it:** Background tasks (cleanup, scheduling, message loops)
must not block the code that serves the next user request — so that the program
stays fast and responsive. Without goroutines, background cleanup would freeze
every user action while it ran.

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

**Everyday analogy:** Picture two tin cans connected by a string — you speak
into one can and your friend hears it through the other. A channel is that
tin-can telephone between two goroutines: one goroutine sends a message in,
another receives it on the other end.

**Real-world example:** Chat apps use a similar idea — one part of the code
produces new messages, another part displays them. They hand messages back and
forth through a queue so they never trip over each other.

**What it is:** A channel is a typed pipe between goroutines. One goroutine
sends a value into the channel; another receives it. A buffered channel
(`make(chan T, n)`) can hold up to `n` values before a receiver must be ready.
An unbuffered channel (`make(chan T)`) means the sender and receiver must meet
at the exact same moment.

**Why picoclaw uses it:** Channels are the safest way to pass signals and data
between goroutines — so that no two goroutines accidentally read or write the
same memory at the same time.

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

**Everyday analogy:** Think of a "whoever shouts first wins" game. You're
sitting in the middle of a room and four friends are about to shout a message
at you. You listen to all of them at once and respond to whichever voice
reaches you first. `select` is that game: the program waits on several channels
at once and reacts to the first one that has something ready.

**Real-world example:** A food delivery app waits for either the restaurant to
confirm the order, the driver to accept, or a timer to fire a "no response"
alert — whichever happens first triggers the next action.

**What it is:** `select` is like a `switch` for channels. It blocks until one
of its `case` branches has data ready, then runs that branch. If more than one
case is ready at the same time, Go picks one at random.

**Why picoclaw uses it:** Goroutines often need to react to whichever of
several events happens first — a tick, a stop signal, a timeout, or user input
— so that nothing is missed and no separate "are we stopping?" flag is needed.

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

**Everyday analogy (Mutex):** Think of a bathroom with a lock. Only one person
can be inside at a time. Everyone else waits in line outside. When you leave,
you unlock the door and the next person can go in. A `Mutex` is that lock — it
guarantees only one goroutine is touching the shared data at a time.

**Everyday analogy (RWMutex):** Imagine a library reading room. Many people can
sit and read books at the same time — that's fine. But if someone needs to
rearrange the shelves (write), everyone has to leave until the shelving is done.
A `RWMutex` works the same way: many readers at once, but only one writer and
no readers while writing.

**Real-world example:** A web server that keeps a cache of user profiles in
memory uses an `RWMutex`. Reading a profile is frequent and safe to do in
parallel. Updating a profile is rare and must be done alone.

**What they are:** A `sync.Mutex` is a binary lock: only one goroutine may hold
it at a time. A `sync.RWMutex` is a reader-writer lock: many goroutines may
hold the read lock at the same time, but taking the write lock requires
exclusive access — all readers must finish first.

Use `RWMutex` when reads are frequent and writes are rare — so that reads do
not slow each other down.

**Why picoclaw uses them:** Maps, slices, and multi-field structs are not safe
to access from multiple goroutines without coordination — so that no two
goroutines corrupt the same data. Without mutexes, two goroutines writing at
the same time could produce garbage data.

**Example — sharded mutex array** (`pkg/memory/jsonl.go:58`):

```go
type JSONLStore struct {
    dir   string
    locks [numLockShards]sync.Mutex   // 64 mutexes, one per hash bucket
}
```

Each session is assigned to one of the 64 mutexes based on its key hash
(see §3.3). This is more efficient than a single global mutex because two
sessions in different shards can be written at the same time.

**Example — RWMutex for registry** (`pkg/skills/registry.go:85`):

```go
mu sync.RWMutex
```

`GetRegistry` uses `mu.RLock()` — multiple goroutines can look up a registry
at the same time. `AddRegistry` uses `mu.Lock()` — adding a new registry
excludes everyone else.

---

### 1.5 sync.WaitGroup

**Everyday analogy:** Imagine a teacher doing roll call at the end of a field
trip. She has a list of every student's name. She waits at the bus until every
name has been checked off. Only then does the bus leave. A `WaitGroup` is that
roll-call list: you add names before people go off, each person checks
themselves off when they're back, and `wg.Wait()` keeps the bus waiting until
the list is empty.

**Real-world example:** A build system that compiles ten files in parallel uses
a WaitGroup. It launches one worker per file, then waits for all of them to
finish before linking the final program.

**What it is:** A `WaitGroup` is a counter. Call `wg.Add(n)` to register `n`
goroutines, `wg.Done()` from each goroutine when it finishes, and `wg.Wait()`
to block until the counter reaches zero.

**Why picoclaw uses it:** The skills registry fans out a search to all
configured registries at the same time and must wait for all of them before
merging results — so that the final answer is complete before it is returned.

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

**Everyday analogy:** Picture an egg timer you pass to every helper robot when
you give them a job. When the timer rings, every robot that's still working
drops what it's doing and comes back. A `context.Context` is that egg timer:
you set a time limit, pass it into every function that does work, and when the
timer runs out everyone stops automatically.

**Real-world example:** A web browser sets a timeout on every HTTP request. If
the server doesn't respond in 30 seconds, the browser cancels the request
instead of waiting forever. Internally, that timeout is often represented by a
context.

**What it is:** A `Context` is an object passed down the call chain that carries
two things:

1. A **cancellation signal** — any function holding the context can check
   whether it has been cancelled and stop early.
2. A **deadline or timeout** — the context automatically cancels itself at a
   specified time.

`context.WithTimeout(parent, d)` returns a new context that cancels after
duration `d`. `context.WithCancel(parent)` returns a context you cancel
manually. Always call the returned `cancel()` function to release resources.

**Why picoclaw uses it:** Long-running operations (AI model calls, web searches,
login servers) must have a time limit — so that they don't hang forever.
Without a context, a single slow network call could freeze the whole program,
especially on edge hardware where hangs are hard to recover from.

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
be shut down cleanly. The 2-second context ensures that shutdown does not
block indefinitely.

---

### 1.7 defer

**Everyday analogy:** Imagine you stick a sticky note on a door that says "turn
off the lights when you leave, no matter what." Even if you leave in a hurry,
even if you trip on the way out, that note still gets followed. `defer` is that
sticky note: you write the cleanup instruction once at the top, and it runs
when the function finishes — no matter how it finishes.

**Real-world example:** A database library opens a connection at the start of a
function. It uses `defer` to close the connection so it's always released when
the function exits, whether the query succeeded or failed.

**What it is:** `defer` schedules a function call to run when the surrounding
function returns, no matter how it returns (normal, error, or crash). If
multiple `defer` calls are stacked, the last one added runs first (like a stack
of plates — you take from the top).

**Why picoclaw uses it:** It guarantees cleanup code runs even when a function
exits early on an error. Without `defer`, every early exit would need its own
cleanup call — easy to forget, and forgetting causes leaks or deadlocks.

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

**Everyday analogy:** Think of a job posting on a notice board: "Wanted: someone
who can bake, decorate, and deliver cakes." Any person (or robot) who can do
all three things gets the job — you don't need to know who they are in advance.
An interface is that job posting. Any type that has all the listed methods
"gets hired" automatically — no special keyword needed.

**Real-world example:** A payment system defines an interface called `PaymentGateway`
with a single method `Charge(amount)`. Whether the real implementation uses
Stripe, PayPal, or a fake version for testing doesn't matter — the checkout code
just calls `Charge` and works with all of them.

**What it is:** An interface in Go is a named set of method signatures. Any
type that has all those methods satisfies the interface automatically —
there is no `implements` keyword. If it can do the job, it's hired.

**Why picoclaw uses it:** Interfaces allow swappable implementations — so that
tests can use a fake and production uses the real thing. New storage backends
(a database, Redis, or SQLite) can be added without changing any code that
uses the storage.

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
out that AI-based or embedding-based classifiers could replace it later — the
routing infrastructure doesn't need to change.

---

## 2. OS-Level Operations

### 2.1 os.OpenFile flags

**Everyday analogy:** When you open a new notebook you have to decide a few
things: do you want a brand new notebook or an existing one? Do you want to
write in it or just read? Should new words go at the end or can you write
anywhere? Flags are the answers to those questions — rules you give the
computer when you open a file.

**Real-world example:** A logging library opens its log file with "append-only"
mode so every new log line goes to the end and old lines are never overwritten.
If it accidentally opened in "overwrite" mode, the log would be erased on every
restart.

**What they are:** Flags are settings passed to `os.OpenFile` that control how
the file is opened. They are combined with `|` (bitwise OR, meaning "this one
AND that one").

| Flag | Meaning |
|------|---------|
| `O_CREATE` | Create the file if it does not exist |
| `O_WRONLY` | Open write-only (no reads) |
| `O_APPEND` | All writes go to the end of the file |
| `O_EXCL` | Fail if the file already exists (used with `O_CREATE`) |

**Why picoclaw uses them:** Different operations need different rules — so that
the right thing happens automatically. Appending a message to a log needs
`O_APPEND` (so existing data is never overwritten). Creating a temp file needs
`O_EXCL` (so two processes can't accidentally create the same file name at the
same time).

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
(extremely unlikely given the process ID + nanosecond suffix), one will fail
instead of both overwriting the same file silently.

---

### 2.2 f.Sync() — fsync

**Everyday analogy:** When you copy a file to a USB drive, the progress bar
might finish but the file isn't truly saved until you click "Eject." If you
yank the USB out early, the file could be empty or broken. `f.Sync()` is the
"Eject" button — it makes sure the data is physically on the storage medium
before the program moves on.

**Real-world example:** Database engines call `fsync` after every committed
transaction. Without it, a power cut could leave the database in a half-written
state where the commit "happened" in the program but the data never made it to
the disk.

**What it is:** When you write to a file, the operating system (the software
that runs the computer) often keeps the data in a fast temporary memory area
(called a page cache) before sending it to the actual storage device. `f.Sync()`
forces the OS to push everything from that temporary area to the physical
storage and waits until the storage device confirms the write is done.

**Why picoclaw uses it:** PicoClaw targets edge hardware (Sipeed LicheeRV Nano,
Raspberry Pi) that uses SD cards or flash storage. These devices can lose power
at any moment. Without `f.Sync()`, a power cut right after `f.Write()` may
leave the file empty or partly written — so `f.Sync()` makes the data truly
safe before moving on.

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

**Everyday analogy:** Imagine swapping the sign on a shop door in one
instant — nobody ever walks past and sees a blank door. Either the old sign is
there, or the new sign is there, with no moment in between where there's
nothing. `os.Rename` does exactly that for files: it swaps the old file for the
new one in a single step.

**Real-world example:** Package managers (like `apt` or `brew`) update config
files by writing the new version to a temp file and renaming it into place —
so the system always sees either the old config or the new config, never a
half-written one.

**What it is:** On Linux and macOS, `rename(old, new)` is a system call
(a direct instruction to the OS) that swaps a file's name in one
all-or-nothing step. Either the swap completes fully, or nothing happens at
all. There is no moment where neither the old nor the new file exists.

**Why picoclaw uses it:** If you wrote directly to the target file and the
process crashed mid-write, you would have a broken file. By writing to a temp
file and then renaming, the target is always either the old complete version or
the new complete version — never a partial write.

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

**Everyday analogy:** Think of a locker with three kinds of keys: one for the
owner (you), one for your friends (your group), and one for everyone else
(strangers). Each key can open the locker for reading, writing, or both. File
permissions work the same way — you control exactly who is allowed to do what
with each file.

**Real-world example:** A web server stores OAuth tokens (login credentials) in
files with permissions so only the server process can read them. Log files are
set to world-readable so developers can inspect them easily.

**What they are:** Unix file permissions are written as a three-digit number in
octal (base 8). Each digit sets access for owner, group, and others:
`4` = read, `2` = write, `1` = execute. Add the numbers together for combined
permissions.

| Mode | Owner | Group | Others | Use case |
|------|-------|-------|--------|----------|
| `0o644` | rw | r | r | Public readable file (JSONL logs, metadata) |
| `0o600` | rw | — | — | Sensitive file (OAuth tokens, cron store) |
| `0o755` | rwx | rx | rx | Executable directory |

**Why picoclaw uses them:** Credentials and session data must be hidden from
other users on shared systems — so that only the picoclaw process can read
them. Log files and conversation history are not sensitive and can be
world-readable for easier inspection.

**Example — `WriteFileAtomic` signature** (`pkg/fileutil/file.go:52`):

```go
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
```

Callers decide the permission. JSONL stores use `0o644`
(`pkg/memory/jsonl.go:124`), cron state uses `0o600`
(`pkg/cron/service.go:360`).

---

### 2.5 os.Getpid()

**Everyday analogy:** Every worker at a big company wears a name tag with a
unique employee number. When workers leave sticky notes on the printer or
kitchen counter, they sign their number so colleagues know whose note it is.
`os.Getpid()` gives every running program its own unique number — its process
ID (PID) — so temp files can be signed with that number and won't clash.

**Real-world example:** When you run two copies of the same program at the same
time (like two terminal windows running the same script), each copy gets a
different PID. If both need to create temp files, the PID in the filename keeps
them from overwriting each other.

**What it is:** `os.Getpid()` returns the process ID (PID) of the current
program — a unique number assigned by the OS when the program starts.

**Why picoclaw uses it:** Temp file names must be unique — so that multiple
picoclaw processes running at the same time (for example, separate test
processes) don't overwrite each other's temp files. Including the PID makes
collisions between processes impossible.

**Example** (`pkg/fileutil/file.go:61`):

```go
fmt.Sprintf(".tmp-%d-%d", os.Getpid(), time.Now().UnixNano())
```

Two components: `os.Getpid()` (unique per process) + `time.Now().UnixNano()`
(unique per call within a process). Together they guarantee uniqueness across
multiple processes calling this at the same time.

---

## 3. Design Patterns

### 3.1 Atomic file write (temp + fsync + rename)

**Everyday analogy:** You never hand in a half-written paper. First you write a
draft, then you proofread it, then you swap the draft for the final version on
the teacher's desk — in one quick move. That's the atomic file write pattern:
draft → proof-read (sync) → swap (rename). The teacher always sees either the
old complete paper or the new complete paper, never a half-finished one.

**Real-world example:** Text editors like VS Code save files this way. They
write to a temp file, sync it, then rename it into place — so a power cut
during save never corrupts your source file.

**What it is:** A crash-safe pattern for updating a file. The core insight:
never modify the target file directly. Instead:

1. Write new content to a temporary file in the **same directory**.
2. `fsync` the temp file (push data to physical storage).
3. `os.Rename` the temp file onto the target path (single all-or-nothing swap).

The rename is the only moment the change becomes visible, and it either
completes fully or not at all.

**Why picoclaw uses it:** Edge devices can lose power at any moment. A direct
overwrite that crashes halfway leaves a broken file — so this pattern leaves
the original untouched until the last safe moment.

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

**Everyday analogy:** Imagine a notebook you never erase. You always write new
entries at the bottom, and you use a bookmark to remember where the "current"
section starts. Old pages before the bookmark are still there, but you skip
them when reading. That's the append-only pattern: only add to the end, move
the bookmark forward when you want to "delete" old stuff.

**Real-world example:** Git's commit log works similarly — commits are only ever
added, never deleted. To "undo" something you add a new "revert" commit rather
than erasing the old one.

**What it is:** Instead of physically deleting old messages from a JSONL file
(a file where each line is one JSON record), advance a `skip` counter in a
separate metadata file. Readers skip the first `skip` lines without processing
them. The file only ever grows; writes are always appends.

**Why picoclaw uses it:** Appending is faster and safer than rewriting the whole
file — so deletions are instant (just move the bookmark) and no data is lost.
Without this, every "delete old messages" operation would require rewriting the
entire conversation file, which is slow and risky on edge hardware.

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
indefinitely; the bookmark mechanism handles it.

---

### 3.3 Sharded locking (FNV hash → fixed mutex pool)

**Everyday analogy:** Imagine a big store with 64 checkout lanes. Each product
is always assigned to the same lane based on its barcode. Two people buying
different products go to different lanes and check out at the same time — they
never have to wait for each other. Sharded locking is the same idea: instead of
one single checkout lane for everyone (a bottleneck), you spread the work
across 64 lanes.

**Real-world example:** Redis and many database systems shard their internal
hash tables to reduce lock contention. Each shard has its own lock so
operations on different keys can proceed in parallel.

**What it is:** Instead of one global lock for all sessions (a bottleneck) or
one lock per session (which would grow without limit), use a fixed array of `N`
locks and assign sessions to them by hashing (scrambling) the session key and
taking the remainder when dividing by `N`.

**Why picoclaw uses it:** The agent runs for a long time and may handle
thousands of sessions. A single global lock would make every session write wait
for every other — so that sessions in different "lanes" can proceed at the same
time. A map of per-session locks would use more and more memory forever; 64
locks is a practical sweet spot.

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

**FNV (Fowler-Noll-Vo)** is a fast hash function. For any given key it always
returns the same bucket, so the same session always uses the same lock —
correct behavior with no extra bookkeeping.

**Usage** (`pkg/memory/jsonl.go:219-221`):

```go
l := s.sessionLock(sessionKey)
l.Lock()
defer l.Unlock()
```

Every read and write operation acquires the shard lock for the session key.
Two sessions in different shards can proceed at the same time.

---

### 3.4 Channel-based semaphore

**Everyday analogy:** Picture a parking lot with N spaces. There's a barrier at
the entrance. When a space is free, the barrier raises and a car drives in. When
all N spaces are taken, the barrier stays down and the next car waits. When a
car leaves, the barrier raises for the next one. A channel semaphore is that
barrier: it lets at most N goroutines in at a time and makes the rest wait.

**Real-world example:** A browser limits the number of simultaneous connections
to the same server (usually 6-8). Extra requests wait in a queue. Without this
limit, a single page load could flood the server with hundreds of connections
at once.

**What it is:** A buffered channel of size `N` acts as a semaphore (a limit on
simultaneous workers). Before starting work, a goroutine sends a token into the
channel (taking a parking space). When done, it reads a token back (leaving the
space). If `N` goroutines are already running, the send blocks until one
finishes.

**Why picoclaw uses it:** Unlimited goroutines running at once would overwhelm
external skill registries with requests — so that at most `maxConcurrent`
(default: 2) searches run at any time.

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

**Everyday analogy:** Closing the office door is a signal to everyone inside:
"finish what you're doing and head home." Nobody is yanked out mid-task — they
each finish their current work and leave on their own. The stop channel works
the same way: the controller closes the channel, and every goroutine listening
to it finishes its current work and exits.

**Real-world example:** When you press Ctrl+C in a terminal, most well-written
programs catch that signal, set a "stopping" flag, and let in-flight requests
finish before shutting down. The stop channel pattern is the Go version of that.

**What it is:** A `chan struct{}` is used as a one-way shutdown signal. The
goroutine that owns the background loop watches the channel. The controller
calls `close(stop)` to broadcast the signal to all listeners at once. Closing
a channel makes it immediately readable by everyone who is listening.

**Why picoclaw uses it:** It is the standard Go way for cooperative goroutine
shutdown — no shared boolean flag, no lock, no polling — so that goroutines
stop cleanly without being cut off mid-operation.

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
already-closed channel would crash the program.

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

**Everyday analogy:** Think of a helpful robot assistant with a notepad. You
hand it a note with a request. The robot reads the note, does something (like
check the calendar), writes the result in its notepad, then reads the notepad
again to decide if it needs to do anything else. It keeps doing this until it
has a final answer — then it reports back to you and waits for the next note.

**Real-world example:** Voice assistants work the same way: they receive a
request, call a tool (like checking the weather API), incorporate the result,
and may call another tool (like setting a calendar event) before giving a final
spoken response.

**What it is:** The core cycle that the agent runs for every user message. It
alternates between calling the AI model and running tools until the AI produces
a final text answer with no more tool calls.

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

The loop repeats steps 2-4 until the AI responds without any tool calls, or
until `MaxIterations` is reached (default: 20). This prevents runaway loops.

**Implementation reference:** `pkg/agent/loop.go` — `Run()` (outer message
loop, line 243) and `processMessage()` (inner LLM iteration loop, line 675).
See `docs/agent-architecture.md` §6 for a detailed step-by-step walkthrough.

---

### 4.2 Tool system

**Everyday analogy:** Imagine the robot's toolbox. Inside there's a hammer,
a screwdriver, a measuring tape, and more — each labeled with its name. When
the AI asks "I need the measuring tape," the agent opens the toolbox, grabs the
right tool, uses it, and hands the result back to the AI. The AI never touches
the toolbox directly; it just asks by name.

**Real-world example:** Plugins in IDEs like VS Code are a tool system. The
editor core doesn't know how to format Python — it asks the "Python formatter"
plugin by name. The plugin runs and returns the result.

**What it is:** A tool is a named action the AI model can request (read a file,
run a command, search the web). The agent keeps a `ToolRegistry` — a lookup
table from tool name to tool code. During the agent loop, when the AI returns
a `ToolCall`, the agent finds the matching tool, runs it, and feeds the result
back to the AI.

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

**Everyday analogy:** Think of a school principal deciding which classroom a
question goes to. Simple questions ("what's 2 + 2?") go to the first-grade
room — fast and cheap. Hard questions ("explain black holes") go to the advanced
class — more capable but slower. Model routing is that principal: it reads the
question, scores how hard it seems, and sends it to the right AI model.

**Real-world example:** Cloud computing platforms automatically route small
tasks to cheaper, lower-power machines and big tasks to expensive high-powered
ones. Routing by complexity saves money without sacrificing quality on the tasks
that need it.

**What it is:** Before each AI model call, the router decides whether to send
the request to the main (powerful/expensive) model or a lighter
(fast/cheap) model. The decision is made by measuring structural features of
the message and computing a complexity score.

**Why picoclaw uses it:** AI model API costs grow with model capability — so
that simple questions ("what time is it?") don't use an expensive heavy model.
Without routing, every message, no matter how simple, would cost as much as the
hardest query.

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

All features are counts and lengths — no keyword matching. This makes
routing work the same way in any language.

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
logic can be swapped for an AI-based classifier without changing the routing
infrastructure.

---

### 4.4 Three-layer architecture

**Everyday analogy:** Think of a car rental business. The **car** (AgentInstance)
is fully built and ready — engine, seats, GPS — but parked and not running yet.
The **garage** (AgentRegistry) keeps track of all the cars: which one is the
sporty red one, which is the big van, which key goes to which car. The
**dispatcher** (AgentLoop) is the person at the desk who takes your request,
looks up which car fits best, and hands you the keys so you can go.

**Real-world example:** Web frameworks use the same pattern: route configuration
(what URL goes where) is separate from the request handler logic (what actually
runs), and both are separate from the HTTP server engine that accepts
connections.

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
group membership. Uses `sync.RWMutex` for safe access from multiple goroutines
at once. If no agents are configured, automatically creates an implicit "main"
agent.

**Layer 3 — AgentLoop** (`pkg/agent/loop.go`): The runtime engine. Runs
forever in a goroutine, waiting on `bus.ConsumeInbound()`. When a message
arrives, it calls `processMessage()` which finds the right agent, optionally
runs the model router, then runs the AI iteration cycle. Uses `sync.WaitGroup`
to track in-flight requests for safe shutdown.

**Why this separation matters:** The same `AgentLoop` can serve multiple agents
at the same time (different channels, different bots) — so that swapping the
model or tools for one agent doesn't affect the others. The loop itself knows
nothing about which model or tools are in use — it just calls the interface.

For the full detailed walkthrough of each layer, see `docs/agent-architecture.md`.
