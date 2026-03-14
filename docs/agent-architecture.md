# PicoClaw Agent Architecture

> A complete guide to how the PicoClaw agent is built, how it runs, and what
> operating system resources it consumes at each stage.

---

## Table of Contents

1. [What Is an Agent?](#1-what-is-an-agent)
2. [The Three Layers](#2-the-three-layers)
3. [Layer 1: AgentInstance](#3-layer-1-agentinstance--the-individual-agent)
4. [Layer 2: AgentRegistry](#4-layer-2-agentregistry--the-lookup-table)
5. [Layer 3: AgentLoop](#5-layer-3-agentloop--the-engine)
6. [The Execution Loop Step by Step](#6-the-execution-loop-step-by-step)
7. [The Tool System](#7-the-tool-system)
8. [Model Routing](#8-model-routing--cheap-vs-expensive)
9. [Error Handling and Resilience](#9-error-handling-and-resilience)
10. [Operating System Resources](#10-operating-system-resources)
11. [Concrete Example: End to End](#11-concrete-example-end-to-end)

---

## 1. What Is an Agent?

An agent is a program that sits between a human and an AI model. It does three
things in a loop:

1. Takes a message from the human
2. Sends it to an AI model (LLM) along with a set of **tools** the AI can use
3. If the AI wants to use a tool (read a file, search the web, run a command),
   the agent **executes that tool** and feeds the result back to the AI
4. Repeats steps 2-3 until the AI gives a final text answer
5. Sends that answer back to the human

Think of it like a **human assistant with a phone and a toolbox**:

```
  YOU: "What's the weather in Tokyo?"
   |
   v
  ASSISTANT thinks: "I need to search the web"
   |
   v
  ASSISTANT uses tool: web_search("weather Tokyo")
   |
   v
  ASSISTANT reads result: "Tokyo: 22C, partly cloudy"
   |
   v
  ASSISTANT answers: "It's 22C and partly cloudy in Tokyo right now."
```

The agent is the assistant. The LLM is the assistant's brain. The tools are the
assistant's hands.

---

## 2. The Three Layers

The agent system is composed of three layers, each in its own file:

```
┌─────────────────────────────────────────────────────┐
│                   AgentLoop                         │  pkg/agent/loop.go
│         The engine that runs forever,               │
│    consuming messages and driving the cycle          │
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

| Layer | File | Role |
|-------|------|------|
| **AgentInstance** | `pkg/agent/instance.go` | A single configured "brain": which AI model, what tools, where files live |
| **AgentRegistry** | `pkg/agent/registry.go` | A map of all agents; routes messages to the right one |
| **AgentLoop** | `pkg/agent/loop.go` | The runtime engine: consumes messages, runs the think-act loop |

---

## 3. Layer 1: AgentInstance -- The Individual Agent

**File:** `pkg/agent/instance.go` (lines 22-50)

An `AgentInstance` is a fully configured agent identity. It is a **data
structure**, not a running process. Think of it as a parked car: engine off,
but fully assembled and fueled.

### Structure

```
AgentInstance
 |
 |-- ID / Name              "main"
 |-- Model                  "openai/gpt-4o"
 |-- Fallbacks              ["openai/gpt-4o-mini", "anthropic/claude-3"]
 |-- Workspace              "/home/user/.picoclaw/workspace"
 |
 |-- MaxIterations = 20     How many think->act cycles per message
 |-- MaxTokens     = 8192   Max output length per LLM call
 |-- Temperature   = 0.7    Creativity level (0=deterministic, 1=creative)
 |
 |-- Provider                Connection to the AI service (OpenAI, Anthropic, etc.)
 |-- Sessions                Conversation memory (persisted as JSONL files on disk)
 |-- ContextBuilder          Builds the system prompt + message history
 |-- Tools                   ToolRegistry: what actions this agent can take
 |
 |-- Router                  (Optional) routes simple messages to cheaper models
 |-- LightCandidates         Pre-resolved cheap model for simple messages
```

### How It's Built

`NewAgentInstance()` (lines 52-240) assembles an agent in this order:

```
NewAgentInstance(config, defaults, globalCfg, provider)
     |
     |  1. Resolve workspace directory
     |     os.MkdirAll(workspace)  ──────────────── OS: creates directory on disk
     |
     |  2. Resolve model name from config
     |
     |  3. Register tools (only if enabled):
     |     ├── read_file       read file contents
     |     ├── write_file      create/overwrite files
     |     ├── list_dir        list directory contents
     |     ├── exec            execute shell commands
     |     ├── edit_file       edit file ranges
     |     └── append_file     append to file
     |
     |  4. Create session store
     |     initSessionStore() ───────────────────── OS: creates sessions/ directory
     |     └── NewJSONLStore() opens/creates JSONL files on disk
     |
     |  5. Create ContextBuilder (builds system prompt)
     |
     |  6. Resolve fallback model candidates
     |
     |  7. (Optional) Set up model routing
     |
     └── Return fully initialized AgentInstance
```

### OS Resources Used at Creation

| Resource | Where | What |
|----------|-------|------|
| **Disk directory** | `os.MkdirAll()` line 60 | Creates workspace folder |
| **Disk directory** | `initSessionStore()` line 100 | Creates `sessions/` subfolder |
| **File handles** | `memory.NewJSONLStore()` | Opens/creates metadata files |
| **Memory** | `tools.NewToolRegistry()` | In-memory map of tool instances |

---

## 4. Layer 2: AgentRegistry -- The Lookup Table

**File:** `pkg/agent/registry.go` (lines 13-141)

The registry holds all configured agents and routes incoming messages to the
right one.

```
AgentRegistry
 |
 |-- agents: map[string]*AgentInstance
 |     |
 |     |-- "main"     -> AgentInstance{model: "gpt-4o", ...}
 |     |-- "research"  -> AgentInstance{model: "gpt-3.5", ...}
 |     └── ...
 |
 |-- resolver: RouteResolver
 |     Decides which agent handles a message based on:
 |       - channel (discord, telegram, cli)
 |       - sender account
 |       - guild/team membership
 |
 |-- Methods:
      |-- GetAgent(id)             Look up agent by ID
      |-- ResolveRoute(input)      Route message -> agent
      |-- CanSpawnSubagent(a, b)   Permission check: can A create B?
      |-- GetDefaultAgent()        Returns "main" or first agent
```

If no agents are explicitly configured, the registry creates an implicit
"main" agent automatically (line 31-37):

```go
implicitAgent := &config.AgentConfig{
    ID:      "main",
    Default: true,
}
instance := NewAgentInstance(implicitAgent, &cfg.Agents.Defaults, cfg, provider)
registry.agents["main"] = instance
```

### OS Resources

| Resource | Where | What |
|----------|-------|------|
| **Memory** | `map[string]*AgentInstance` | In-memory registry of all agents |
| **`sync.RWMutex`** | Line 17 | OS-level reader-writer lock for thread-safe access |

---

## 5. Layer 3: AgentLoop -- The Engine

**File:** `pkg/agent/loop.go` (lines 38-54)

This is where everything comes alive. The `AgentLoop` is the runtime engine
that ties together message consumption, routing, and the LLM iteration cycle.

```
AgentLoop
 |
 |-- bus               MessageBus: the inbox/outbox for all messages
 |-- cfg               Global configuration
 |-- registry          AgentRegistry (all agents)
 |-- state             Remembers last active channel
 |-- running           atomic.Bool: is the loop running?
 |
 |-- fallback          FallbackChain: tries backup models on failure
 |-- channelManager    Manages communication channels (Discord, Telegram, CLI)
 |-- mediaStore        Handles images, audio, file attachments
 |-- transcriber       Converts voice messages to text
 |-- cmdRegistry       Built-in commands (/help, /model)
 |-- mcp              MCP runtime for external tool servers
 |
 |-- mu                sync.RWMutex for thread-safe config/registry swaps
 |-- activeRequests    sync.WaitGroup: tracks in-flight LLM calls
```

### How It's Built

`NewAgentLoop()` (lines 79-111):

```
NewAgentLoop(cfg, msgBus, provider)
     |
     |  1. Create AgentRegistry (instantiates all agents)
     |
     |  2. Register shared tools across all agents:
     |     ├── web            web search (Brave, Tavily, DuckDuckGo, etc.)
     |     ├── web_fetch      fetch and parse URLs
     |     ├── i2c            I2C hardware interface
     |     ├── spi            SPI hardware interface
     |     ├── message        send messages to users/channels
     |     ├── send_file      send files to users
     |     ├── find_skills    search for installable skills
     |     ├── install_skill  install a skill from registry
     |     └── spawn          create subagent background tasks
     |
     |  3. Create FallbackChain (for provider failover)
     |
     |  4. Create state manager
     |
     |  5. Build command registry (/help, /model, etc.)
     |
     └── Return AgentLoop
```

### OS Resources

| Resource | Where | What |
|----------|-------|------|
| **`sync.RWMutex`** | Line 51 | Protects concurrent config/registry reads/writes |
| **`sync.WaitGroup`** | Line 53 | Tracks in-flight LLM requests for safe shutdown |
| **`atomic.Bool`** | Line 43 | Lock-free boolean for loop running state |
| **`sync.Map`** | Line 44 | Concurrent map tracking active summarization jobs |
| **HTTP clients** | Shared tools | Network sockets for web search, LLM API calls |

---

## 6. The Execution Loop Step by Step

This is the heart of the system. Here is the complete journey of a message
from arrival to response.

### 6.1 The Outer Loop: `Run()`

**File:** `pkg/agent/loop.go` line 243

```
AgentLoop.Run(ctx)
 |
 |  running = true
 |  Initialize MCP tools if configured
 |
 |  FOREVER (while running):
 |   |
 |   |  msg = bus.ConsumeInbound(ctx)   <-- BLOCKS here
 |   |                                      (goroutine sleeps until
 |   |                                       a message arrives)
 |   |
 |   |  response, err = processMessage(ctx, msg)
 |   |
 |   |  if response != "" AND message tool didn't already reply:
 |   |     bus.PublishOutbound(response)
 |   |
 |   └── loop back
```

The outer loop is an **infinite loop** that processes one message at a time,
sequentially. The `ConsumeInbound()` call blocks the goroutine (no CPU burned)
until a message appears in the bus.

#### OS Resources

| Resource | When | What |
|----------|------|------|
| **Goroutine** | Entire lifetime | The loop runs in a single goroutine |
| **Channel blocking** | `ConsumeInbound()` | Go runtime parks the goroutine (zero CPU while waiting) |

---

### 6.2 Message Processing: `processMessage()`

**File:** `pkg/agent/loop.go` line 675

```
processMessage(ctx, msg)
 |
 |  1. TRANSCRIBE AUDIO (if voice message)
 |     ├── Resolve media refs from MediaStore ────── OS: file read
 |     ├── Call transcription API ─────────────────── OS: HTTP request
 |     └── Replace [voice] annotations with text
 |
 |  2. ROUTE SYSTEM MESSAGES
 |     If msg.Channel == "system":
 |       processSystemMessage() and return
 |
 |  3. RESOLVE ROUTE
 |     registry.ResolveRoute(channel, sender, guild...)
 |       -> determines which AgentInstance handles this
 |
 |  4. RESET MESSAGE TOOL state (prevents duplicate sends)
 |
 |  5. CHECK FOR COMMANDS
 |     Is this /help or /model?
 |       -> handle directly and return
 |
 |  6. CALL runAgentLoop()
 |     The real AI processing begins here
```

---

### 6.3 The Core Pipeline: `runAgentLoop()`

**File:** `pkg/agent/loop.go` line 848

```
runAgentLoop(ctx, agent, opts)
 |
 |  Step 0: RECORD LAST CHANNEL
 |     state.SetLastChannel("discord:12345") ──────── OS: atomic file write
 |
 |  Step 1: BUILD MESSAGES
 |     |  history = agent.Sessions.GetHistory(key) ── OS: read JSONL from disk
 |     |  summary = agent.Sessions.GetSummary(key) ── OS: read summary file
 |     |  messages = ContextBuilder.BuildMessages(
 |     |      history, summary, userMessage,
 |     |      media, channel, chatID
 |     |  )
 |     └── Result: array of messages ready for the LLM
 |
 |  Step 2: RESOLVE MEDIA REFS
 |     Convert media:// URIs to base64 data URLs ──── OS: read image files
 |
 |  Step 3: SAVE USER MESSAGE
 |     agent.Sessions.AddMessage("user", msg) ──────── OS: append to JSONL file
 |                                                         + fsync
 |
 |  Step 4: RUN LLM ITERATION LOOP    <--- The main loop (see 6.4 below)
 |     finalContent, iterations, err = runLLMIteration(...)
 |
 |  Step 5: HANDLE EMPTY RESPONSE
 |     if finalContent == "": use default message
 |
 |  Step 6: SAVE ASSISTANT MESSAGE
 |     agent.Sessions.AddMessage("assistant", answer) ── OS: append JSONL + fsync
 |     agent.Sessions.Save(key) ──────────────────────── OS: compact JSONL file
 |
 |  Step 7: MAYBE SUMMARIZE
 |     if history too long:
 |       go summarize(agent, sessionKey) ───────────── OS: spawns goroutine
 |       └── calls LLM to summarize ────────────────── OS: HTTP request
 |       └── saves summary to disk ─────────────────── OS: file write
 |
 |  Step 8: RETURN RESPONSE
```

---

### 6.4 The Think-Act-Repeat Cycle: `runLLMIteration()`

**File:** `pkg/agent/loop.go` line 993

This is the **most important function in the entire system**. It implements
the agentic loop where the AI thinks, acts, observes, and repeats.

```
runLLMIteration(ctx, agent, messages, opts)
 |
 |  Select model tier (cheap vs expensive)
 |  Decision is STICKY for this entire turn
 |
 |  FOR iteration = 1 to MaxIterations (default 20):
 |   |
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  1. BUILD TOOL DEFINITIONS                                  │
 |   |  │     agent.Tools.ToProviderDefs() ──── OS: mutex lock/unlock │
 |   |  │     Convert tool registry to JSON schema format             │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  2. CALL THE LLM                                            │
 |   |  │     Send: [system prompt + history + tools]                 │
 |   |  │                                                             │
 |   |  │     activeRequests.Add(1) ──────── OS: WaitGroup counter    │
 |   |  │                                                             │
 |   |  │     If multiple candidates:                                 │
 |   |  │       fallback.Execute() tries each model                   │
 |   |  │     Else:                                                   │
 |   |  │       provider.Chat() ──────────── OS: HTTP POST to LLM API│
 |   |  │                                         (network socket,    │
 |   |  │                                          TLS handshake,     │
 |   |  │                                          120s timeout)      │
 |   |  │                                                             │
 |   |  │     On timeout: retry with backoff (5s, 10s)                │
 |   |  │     On context overflow: compress history & retry           │
 |   |  │                                                             │
 |   |  │     activeRequests.Done() ──────── OS: WaitGroup counter    │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  3. HANDLE REASONING (optional)                             │
 |   |  │     go handleReasoning() ──────── OS: spawns goroutine      │
 |   |  │     └── PublishOutbound() ──────── OS: channel send         │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  4. CHECK: Did the LLM request tool calls?                 │
 |   |  │                                                             │
 |   |  │     NO tool calls ──> finalContent = response.Content       │
 |   |  │                       BREAK out of loop                     │
 |   |  │                                                             │
 |   |  │     YES tool calls ──> continue to step 5...                │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v  (only if tool calls)
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  5. SAVE ASSISTANT MESSAGE + TOOL CALLS                    │
 |   |  │     Sessions.AddFullMessage() ──── OS: append JSONL + fsync │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  6. EXECUTE TOOL CALLS IN PARALLEL                         │
 |   |  │                                                             │
 |   |  │     var wg sync.WaitGroup ──────── OS: WaitGroup            │
 |   |  │                                                             │
 |   |  │     for each tool call:                                     │
 |   |  │       wg.Add(1)                                             │
 |   |  │       go func() { ──────────────── OS: spawns goroutine     │
 |   |  │         result = agent.Tools.ExecuteWithContext(             │
 |   |  │           toolName, arguments,                              │
 |   |  │           channel, chatID,                                  │
 |   |  │           asyncCallback,                                    │
 |   |  │         )                                                   │
 |   |  │         // See "Tool Execution" below for OS resources      │
 |   |  │         wg.Done()                                           │
 |   |  │       }()                                                   │
 |   |  │                                                             │
 |   |  │     wg.Wait() ──────────────────── OS: blocks until all     │
 |   |  │                                        goroutines finish    │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  7. COLLECT RESULTS                                        │
 |   |  │     for each result (in original order):                    │
 |   |  │       - Send ForUser content to human ── OS: channel send   │
 |   |  │       - Send media to human ──────────── OS: channel send   │
 |   |  │       - Package as "tool" message for LLM                   │
 |   |  │       - Save to session ──────────────── OS: JSONL + fsync  │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   |                          v
 |   |  ┌─────────────────────────────────────────────────────────────┐
 |   |  │  8. TICK TTL                                                │
 |   |  │     agent.Tools.TickTTL() ──────── OS: mutex lock/unlock    │
 |   |  │     Discovered tools lose 1 TTL point                       │
 |   |  │     (if TTL reaches 0, tool disappears)                     │
 |   |  └─────────────────────────────────────────────────────────────┘
 |   |                          |
 |   └──────────────── LOOP BACK to step 1
 |                     (messages now include tool results)
 |
 └── RETURN finalContent
```

---

## 7. The Tool System

### 7.1 The Tool Interface

**File:** `pkg/tools/base.go` (lines 6-11)

Every tool implements this interface:

```
  Tool interface
   |
   |-- Name()         -> "read_file"
   |-- Description()  -> "Read contents of a file from disk"
   |-- Parameters()   -> JSON Schema describing arguments
   |-- Execute(ctx, args) -> ToolResult
```

A `ToolResult` contains:

```
  ToolResult
   |
   |-- ForLLM    string   Text the AI sees (e.g., file contents)
   |-- ForUser   string   Text sent directly to the human
   |-- IsError   bool     Whether execution failed
   |-- Media     []string Media file references produced
   |-- Silent    bool     Suppress user-facing output
   |-- Async     bool     This is a background task
   |-- Err       error    The actual error object
```

### 7.2 The Tool Registry

**File:** `pkg/tools/registry.go`

The `ToolRegistry` holds all tools for an agent and manages their lifecycle.
It has two categories of tools:

```
ToolRegistry
 |
 |-- Core Tools (IsCore: true, always callable)
 |    Always visible to the LLM in every iteration
 |    Registered via Register()
 |
 |-- Hidden Tools (IsCore: false, TTL-controlled)
 |    Come from MCP servers (external tool providers)
 |    Invisible by default
 |    Become callable only when "promoted" with a TTL
 |    Expire after N iterations without re-promotion
 |    Registered via RegisterHidden()
```

#### Tool Discovery Flow

```
  Iteration 1:
    LLM sees: [read_file, write_file, exec, web, tool_search_bm25]
    LLM calls: tool_search_bm25("database query")

    Agent searches hidden tools, finds: "sql_query" (from MCP)
    Agent calls: PromoteTools(["sql_query"], ttl=3)

  Iteration 2:
    LLM sees: [read_file, write_file, exec, web, tool_search_bm25, sql_query]
                                                                     ^^^^^^
                                                                   now visible!
    LLM calls: sql_query("SELECT * FROM users")
    Agent executes sql_query, returns results
    TickTTL() -> sql_query.TTL = 2

  Iteration 3:
    LLM sees: [..., sql_query]  (TTL=2, still visible)
    LLM gives final answer, no tools
    BREAK

  (If loop continued, sql_query would disappear after 2 more iterations)
```

### 7.3 Complete Tool Catalog

```
┌────────────────────────────────────────────────────────────────────┐
│                    CORE TOOLS (always available)                    │
├─────────────┬──────────────────────────────────────────────────────┤
│ File I/O    │                                                      │
│  read_file  │ Read file contents (workspace-restricted)            │
│  write_file │ Write/create files                                   │
│  edit_file  │ Edit specific line ranges in a file                  │
│  append_file│ Append content to end of file                        │
│  list_dir   │ List directory contents                              │
├─────────────┼──────────────────────────────────────────────────────┤
│ Execution   │                                                      │
│  exec       │ Execute shell commands (sh -c on Unix)               │
├─────────────┼──────────────────────────────────────────────────────┤
│ Network     │                                                      │
│  web        │ Web search (Brave, Tavily, DuckDuckGo, Perplexity,  │
│             │  SearXNG, GLMSearch)                                  │
│  web_fetch  │ Fetch and parse web URLs                              │
├─────────────┼──────────────────────────────────────────────────────┤
│ Communication│                                                     │
│  message    │ Send messages to other channels/users                │
│  send_file  │ Send files to users                                  │
├─────────────┼──────────────────────────────────────────────────────┤
│ Hardware    │                                                      │
│  i2c        │ I2C bus communication (Linux only)                   │
│  spi        │ SPI bus communication (Linux only)                   │
├─────────────┼──────────────────────────────────────────────────────┤
│ Agent Mgmt  │                                                      │
│  spawn      │ Create background subagent tasks                     │
│  find_skills│ Search for installable skills                        │
│  install_   │ Install a skill from registry                        │
│  skill      │                                                      │
├─────────────┼──────────────────────────────────────────────────────┤
│ Discovery   │                                                      │
│  tool_search│ Search hidden tools by name/description (BM25)       │
│  _bm25      │                                                      │
│  tool_search│ Search hidden tools by regex pattern                 │
│  _regex     │                                                      │
├─────────────┴──────────────────────────────────────────────────────┤
│                   HIDDEN TOOLS (TTL-controlled)                     │
├────────────────────────────────────────────────────────────────────┤
│  Any tool from MCP servers. Invisible until promoted via search.   │
│  Examples: sql_query, github_pr, jira_ticket, etc.                 │
└────────────────────────────────────────────────────────────────────┘
```

### 7.4 Tool Execution and OS Resources

Each tool type consumes different OS resources:

```
Tool: read_file
  OS: os.ReadFile() -> file descriptor, disk I/O
  OS: Workspace path restriction check

Tool: write_file / edit_file / append_file
  OS: os.OpenFile() -> file descriptor
  OS: f.Write() -> disk I/O
  OS: f.Sync() -> fsync (force to disk)

Tool: exec
  OS: exec.CommandContext("sh", "-c", command)
       |
       |-- Creates child process (fork+exec)
       |-- Sets process group (syscall.SysProcAttr{Setpgid: true})
       |-- Captures stdout/stderr via bytes.Buffer
       |-- Goroutine for cmd.Wait()
       |-- Timeout: context.WithTimeout (60s default)
       |-- On timeout: terminateProcessTree()
       |     └── syscall.Kill(-pid, SIGKILL)  (kills entire process group)

Tool: web / web_fetch
  OS: http.Client with timeouts:
       |-- Search: 10s timeout
       |-- Perplexity: 30s timeout
       |-- Fetch: 60s timeout
       |-- TLS handshake, TCP socket
  OS: atomic.AddUint32() for round-robin API key rotation

Tool: i2c (Linux only)
  OS: syscall.Open("/dev/i2c-N", O_RDWR)
  OS: syscall.Syscall(SYS_IOCTL, ...) for:
       |-- i2cFuncs  (0x0705): query capabilities
       |-- i2cSlave  (0x0703): set slave address
       |-- i2cSmbus  (0x0720): SMBus transactions
  OS: syscall.Read() / syscall.Write() for data transfer
  OS: syscall.Close(fd)

Tool: spi (Linux only)
  OS: syscall.Open("/dev/spidevN.M", O_RDWR)
  OS: syscall.Syscall(SYS_IOCTL, ...) for:
       |-- spiIocWrMode        (0x40016B01): set mode
       |-- spiIocWrBitsPerWord (0x40016B03): set word size
       |-- spiIocWrMaxSpeedHz  (0x40046B04): set clock speed
       |-- spiIocMessage1      (0x40206B00): full-duplex transfer
  OS: runtime.KeepAlive() prevents GC during syscall
  OS: syscall.Close(fd)

Tool: spawn (subagent)
  OS: go sm.runTask() -> spawns goroutine for background work
  OS: sync.RWMutex for task map protection
  OS: HTTP request to LLM API (subagent gets its own LLM calls)
```

---

## 8. Model Routing -- Cheap vs Expensive

**File:** `pkg/agent/loop.go` line 1412

If configured, the agent scores each message for complexity and routes simple
messages to a cheaper/faster model.

```
Incoming message: "Hello!"
     |
     v
  Router.SelectModel("Hello!", history, primaryModel)
     |
     |  score = 0.15  (low complexity)
     |  threshold = 0.5
     |  0.15 < 0.5 -> USE LIGHT MODEL
     |
     v
  activeCandidates = LightCandidates  (e.g., gpt-4o-mini)
  activeModel = "openai/gpt-4o-mini"

-----

Incoming message: "Analyze this codebase and refactor the auth module"
     |
     v
  Router.SelectModel("Analyze this...", history, primaryModel)
     |
     |  score = 0.82  (high complexity)
     |  threshold = 0.5
     |  0.82 >= 0.5 -> USE PRIMARY MODEL
     |
     v
  activeCandidates = Candidates  (e.g., gpt-4o)
  activeModel = "openai/gpt-4o"
```

The decision is **sticky per turn**: once chosen, all tool-follow-up iterations
use the same model tier. This prevents switching models mid-conversation.

---

## 9. Error Handling and Resilience

The iteration loop has built-in resilience at multiple levels:

```
┌──────────────────────────────────────────────────────┐
│  RESILIENCE LAYER 1: Timeout Retry                   │
│                                                      │
│  LLM API call times out?                             │
│    -> Wait 5 seconds, retry                          │
│    -> Wait 10 seconds, retry                         │
│    -> After 3 attempts: fail                         │
│                                                      │
│  OS: time.Sleep() for backoff                        │
├──────────────────────────────────────────────────────┤
│  RESILIENCE LAYER 2: Context Window Overflow         │
│                                                      │
│  Conversation too long for model?                    │
│    -> Notify user: "Compressing history..."          │
│    -> forceCompression(): summarize old messages     │
│    -> Rebuild message array with summary             │
│    -> Retry LLM call                                 │
│                                                      │
│  OS: HTTP request for summarization LLM call         │
│  OS: File write for compressed session               │
├──────────────────────────────────────────────────────┤
│  RESILIENCE LAYER 3: Model Fallback                  │
│                                                      │
│  Primary model fails (rate limit, outage)?           │
│    -> Try fallback model 1                           │
│    -> Try fallback model 2                           │
│    -> ...until one succeeds or all fail              │
│                                                      │
│  OS: HTTP request to different API endpoint           │
│  OS: CooldownTracker prevents retrying failed models │
├──────────────────────────────────────────────────────┤
│  RESILIENCE LAYER 4: Iteration Cap                   │
│                                                      │
│  MaxIterations (default 20) prevents infinite loops   │
│  If reached: return whatever content was last seen    │
└──────────────────────────────────────────────────────┘
```

---

## 10. Operating System Resources

### 10.1 Complete Resource Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                    OPERATING SYSTEM RESOURCE MAP                      │
├───────────────┬──────────────────────────────────────────────────────┤
│               │                                                      │
│  GOROUTINES   │  1. Main loop (AgentLoop.Run)              always   │
│  (threads of  │  2. Per tool call (parallel execution)     per msg  │
│   execution)  │  3. Async tool completion callbacks        per tool  │
│               │  4. Background summarization               per sess │
│               │  5. Reasoning output publishing            per iter  │
│               │  6. exec tool: process wait goroutine      per exec │
│               │  7. Subagent background tasks              per spawn│
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  FILE         │  Session JSONL files:                                │
│  DESCRIPTORS  │    - Read: history load (GetHistory)                 │
│               │    - Write: message append (AddMessage)              │
│               │    - Fsync: durability guarantee after each write    │
│               │  Workspace files:                                    │
│               │    - read_file, write_file, edit_file tools          │
│               │  State files:                                        │
│               │    - Atomic write (temp -> fsync -> rename)          │
│               │  Device files:                                       │
│               │    - /dev/i2c-N (I2C bus)                            │
│               │    - /dev/spidevN.M (SPI bus)                        │
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  NETWORK      │  LLM API calls:                                      │
│  SOCKETS      │    - HTTP POST to OpenAI/Anthropic/etc.              │
│               │    - TLS 1.2/1.3 handshake                           │
│               │    - Default timeout: 120 seconds                    │
│               │  Web search:                                         │
│               │    - HTTP GET to Brave/Tavily/DuckDuckGo             │
│               │    - Timeout: 10-30 seconds                          │
│               │  Web fetch:                                          │
│               │    - HTTP GET to arbitrary URLs                      │
│               │    - Timeout: 60 seconds                             │
│               │  MCP servers:                                        │
│               │    - HTTP to external tool servers                   │
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  CHILD        │  exec tool:                                          │
│  PROCESSES    │    - sh -c "command" (Unix)                          │
│               │    - powershell -Command "..." (Windows)             │
│               │    - Process group isolation (Setpgid)               │
│               │    - SIGKILL tree termination on timeout             │
│               │  MCP servers:                                        │
│               │    - exec.CommandContext(cfg.Command, cfg.Args...)   │
│               │  CLI providers:                                      │
│               │    - claude CLI, codex CLI subprocesses              │
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  SYNCHRONI-   │  sync.RWMutex:                                       │
│  ZATION       │    - AgentLoop.mu (config/registry swap)             │
│  PRIMITIVES   │    - AgentRegistry.mu (agent map access)             │
│               │    - ToolRegistry.mu (tool map access)               │
│               │    - SubagentManager.mu (task map access)            │
│               │  sync.WaitGroup:                                     │
│               │    - Parallel tool execution (per iteration)         │
│               │    - Active LLM request tracking (for shutdown)      │
│               │  sync.Map:                                           │
│               │    - Summarization deduplication                     │
│               │  atomic.Bool:                                        │
│               │    - AgentLoop.running                               │
│               │  atomic.Uint32:                                      │
│               │    - API key round-robin counter                     │
│               │  atomic.Uint64:                                      │
│               │    - ToolRegistry.version (cache invalidation)       │
│               │  Sharded Mutex Pool (64 shards):                     │
│               │    - JSONL store per-session locking (FNV hash)      │
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  MEMORY       │  In-memory maps:                                     │
│               │    - AgentRegistry.agents (agent instances)           │
│               │    - ToolRegistry.tools (tool entries)               │
│               │    - SubagentManager.tasks (background tasks)        │
│               │  Buffers:                                            │
│               │    - JSONL scanner: 64KB initial, 10MB max           │
│               │    - Shell stdout/stderr: bytes.Buffer               │
│               │  Caches:                                             │
│               │    - ContextBuilder system prompt cache              │
│               │    - Skills search result cache                      │
│               │    - BM25 hidden tool snapshot cache                 │
│               │                                                      │
├───────────────┼──────────────────────────────────────────────────────┤
│               │                                                      │
│  SYSCALLS     │  ioctl (I2C):                                        │
│  (hardware)   │    - I2C_SLAVE (0x0703): set device address          │
│               │    - I2C_FUNCS (0x0705): query capabilities          │
│               │    - I2C_SMBUS (0x0720): SMBus transactions          │
│               │  ioctl (SPI):                                        │
│               │    - SPI_IOC_WR_MODE (0x40016B01)                    │
│               │    - SPI_IOC_WR_BITS_PER_WORD (0x40016B03)           │
│               │    - SPI_IOC_WR_MAX_SPEED_HZ (0x40046B04)           │
│               │    - SPI_IOC_MESSAGE(1) (0x40206B00)                 │
│               │  Process management:                                 │
│               │    - Setpgid: create process group                   │
│               │    - Kill(-pid, SIGKILL): kill process tree          │
│               │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

### 10.2 Resource Lifecycle per Message

This diagram shows how OS resources are allocated and released during the
processing of a single user message:

```
TIME ──────────────────────────────────────────────────────────────►

Message arrives
 |
 |  [File Read] Load session history from JSONL ──────── released
 |  [File Read] Load session summary ─────────────────── released
 |
 |  [File Write] Save user message to JSONL + fsync ──── released
 |
 |  ┌── Iteration 1 ──────────────────────────────────────────┐
 |  │                                                          │
 |  │  [Mutex] Lock tool registry, build definitions, unlock   │
 |  │                                                          │
 |  │  [HTTP] ═══ LLM API call ═══════════════════════════     │
 |  │         TCP connect -> TLS -> POST -> wait -> response   │
 |  │         (up to 120 seconds)                              │
 |  │                                                          │
 |  │  [Goroutine] Reasoning output (fire and forget)          │
 |  │                                                          │
 |  │  [File Write] Save assistant message + fsync             │
 |  │                                                          │
 |  │  Tool execution (parallel):                              │
 |  │  [Goroutine 1] ─── read_file ────── [File Read] ──done  │
 |  │  [Goroutine 2] ─── web_search ──── [HTTP 10s] ────done  │
 |  │  [WaitGroup] ══════ wait for all ══════════════════      │
 |  │                                                          │
 |  │  [File Write] Save tool results + fsync                  │
 |  │  [Mutex] TickTTL on tool registry                        │
 |  │                                                          │
 |  └──────────────────────────────────────────────────────────┘
 |
 |  ┌── Iteration 2 ──────────────────────────────────────────┐
 |  │                                                          │
 |  │  [HTTP] ═══ LLM API call (with tool results) ═══════    │
 |  │                                                          │
 |  │  No tool calls -> final answer                           │
 |  │  BREAK                                                   │
 |  └──────────────────────────────────────────────────────────┘
 |
 |  [File Write] Save final assistant message + fsync
 |  [File Write] Compact JSONL session file
 |
 |  [Goroutine] Maybe background summarization
 |     └── [HTTP] LLM call for summary
 |     └── [File Write] Save summary
 |
 └── Response sent back to user
```

### 10.3 Concurrency Model

```
Main Goroutine (AgentLoop.Run)
 |
 |  Processes ONE message at a time (sequential)
 |
 |  Per message, spawns:
 |   |
 |   |── N goroutines for parallel tool execution
 |   |   (N = number of tool calls the LLM made)
 |   |   All joined via WaitGroup before next iteration
 |   |
 |   |── 1 goroutine for reasoning output (fire-and-forget)
 |   |
 |   |── 0-1 goroutine for background summarization
 |   |   (if session history exceeds threshold)
 |   |
 |   └── 0-N goroutines for async tool completions
 |       (subagent results arrive later via message bus)

Thread Safety Guarantees:
 - AgentLoop.mu (RWMutex): protects config/registry swaps
 - AgentRegistry.mu (RWMutex): protects agent map
 - ToolRegistry.mu (RWMutex): protects tool map
 - JSONL Store: 64-shard mutex pool (FNV hash per session key)
 - Tool execution: context.Value carries immutable channel/chatID
   (no mutable state on shared tool instances)
```

---

## 11. Concrete Example: End to End

Here is a complete example of what happens when a user sends a message through
Discord asking: **"Read my config.json and tell me what port the server uses"**

```
═══════════════════════════════════════════════════════════════
 STEP 1: Message enters the system
═══════════════════════════════════════════════════════════════

Discord channel adapter receives the message.
Publishes to MessageBus inbound channel:

  InboundMessage{
    Channel:  "discord",
    SenderID: "user123",
    ChatID:   "general",
    Content:  "Read my config.json and tell me what port the server uses",
  }

OS: Go channel send (in-memory, no syscall)


═══════════════════════════════════════════════════════════════
 STEP 2: AgentLoop.Run() consumes the message
═══════════════════════════════════════════════════════════════

bus.ConsumeInbound(ctx) unblocks, returns the message.

OS: Go channel receive (goroutine wakes up)


═══════════════════════════════════════════════════════════════
 STEP 3: processMessage() routes it
═══════════════════════════════════════════════════════════════

 - No audio -> skip transcription
 - Channel is "discord", not "system" -> normal path
 - ResolveRoute() -> agent "main"
 - Not a command (/help, /model) -> proceed to runAgentLoop

OS: RWMutex lock/unlock on registry (nanoseconds)


═══════════════════════════════════════════════════════════════
 STEP 4: runAgentLoop() builds context
═══════════════════════════════════════════════════════════════

 - Load history from sessions/discord-general.jsonl

OS: os.Open() -> bufio.Scanner reads file -> os.Close()
    64KB buffer, scanning line by line

 - Build messages array:
   [0] system: "You are PicoClaw, a personal AI agent..."
   [1] user: "What was the weather?" (from history)
   [2] assistant: "It's sunny." (from history)
   [3] user: "Read my config.json and tell me what port..."

 - Save user message to session

OS: os.OpenFile(O_APPEND) -> Write JSON line -> f.Sync() -> Close()
    fsync ensures data hits disk before returning


═══════════════════════════════════════════════════════════════
 STEP 5: runLLMIteration() - Iteration 1
═══════════════════════════════════════════════════════════════

 - Select model: Router scores message complexity = 0.6
   Threshold = 0.5 -> USE PRIMARY MODEL (gpt-4o)

 - Build tool definitions from ToolRegistry

OS: RWMutex read-lock, iterate sorted tool map, unlock

 - Call LLM API:
   POST https://api.openai.com/v1/chat/completions
   Body: {messages: [...], tools: [...], model: "gpt-4o"}

OS: DNS resolution -> TCP connect -> TLS handshake -> HTTP POST
    Socket held open for ~2-5 seconds waiting for response

 - LLM responds:
   {
     content: "",
     tool_calls: [{
       id: "call_abc123",
       name: "read_file",
       arguments: {"path": "config.json"}
     }]
   }

 - Save assistant message with tool call to session

OS: JSONL append + fsync

 - Execute read_file("config.json") in goroutine:

OS: go func() spawns goroutine
    os.ReadFile("config.json") -> reads file contents
    Returns: '{"port": 8080, "host": "0.0.0.0"}'

 - WaitGroup.Wait() (instant, only 1 tool)

 - Package result as tool message, save to session

OS: JSONL append + fsync

 - TickTTL on registry

OS: Mutex lock/unlock


═══════════════════════════════════════════════════════════════
 STEP 6: runLLMIteration() - Iteration 2
═══════════════════════════════════════════════════════════════

 - Messages now include tool result:
   [...previous messages...,
    assistant: {tool_calls: [{read_file, "config.json"}]},
    tool: '{"port": 8080, "host": "0.0.0.0"}']

 - Call LLM API again:

OS: HTTP POST (reuses connection via HTTP keep-alive)

 - LLM responds:
   {
     content: "Your server is configured to use port 8080.",
     tool_calls: []     <-- no more tools!
   }

 - No tool calls -> BREAK out of iteration loop


═══════════════════════════════════════════════════════════════
 STEP 7: Finalize
═══════════════════════════════════════════════════════════════

 - Save final assistant message to session

OS: JSONL append + fsync

 - Compact session file (remove redundant entries)

OS: Read full file -> write compacted version -> atomic rename

 - Check summarization threshold (20 messages or 75% tokens)
   History has 6 messages -> no summarization needed

 - Return "Your server is configured to use port 8080."


═══════════════════════════════════════════════════════════════
 STEP 8: Response sent
═══════════════════════════════════════════════════════════════

 - bus.PublishOutbound() sends to Discord adapter
 - Discord adapter calls Discord API to post the reply

OS: Go channel send (in-memory)
    Discord adapter: HTTP POST to Discord API


═══════════════════════════════════════════════════════════════
 RESOURCE SUMMARY FOR THIS MESSAGE
═══════════════════════════════════════════════════════════════

 Goroutines spawned:     2  (1 tool execution + 1 reasoning)
 File reads:             2  (session history + config.json)
 File writes:            4  (user msg + assistant+tool + tool result + final)
 Fsyncs:                 4  (one per write for durability)
 HTTP requests:          2  (two LLM API calls)
 TCP connections:        1  (reused via keep-alive)
 Mutex operations:      ~8  (registry, tool registry, session locks)
 Child processes:        0  (no exec tool used)
 Total wall time:       ~5s (dominated by LLM API latency)
```

---

## 12. Subagent Concurrency: Multiple Instances of the Same Agent

### Can You Spawn Multiple Instances?

**Yes.** The `SubagentManager.Spawn()` creates a new goroutine per call with no
deduplication and no concurrency cap. The LLM can call `spawn` N times and get
N independent, concurrent task goroutines — all of the same agent type.

### How It Works

```
Agent "main" (iteration 3) calls spawn 3 times in parallel:

  ┌─────────────────────────────────────────────────────────────────┐
  │ Main Agent Loop (goroutine 0)                                   │
  │                                                                 │
  │  LLM response: 3 tool_calls, all "spawn"                       │
  │                                                                 │
  │  WaitGroup.Add(3)                                               │
  │  ├── go execute(spawn, {task: "search auth docs"})              │
  │  ├── go execute(spawn, {task: "search logging docs"})           │
  │  └── go execute(spawn, {task: "search caching docs"})           │
  │  WaitGroup.Wait()                                               │
  └─────────────────────────────────────────────────────────────────┘
        |               |               |
        v               v               v
  ┌───────────┐   ┌───────────┐   ┌───────────┐
  │ subagent-1│   │ subagent-2│   │ subagent-3│
  │ goroutine │   │ goroutine │   │ goroutine │
  │           │   │           │   │           │
  │ RunTool   │   │ RunTool   │   │ RunTool   │
  │  Loop()   │   │  Loop()   │   │  Loop()   │
  │           │   │           │   │           │
  │ Own msgs  │   │ Own msgs  │   │ Own msgs  │
  │ Own iters │   │ Own iters │   │ Own iters │
  │ (max 10)  │   │ (max 10)  │   │ (max 10)  │
  └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
        |               |               |
     SHARED          SHARED          SHARED
        |               |               |
  ┌─────┴───────────────┴───────────────┴─────┐
  │  LLM Provider (HTTP client, connection    │
  │  pool, API key rotation)                  │
  │                                           │
  │  ToolRegistry (read-only, RWMutex)        │
  │                                           │
  │  Workspace directory                      │
  └───────────────────────────────────────────┘
```

### What Each Subagent Instance Gets

Each spawned subagent is **not** a full `AgentInstance`. It is a lightweight
`RunToolLoop()` call (pkg/tools/subagent.go:163) with:

```
┌──────────────────────────────────────────────────────────┐
│                    Per Subagent (unique)                   │
├──────────────────────────────────────────────────────────┤
│  Own goroutine                                           │
│  Own []Message array  (system prompt + task description)  │
│  Own iteration counter (up to maxIterations, default 10)  │
│  Own context.Context   (independently cancellable)        │
│  Own SubagentTask entry (ID, status, result)              │
├──────────────────────────────────────────────────────────┤
│                  Shared (read-only / thread-safe)         │
├──────────────────────────────────────────────────────────┤
│  LLM Provider   (http.Client with connection pooling)    │
│  ToolRegistry   (protected by sync.RWMutex)              │
│  Model name     (string, immutable)                      │
│  Workspace path (string, immutable)                      │
│  LLM options    (maxTokens, temperature — copied once)   │
└──────────────────────────────────────────────────────────┘
```

### OS Resources per Concurrent Subagent

```
1 subagent = 1 goroutine (~8KB stack)
           + 1-10 HTTP requests per iteration (LLM API)
           + 0-N child goroutines (parallel tool calls within subagent)
           + 0-N file descriptors (if subagent reads/writes files)
           + 0-N child processes (if subagent uses exec tool)
           + ~50-200KB memory (message array + buffers)

5 concurrent subagents ≈
   5 goroutines + 5-50 HTTP requests + ~500KB-1MB memory
```

### Synchronous vs Asynchronous Subagents

There are **two** subagent tools:

```
┌──────────────────────────────────────────────────────────────┐
│  "spawn" tool (SpawnTool)         ASYNC                      │
│  ──────────────────────────────────────────                   │
│  - Returns immediately with "Spawned subagent..."            │
│  - Task runs in background goroutine                         │
│  - Result delivered via AsyncCallback to message bus          │
│  - Parent agent continues to next iteration without waiting   │
│                                                              │
│  Use case: "Go research X while I work on Y"                │
├──────────────────────────────────────────────────────────────┤
│  "subagent" tool (SubagentTool)   SYNC                       │
│  ──────────────────────────────────────────                   │
│  - Blocks until task completes                               │
│  - Result returned directly in ToolResult                    │
│  - Parent agent waits (goroutine blocked on RunToolLoop)     │
│                                                              │
│  Use case: "Delegate this subtask and use its result"        │
└──────────────────────────────────────────────────────────────┘
```

When the LLM requests multiple `spawn` calls in a single iteration, they all
execute in **parallel goroutines** (via the WaitGroup in loop.go:1261), each
spawning its own background task. The spawn tool returns `Async: true`, so the
main loop doesn't block — it collects the "spawned" confirmation and moves on.

### Permission Model

```
CanSpawnSubagent(parentAgentID, targetAgentID)

  Config:
    agents:
      list:
        - id: main
          subagents:
            allow_agents: ["research", "code-review"]  # whitelist
        - id: research
          subagents:
            allow_agents: ["*"]                         # allow all

  "main" -> spawn(agent_id: "research")     ✓ allowed
  "main" -> spawn(agent_id: "code-review")  ✓ allowed
  "main" -> spawn(agent_id: "deploy")       ✗ blocked
  "research" -> spawn(agent_id: "anything") ✓ wildcard
```

The permission gate controls **which agent types** can be targeted. It does
**not** limit **how many** instances of the same type can run simultaneously.

### What Bounds Concurrency in Practice

Since there is no explicit concurrency cap, these factors naturally limit it:

```
┌─────────────────────────────────────────────────────┐
│  1. Parent MaxIterations (default 20)               │
│     Each spawn call costs 1 iteration. Parent can   │
│     spawn at most ~20 subagents per message.        │
│                                                     │
│  2. LLM API Rate Limits                             │
│     Each subagent iteration = 1 API call.           │
│     5 subagents × 10 iterations = 50 API calls.     │
│     Provider rate limits will throttle this.         │
│                                                     │
│  3. Context Cancellation                            │
│     ctx.Done() propagates from parent to all        │
│     children. If parent is canceled, all subagents  │
│     check ctx and stop (subagent.go:132-140).       │
│                                                     │
│  4. Go Runtime Scheduler                            │
│     Goroutines are multiplexed onto OS threads.     │
│     Go scheduler handles thousands of goroutines    │
│     efficiently, so this is rarely the bottleneck.  │
└─────────────────────────────────────────────────────┘
```

---

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `pkg/agent/instance.go` | 331 | AgentInstance struct + factory (`NewAgentInstance`) |
| `pkg/agent/loop.go` | ~1450 | AgentLoop + main execution loop + LLM iteration cycle |
| `pkg/agent/registry.go` | 141 | AgentRegistry: agent map + routing |
| `pkg/agent/context.go` | ~733 | ContextBuilder: system prompt + message assembly |
| `pkg/tools/base.go` | 94 | Tool interface + AsyncExecutor + ToolResult |
| `pkg/tools/registry.go` | 332 | ToolRegistry: registration, TTL, execution dispatch |
| `pkg/tools/shell.go` | ~289 | exec tool: shell command execution with process groups |
| `pkg/tools/web.go` | ~450 | web/web_fetch tools: HTTP search and fetch |
| `pkg/tools/i2c_linux.go` | ~271 | I2C hardware tool (ioctl syscalls) |
| `pkg/tools/spi_linux.go` | ~177 | SPI hardware tool (ioctl syscalls) |
| `pkg/tools/subagent.go` | ~150 | Subagent manager: background task goroutines |
| `pkg/memory/jsonl.go` | ~460 | JSONL session store: append-only + sharded locks |
| `pkg/fileutil/file.go` | ~119 | Atomic file writes: temp + fsync + rename |
| `pkg/providers/common/common.go` | ~45 | HTTP client factory (120s timeout) |
