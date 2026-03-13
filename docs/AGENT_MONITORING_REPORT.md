# PicoClaw Agent Monitoring & Management System — Architecture Report

## Table of Contents

1. [Agent Architecture Overview](#1-agent-architecture-overview)
2. [How Agents Are Constituted](#2-how-agents-are-constituted)
3. [Data Flow & Execution Lifecycle](#3-data-flow--execution-lifecycle)
4. [Current Observability State](#4-current-observability-state)
5. [Monitoring System Design](#5-monitoring-system-design)
6. [Implementation Plan](#6-implementation-plan)
7. [Data Visualization & Dashboard](#7-data-visualization--dashboard)

---

## 1. Agent Architecture Overview

PicoClaw is an ultra-lightweight personal AI agent written in Go (target: <10MB RAM, 1-second boot on $10 hardware). The core architecture follows an event-driven pipeline:

```
Channel → Bus → AgentLoop → Provider → Tools → Results → Bus → Channel
```

### Key Components

| Component | Package | Purpose |
|-----------|---------|---------|
| **MessageBus** | `pkg/bus/` | Thread-safe pub/sub message bus (buffered channels, 64-msg capacity) |
| **AgentLoop** | `pkg/agent/loop.go` | Central orchestrator — consumes inbound, runs LLM iterations, publishes outbound |
| **AgentRegistry** | `pkg/agent/registry.go` | Manages multiple named agent instances, routes messages to them |
| **AgentInstance** | `pkg/agent/instance.go` | Fully configured agent: model, workspace, tools, sessions, routing |
| **RouteResolver** | `pkg/routing/route.go` | 7-level priority cascade for agent selection |
| **Router** | `pkg/routing/router.go` | Complexity-based model routing (light vs heavy model) |
| **FallbackChain** | `pkg/providers/fallback.go` | Multi-provider failover with cooldown tracking |
| **ToolRegistry** | `pkg/tools/registry.go` | Per-agent tool management with async execution support |
| **SessionManager** | `pkg/session/manager.go` | Conversation history persistence (JSON files) |
| **ContextBuilder** | `pkg/agent/context.go` | System prompt and context assembly |
| **MemoryStore** | `pkg/agent/memory.go` | Long-term memory + daily notes |
| **ChannelManager** | `pkg/channels/manager.go` | Manages all chat platform integrations with rate limiting |
| **StateManager** | `pkg/state/state.go` | Persistent workspace state (atomic saves) |
| **Logger** | `pkg/logger/logger.go` | Component-based structured logging (JSON to file, text to stdout) |

---

## 2. How Agents Are Constituted

### 2.1 Agent Configuration

Each agent is defined via `config.json` under `agents.list[]` and instantiated in `NewAgentInstance()` (`pkg/agent/instance.go`):

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.picoclaw/workspace",
      "model_name": "gpt4",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20,
      "summarize_message_threshold": 20,
      "summarize_token_percent": 75
    },
    "list": [
      { "id": "main", "default": true, "name": "Main Agent" },
      { "id": "coder", "name": "Code Agent", "model": { "primary": "claude-sonnet-4.6" } }
    ]
  }
}
```

### 2.2 Agent Instance Structure

Each `AgentInstance` contains:

| Field | Type | Description |
|-------|------|-------------|
| `ID` | `string` | Normalized agent identifier |
| `Name` | `string` | Human-readable agent name |
| `Model` | `string` | Primary LLM model (e.g., `openai/gpt-5.2`) |
| `Fallbacks` | `[]string` | Ordered fallback model list |
| `Workspace` | `string` | Isolated filesystem workspace directory |
| `MaxIterations` | `int` | Max tool call iterations per request (default: 20) |
| `MaxTokens` | `int` | Max LLM output tokens (default: 8192) |
| `Temperature` | `float64` | LLM temperature (default: 0.7) |
| `ThinkingLevel` | `ThinkingLevel` | Extended thinking level |
| `ContextWindow` | `int` | Context window size |
| `SummarizeMessageThreshold` | `int` | Messages before auto-summarization (default: 20) |
| `SummarizeTokenPercent` | `int` | Token percentage threshold for summarization (default: 75%) |
| `Provider` | `LLMProvider` | LLM provider interface |
| `Sessions` | `*SessionManager` | Per-agent session/history manager |
| `ContextBuilder` | `*ContextBuilder` | System prompt builder |
| `Tools` | `*ToolRegistry` | Per-agent tool registry |
| `Subagents` | `*SubagentsConfig` | Which agents this agent can spawn |
| `Candidates` | `[]FallbackCandidate` | Pre-resolved provider fallback candidates |
| `Router` | `*Router` | Optional light/heavy model router |
| `LightCandidates` | `[]FallbackCandidate` | Pre-resolved light model candidates |

### 2.3 Agent Registration Flow

```
config.json → NewAgentRegistry() → for each agents.list[]:
  → NewAgentInstance(agentCfg, defaults, cfg, provider)
    → resolveAgentWorkspace()     // isolated workspace per agent
    → resolveAgentModel()         // primary model resolution
    → resolveAgentFallbacks()     // fallback model chain
    → tools.NewToolRegistry()     // fresh tool registry
    → Register filesystem tools   // read_file, write_file, list_dir, exec, edit_file, append_file
    → session.NewSessionManager() // per-agent session dir
    → NewContextBuilder()         // system prompt builder
    → ResolveCandidatesWithLookup() // model_list resolution
    → routing.New()               // optional light/heavy router

→ registerSharedTools()           // web, message, spawn, skills, hardware tools
```

### 2.4 Tool Categories

Tools are registered per-agent based on config `tools.<name>.enabled`:

| Category | Tools | Async |
|----------|-------|-------|
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `append_file`, `list_dir` | No |
| **Execution** | `exec` (shell commands with deny patterns) | No |
| **Web** | `web_search` (Brave/Tavily/DuckDuckGo/Perplexity/SearXNG), `web_fetch` | No |
| **Communication** | `message` (send to channel), `send_file` (media attachments) | No |
| **Agent** | `spawn` (subagent via `AsyncExecutor`), `subagent` | **Yes** |
| **Skills** | `find_skills`, `install_skill` | No |
| **Hardware** | `i2c`, `spi` (Linux only) | No |
| **MCP** | Dynamic tools from MCP servers (Model Context Protocol) | No |
| **Cron** | Scheduled task execution | No |

### 2.5 Message Routing (7-Level Priority Cascade)

When a message arrives, `RouteResolver.ResolveRoute()` selects the target agent:

1. **Peer binding** — specific user/chat match
2. **Parent peer binding** — parent conversation match
3. **Guild binding** — Discord guild / group match
4. **Team binding** — Slack team match
5. **Account binding** — account-level match
6. **Channel wildcard** — channel-level catch-all
7. **Default agent** — fallback to default

### 2.6 Model Routing (Complexity Scoring)

`Router.SelectModel()` uses a `RuleClassifier` to score each message in [0, 1]:

| Signal | Weight |
|--------|--------|
| Token > 200 (long text) | 0.35 |
| Token 50–200 (medium) | 0.15 |
| Code block present | 0.40 |
| Tool calls > 3 (recent) | 0.25 |
| Tool calls 1–3 | 0.10 |
| Conversation depth > 10 | 0.10 |
| Attachments present | 1.00 (hard gate) |

If `score < threshold` → light model; otherwise → heavy (primary) model.

---

## 3. Data Flow & Execution Lifecycle

### 3.1 Complete Request Lifecycle

```
1. Channel (Telegram/Discord/Slack/...) receives user message
   └─→ BaseChannel validates sender (allowlist check)
   └─→ PublishInbound(InboundMessage) to MessageBus

2. AgentLoop.Run() consumes from bus.ConsumeInbound()
   └─→ processMessage()
       └─→ transcribeAudioInMessage() (if voice)
       └─→ resolveMessageRoute() → RouteResolver 7-level cascade
       └─→ handleCommand() (check for /help, /show, etc.)
       └─→ runAgentLoop()

3. runAgentLoop(agent, opts)
   └─→ RecordLastChannel()
   └─→ GetHistory() + GetSummary() from SessionManager
   └─→ ContextBuilder.BuildMessages() (system prompt + history + user msg)
   └─→ resolveMediaRefs() (media:// → base64)
   └─→ AddMessage("user", content) to session

4. runLLMIteration(agent, messages, opts)
   └─→ Loop up to MaxIterations:
       └─→ FallbackChain.Execute(candidates, chatFn)
           └─→ Try each candidate (cooldown check → provider.Chat())
           └─→ On failure: ClassifyError() → MarkFailure() → next candidate
           └─→ On success: MarkSuccess() → return response
       └─→ If response has ToolCalls:
           └─→ ToolRegistry.ExecuteWithContext(name, args, channel, chatID, asyncCallback)
           └─→ Append tool results to messages
           └─→ Continue loop
       └─→ If no ToolCalls: break (final response)

5. Post-processing
   └─→ AddMessage("assistant", finalContent) to session
   └─→ Save session to disk (atomic temp+rename)
   └─→ maybeSummarize() (if threshold exceeded)
   └─→ PublishOutbound() → MessageBus → Channel → User
```

### 3.2 Provider Fallback & Cooldown

The `FallbackChain` (`pkg/providers/fallback.go`) orchestrates multi-provider failover:

- **CooldownTracker** manages per-provider exponential backoff:
  - Standard errors: 1min → 5min → 25min → 1h (cap)
  - Billing errors: 5h → 10h → 20h → 24h (cap)
  - 24h failure window reset
- **Error Classification** (`error_classifier.go`): auth, rate_limit, billing, timeout, format, overloaded
- **FallbackAttempt** records: provider, model, error, reason, duration, skipped status

### 3.3 Async Tool Execution (Subagents)

The `AsyncExecutor` interface (`pkg/tools/base.go`) enables non-blocking tool execution:

```
SpawnTool.ExecuteAsync(ctx, args, callback)
  └─→ Launches goroutine running SubagentManager.Run()
  └─→ Returns AsyncResult("Subagent spawned") immediately
  └─→ When subagent completes: callback(ctx, result)
  └─→ Result published to MessageBus as system message
```

---

## 4. Current Observability State

### 4.1 What Exists Today

| Capability | Implementation | Limitations |
|------------|---------------|-------------|
| **Structured Logging** | `pkg/logger/logger.go` — JSON to file, text to stdout | No metrics extraction, no log aggregation |
| **Component Tags** | Components: `agent`, `tool`, `provider`, `channel`, `auth`, `config` | No filtering beyond log level |
| **Tool Execution Logging** | Duration, args, result length logged per tool call | Not aggregated, no time-series |
| **Fallback Attempt Tracking** | `FallbackAttempt` records per-chain execution | In-memory only, lost on restart |
| **Cooldown State** | `CooldownTracker` — error counts, cooldown times | In-memory only, no visibility |
| **Session Persistence** | JSON files in `workspace/sessions/` | No metrics on session count/size |
| **State Persistence** | `state/state.json` — last channel, timestamp | Minimal state tracking |
| **Heartbeat** | `heartbeat.enabled: true, interval: 30` in config | Basic liveness only |

### 4.2 What's Missing

| Gap | Impact |
|-----|--------|
| **No metrics collection** | Cannot track request rates, latencies, error rates over time |
| **No token usage tracking** | `UsageInfo` (prompt_tokens, completion_tokens) exists in LLMResponse but is not aggregated |
| **No per-agent metrics** | Cannot compare agent performance or utilization |
| **No tool execution metrics** | Cannot identify slow or failing tools |
| **No bus queue monitoring** | Cannot detect backpressure (64-msg buffer saturation) |
| **No session analytics** | Cannot track active sessions, message counts, memory usage |
| **No cost tracking** | No mapping from token usage to monetary cost |
| **No health dashboard** | No real-time visibility into system state |
| **No alerting** | No notification on errors, cooldowns, or resource exhaustion |
| **No request tracing** | Cannot trace a request end-to-end through the pipeline |

---

## 5. Monitoring System Design

### 5.1 Architecture

```
                                  ┌──────────────────────┐
                                  │   Grafana Dashboard   │
                                  │  (Visualization)      │
                                  └──────────┬───────────┘
                                             │ Query
                                  ┌──────────▼───────────┐
                                  │  Prometheus / VictoriaMetrics │
                                  │  (Time-series DB)     │
                                  └──────────┬───────────┘
                                             │ Scrape /metrics
┌─────────────────────────────────────────────▼──────────────────────────┐
│                        PicoClaw Process                                │
│                                                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ MetricsCollector │  │ TraceContext  │  │ HealthCheck  │  │ StatusAPI  │ │
│  │ (pkg/metrics)    │  │ (pkg/trace)   │  │ (pkg/health) │  │ (cmd/...)  │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                  │                 │        │
│         ▼                 ▼                  ▼                 ▼        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Instrumentation Points                        │  │
│  │  AgentLoop · ToolRegistry · FallbackChain · MessageBus ·        │  │
│  │  SessionManager · ChannelManager · CooldownTracker              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Metrics to Collect

#### A. Request & Processing Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_requests_total` | Counter | `agent_id`, `channel`, `status` | `AgentLoop.processMessage()` |
| `picoclaw_request_duration_seconds` | Histogram | `agent_id`, `channel` | `AgentLoop.runAgentLoop()` |
| `picoclaw_llm_iterations_total` | Counter | `agent_id`, `model` | `AgentLoop.runLLMIteration()` |
| `picoclaw_iterations_per_request` | Histogram | `agent_id` | `AgentLoop.runLLMIteration()` |

#### B. LLM Provider Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_llm_calls_total` | Counter | `provider`, `model`, `status` | `FallbackChain.Execute()` |
| `picoclaw_llm_call_duration_seconds` | Histogram | `provider`, `model` | `FallbackChain.Execute()` |
| `picoclaw_llm_tokens_prompt_total` | Counter | `provider`, `model` | `LLMResponse.Usage` |
| `picoclaw_llm_tokens_completion_total` | Counter | `provider`, `model` | `LLMResponse.Usage` |
| `picoclaw_llm_tokens_total` | Counter | `provider`, `model` | `LLMResponse.Usage` |
| `picoclaw_llm_fallback_total` | Counter | `provider`, `model`, `reason` | `FallbackChain.Execute()` |
| `picoclaw_llm_cooldown_active` | Gauge | `provider` | `CooldownTracker` |
| `picoclaw_llm_error_count` | Gauge | `provider`, `reason` | `CooldownTracker` |

#### C. Tool Execution Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_tool_calls_total` | Counter | `tool`, `agent_id`, `status` | `ToolRegistry.ExecuteWithContext()` |
| `picoclaw_tool_duration_seconds` | Histogram | `tool`, `agent_id` | `ToolRegistry.ExecuteWithContext()` |
| `picoclaw_tool_errors_total` | Counter | `tool`, `agent_id` | `ToolRegistry.ExecuteWithContext()` |
| `picoclaw_async_tasks_active` | Gauge | `agent_id` | `SpawnTool / SubagentManager` |

#### D. Message Bus Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_bus_inbound_total` | Counter | — | `MessageBus.PublishInbound()` |
| `picoclaw_bus_outbound_total` | Counter | — | `MessageBus.PublishOutbound()` |
| `picoclaw_bus_inbound_queue_size` | Gauge | — | `len(mb.inbound)` |
| `picoclaw_bus_outbound_queue_size` | Gauge | — | `len(mb.outbound)` |
| `picoclaw_bus_dropped_total` | Counter | — | `MessageBus.Close()` drain count |

#### E. Channel Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_channel_messages_received_total` | Counter | `channel` | Channel implementations |
| `picoclaw_channel_messages_sent_total` | Counter | `channel` | `ChannelManager` workers |
| `picoclaw_channel_errors_total` | Counter | `channel`, `error_type` | Channel implementations |
| `picoclaw_channel_rate_limit_waits_total` | Counter | `channel` | `channelWorker` limiter |

#### F. Session & Memory Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_sessions_active` | Gauge | `agent_id` | `SessionManager` |
| `picoclaw_session_messages_total` | Gauge | `agent_id`, `session_key` | `SessionManager` |
| `picoclaw_session_saves_total` | Counter | `agent_id` | `SessionManager.Save()` |
| `picoclaw_summarizations_total` | Counter | `agent_id` | `AgentLoop.maybeSummarize()` |

#### G. Model Routing Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_routing_decisions_total` | Counter | `agent_id`, `model_tier` | `Router.SelectModel()` |
| `picoclaw_routing_complexity_score` | Histogram | `agent_id` | `Router.SelectModel()` |
| `picoclaw_routing_light_model_ratio` | Gauge | `agent_id` | Computed from decisions |

#### H. System Resource Metrics

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `picoclaw_goroutines` | Gauge | — | `runtime.NumGoroutine()` |
| `picoclaw_memory_alloc_bytes` | Gauge | — | `runtime.MemStats` |
| `picoclaw_memory_sys_bytes` | Gauge | — | `runtime.MemStats` |
| `picoclaw_gc_pause_seconds` | Summary | — | `runtime.MemStats` |
| `picoclaw_uptime_seconds` | Gauge | — | Process start time |

### 5.3 Distributed Tracing

Implement request-scoped tracing via context propagation:

```go
// pkg/trace/trace.go
type TraceContext struct {
    TraceID    string
    SpanID     string
    ParentID   string
    StartTime  time.Time
    Agent      string
    Channel    string
    Spans      []Span
}

type Span struct {
    Name      string
    StartTime time.Time
    EndTime   time.Time
    Labels    map[string]string
    Status    string
}
```

Each request gets a `TraceContext` injected via `context.WithValue()`:
- Span 1: `channel.receive` — message received from platform
- Span 2: `bus.publish` — published to MessageBus
- Span 3: `agent.route` — routing decision
- Span 4: `agent.context_build` — system prompt + history assembly
- Span 5: `llm.call` — each LLM API call (with provider, model, tokens)
- Span 6: `tool.execute` — each tool execution (with tool name, duration)
- Span 7: `session.save` — session persistence
- Span 8: `bus.respond` — outbound message published
- Span 9: `channel.send` — message delivered to platform

### 5.4 Health Check Endpoint

Extend the existing `pkg/health` package:

```
GET /health
{
  "status": "healthy",
  "uptime_seconds": 3600,
  "agents": {
    "main": { "status": "active", "sessions": 5, "tools": 12 },
    "coder": { "status": "active", "sessions": 2, "tools": 14 }
  },
  "providers": {
    "openai": { "status": "available", "error_count": 0, "cooldown_remaining": 0 },
    "anthropic": { "status": "cooldown", "error_count": 3, "cooldown_remaining": "4m32s" }
  },
  "bus": {
    "inbound_queue": 2,
    "outbound_queue": 0,
    "inbound_capacity": 64,
    "outbound_capacity": 64
  },
  "channels": {
    "telegram": { "status": "connected", "messages_sent": 142 },
    "discord": { "status": "connected", "messages_sent": 87 }
  },
  "memory": {
    "alloc_mb": 7.2,
    "sys_mb": 12.1,
    "goroutines": 23
  }
}
```

---

## 6. Implementation Plan

### Phase 1: Metrics Foundation (Core Instrumentation)

**New package: `pkg/metrics/`**

```go
// pkg/metrics/collector.go
package metrics

import (
    "sync"
    "sync/atomic"
    "time"
)

// Collector is the central metrics registry.
// Lightweight: no external dependencies, pure Go.
type Collector struct {
    counters   sync.Map // name → *Counter
    gauges     sync.Map // name → *Gauge
    histograms sync.Map // name → *Histogram
    startTime  time.Time
}

type Counter struct {
    values sync.Map // labelKey → *atomic.Int64
}

type Gauge struct {
    values sync.Map // labelKey → *atomic.Int64 (stored as float64 bits)
}

type Histogram struct {
    buckets []float64
    values  sync.Map // labelKey → *histogramValue
}
```

**Instrumentation points** (minimal changes to existing code):

1. **`pkg/tools/registry.go:ExecuteWithContext()`** — wrap existing duration tracking:
   ```go
   // After line 90 (existing duration calculation):
   metrics.Default.CounterInc("picoclaw_tool_calls_total", tool, statusLabel)
   metrics.Default.HistogramObserve("picoclaw_tool_duration_seconds", duration.Seconds(), tool)
   ```

2. **`pkg/providers/fallback.go:Execute()`** — instrument each attempt:
   ```go
   // After line 148 (success) and line 190 (failure):
   metrics.Default.CounterInc("picoclaw_llm_calls_total", provider, model, statusLabel)
   metrics.Default.HistogramObserve("picoclaw_llm_call_duration_seconds", elapsed.Seconds(), provider, model)
   if resp.Usage != nil {
       metrics.Default.CounterAdd("picoclaw_llm_tokens_total", int64(resp.Usage.TotalTokens), provider, model)
   }
   ```

3. **`pkg/bus/bus.go`** — add queue size gauges:
   ```go
   func (mb *MessageBus) QueueSizes() (inbound, outbound, outboundMedia int) {
       return len(mb.inbound), len(mb.outbound), len(mb.outboundMedia)
   }
   ```

4. **`pkg/agent/loop.go:processMessage()`** — request-level metrics:
   ```go
   start := time.Now()
   // ... existing processing ...
   metrics.Default.HistogramObserve("picoclaw_request_duration_seconds", time.Since(start).Seconds(), agent.ID, msg.Channel)
   ```

### Phase 2: Prometheus Exposition

**New file: `pkg/metrics/prometheus.go`**

Expose a `/metrics` HTTP endpoint in the existing gateway server (`cmd/picoclaw-launcher`):

```go
// Renders all metrics in Prometheus text exposition format
func (c *Collector) PrometheusHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/plain; version=0.0.4")
        c.WritePrometheus(w)
    }
}
```

This can be mounted at `gateway.host:gateway.port/metrics` alongside the existing launcher server.

### Phase 3: Tracing

**New package: `pkg/trace/`**

- Inject `TraceContext` into `context.Context` at `processMessage()` entry
- Each major operation creates a child span
- On completion, trace is logged as structured JSON and/or exported via OpenTelemetry

### Phase 4: Health & Status API

**Extend existing `pkg/health/`**

- Add `/health` endpoint with comprehensive system status
- Add `/status/agents` for per-agent status
- Add `/status/providers` for provider health
- Integrate with the existing `status` CLI command (`cmd/picoclaw/internal/status/`)

### Phase 5: Dashboard & Visualization

See Section 7 below.

---

## 7. Data Visualization & Dashboard

### 7.1 Grafana Dashboard Layout

#### Row 1: System Overview
- **Uptime** (stat panel)
- **Memory Usage** (gauge: alloc vs sys)
- **Goroutines** (stat panel)
- **Active Agents** (stat panel)
- **Active Sessions** (stat panel)

#### Row 2: Request Flow
- **Requests/min** (time series, by channel)
- **Request Latency p50/p95/p99** (time series)
- **Error Rate** (time series, by error type)
- **Bus Queue Depth** (time series, inbound vs outbound)

#### Row 3: LLM Provider Performance
- **LLM Calls/min** (time series, by provider)
- **LLM Latency** (time series, by provider+model)
- **Token Usage** (stacked bar, prompt vs completion)
- **Fallback/Cooldown Events** (time series)
- **Provider Availability** (status map)

#### Row 4: Tool Execution
- **Tool Calls/min** (time series, by tool name)
- **Tool Latency** (heatmap, by tool)
- **Tool Errors** (table, recent errors with details)
- **Async Tasks Active** (gauge)

#### Row 5: Model Routing
- **Light vs Heavy Model Usage** (pie chart)
- **Complexity Score Distribution** (histogram)
- **Cost Savings from Routing** (stat panel, estimated)

#### Row 6: Channel Activity
- **Messages Received/Sent per Channel** (stacked bar)
- **Channel Error Rates** (time series)
- **Rate Limit Hits** (time series)

### 7.2 CLI Status Dashboard

Extend the existing `picoclaw status` command with rich output:

```
$ picoclaw status --detailed

PicoClaw Status
═══════════════
Uptime: 2h 34m 12s    Memory: 7.2 MB / 12.1 MB    Goroutines: 23

Agents
──────
  main   ● active   model=openai/gpt-5.2     sessions=5   tools=12
  coder  ● active   model=anthropic/claude    sessions=2   tools=14

Providers
─────────
  openai     ● available   errors=0   calls=142   avg_latency=1.2s
  anthropic  ◉ cooldown    errors=3   calls=87    cooldown=4m32s

Channels
────────
  telegram   ● connected   received=89   sent=142   errors=0
  discord    ● connected   received=45   sent=87    errors=1

Recent Activity (last 5 min)
────────────────────────────
  Requests: 12    LLM calls: 18    Tool calls: 34    Tokens: 45,230
  Avg latency: 2.3s    Error rate: 2.1%

Top Tools (by call count)
─────────────────────────
  exec         14 calls   avg 0.8s
  read_file    11 calls   avg 0.02s
  web_search    5 calls   avg 1.5s
  write_file    4 calls   avg 0.03s
```

### 7.3 Lightweight Embedded Dashboard (No External Dependencies)

For the <10MB RAM constraint, provide a built-in HTML dashboard served from the gateway:

```
GET /dashboard
```

Single-page HTML with auto-refreshing metrics (fetch `/metrics` every 5s):
- Built with vanilla HTML/CSS/JS (no React/Vue)
- Embedded via `//go:embed` in the binary
- Renders simple charts using `<canvas>` or SVG
- Zero additional memory overhead

### 7.4 Log-Based Analytics (Zero-Dependency Option)

Since the logger already outputs structured JSON, a log analytics pipeline can extract metrics without any code changes:

```bash
# Token usage per provider (from existing logs)
cat picoclaw.log | jq 'select(.component=="provider") | .fields' | ...

# Tool execution times (from existing logs)
cat picoclaw.log | jq 'select(.component=="tool" and .message=="Tool execution completed") | {tool: .fields.tool, duration: .fields.duration_ms}'

# Error rate over time
cat picoclaw.log | jq 'select(.level=="ERROR") | .timestamp' | ...
```

Tools like `loki` + `Grafana` can ingest these JSON logs directly.

---

## Summary of Implementation Priority

| Priority | Component | Effort | Impact |
|----------|-----------|--------|--------|
| **P0** | `pkg/metrics/collector.go` — in-memory metrics | Small | Foundation for everything |
| **P0** | Instrument `FallbackChain.Execute()` — token & cost tracking | Small | Most-requested visibility |
| **P0** | `MessageBus.QueueSizes()` — backpressure detection | Tiny | Prevent silent message loss |
| **P1** | Prometheus `/metrics` endpoint | Medium | Industry-standard integration |
| **P1** | Instrument `ToolRegistry`, `AgentLoop` | Medium | Full pipeline visibility |
| **P1** | Extended `picoclaw status --detailed` CLI | Medium | Immediate user value |
| **P2** | `/health` JSON endpoint | Small | Operational monitoring |
| **P2** | Embedded HTML dashboard | Medium | Self-contained visualization |
| **P3** | Request tracing (`pkg/trace/`) | Large | End-to-end debugging |
| **P3** | Grafana dashboard JSON templates | Medium | Production monitoring |
| **P3** | Alerting rules (Prometheus/Grafana) | Small | Proactive issue detection |

---

## Appendix: File Reference

| File | Purpose |
|------|---------|
| `pkg/agent/loop.go` | AgentLoop — central orchestrator (main instrumentation target) |
| `pkg/agent/instance.go` | AgentInstance — per-agent configuration and setup |
| `pkg/agent/registry.go` | AgentRegistry — multi-agent management |
| `pkg/agent/context.go` | ContextBuilder — system prompt assembly |
| `pkg/agent/memory.go` | MemoryStore — long-term and daily notes |
| `pkg/bus/bus.go` | MessageBus — inbound/outbound message channels |
| `pkg/bus/types.go` | Message types (InboundMessage, OutboundMessage) |
| `pkg/providers/types.go` | LLMProvider interface, FailoverError |
| `pkg/providers/fallback.go` | FallbackChain — multi-provider failover |
| `pkg/providers/cooldown.go` | CooldownTracker — exponential backoff |
| `pkg/providers/error_classifier.go` | Error classification for failover decisions |
| `pkg/providers/protocoltypes/types.go` | LLMResponse, UsageInfo, ToolCall |
| `pkg/tools/base.go` | Tool interface, AsyncExecutor |
| `pkg/tools/registry.go` | ToolRegistry — tool management and execution |
| `pkg/tools/result.go` | ToolResult types (sync, async, error, silent) |
| `pkg/routing/route.go` | RouteResolver — 7-level priority cascade |
| `pkg/routing/router.go` | Router — complexity-based model selection |
| `pkg/routing/classifier.go` | RuleClassifier — weighted signal scoring |
| `pkg/session/manager.go` | SessionManager — conversation persistence |
| `pkg/channels/manager.go` | ChannelManager — platform integration management |
| `pkg/state/state.go` | StateManager — workspace state persistence |
| `pkg/logger/logger.go` | Structured component-based logging |
| `config/config.example.json` | Full configuration reference |
| `cmd/picoclaw/main.go` | CLI entry point |
