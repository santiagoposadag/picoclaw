# Human-in-the-Loop: Pause, Ask, Resume

## Problem Statement

When an agent is executing a multi-step task (e.g., a tool chain with 5-10 LLM iterations), there is no way for it to **pause execution, ask the human a question, wait for their answer, and resume** from where it left off. The current architecture is "fire and forget" — a message comes in, the agent loop runs to completion (or max iterations), and the response goes out.

This means:
- The agent cannot ask for clarification mid-task ("Should I delete this file or rename it?")
- The agent cannot request approval before dangerous operations ("About to run `rm -rf build/`, proceed?")
- The agent cannot present options and let the human choose ("Found 3 matching configs, which one?")
- Long-running tasks cannot checkpoint and let the human steer direction

The user experiences this as a loss of control — the agent either does everything autonomously or nothing at all.

## Current Architecture (Why This Doesn't Exist Yet)

### The Agent Loop is Synchronous Within a Turn

```
ConsumeInbound(msg)
  → runAgentLoop(agent, opts)
    → runLLMIteration() loop:
        FOR iteration < MaxIterations:
          LLM call → get tool calls
          Execute tools (parallel, WaitGroup)
          Append results to messages
          NEXT ITERATION
    → PublishOutbound(response)
```

**Key constraint:** `runLLMIteration()` (`loop.go:869-1227`) runs as a tight loop. There is no yield point where execution can pause, persist state, and resume later when a new inbound message arrives.

### What Already Exists (and What We Can Build On)

| Pattern | Where | Reusable? |
|---------|-------|-----------|
| **AsyncExecutor** | `tools/base.go:76` | Yes — tools can return `AsyncResult()` and fire a callback later |
| **SpawnTool** | `tools/spawn.go` | Yes — fires callback when subagent completes |
| **Session persistence** | `session/manager.go` | Yes — full message history saved to disk per session |
| **Message metadata** | `bus/types.go:29` | Yes — `Metadata map[string]string` on InboundMessage |
| **State persistence** | `state/state.go` | Partially — only tracks last channel/chatID |
| **Request.Reply callback** | `commands/request.go` | Pattern — commands can reply inline |

### What's Missing

1. **No pause/resume state machine** — No concept of "agent is waiting for human input at iteration N"
2. **No correlation** — No way to link a human's reply back to a specific pending question
3. **No pending request store** — Nowhere to persist "what was I doing when I paused"
4. **No timeout/expiry** — No mechanism to expire stale requests

---

## Proposed Design

### Core Concept: `InterventionRequest`

An `InterventionRequest` is a structured pause point. When the agent (or a tool, or the LLM itself) determines it needs human input, it creates an intervention request that:

1. **Persists** the current execution state (session key, agent ID, iteration context)
2. **Sends** a formatted question to the human via the same channel
3. **Suspends** the current agent loop iteration
4. **Waits** for a correlated inbound message
5. **Resumes** the agent loop with the human's answer injected as context

### Data Model

```go
// pkg/intervention/request.go

type InterventionRequest struct {
    ID          string            `json:"id"`           // unique request ID (uuid)
    AgentID     string            `json:"agent_id"`     // which agent is paused
    SessionKey  string            `json:"session_key"`  // session to resume
    Channel     string            `json:"channel"`      // channel to send question on
    ChatID      string            `json:"chat_id"`      // chat to send question on
    Question    string            `json:"question"`     // what to ask the human
    Options     []string          `json:"options,omitempty"` // optional structured choices
    Context     string            `json:"context"`      // why the agent is asking
    ToolCallID  string            `json:"tool_call_id,omitempty"` // if paused mid-tool
    Iteration   int               `json:"iteration"`    // which LLM iteration we're on
    Messages    []Message         `json:"messages"`     // conversation state at pause point
    CreatedAt   time.Time         `json:"created_at"`
    ExpiresAt   time.Time         `json:"expires_at"`   // auto-expire after N minutes
    Status      string            `json:"status"`       // "pending" | "answered" | "expired"
    Answer      string            `json:"answer,omitempty"` // human's response
    Metadata    map[string]string `json:"metadata,omitempty"`
}
```

### Storage

```
{workspace}/interventions/
  ├── pending/
  │   └── {request-id}.json     # active requests awaiting response
  ├── answered/
  │   └── {request-id}.json     # completed (for audit trail)
  └── expired/
      └── {request-id}.json     # timed out
```

Persistence uses the same atomic-write pattern as `session/manager.go` (temp file + rename).

### New Package: `pkg/intervention`

```go
// pkg/intervention/manager.go

type Manager struct {
    storage     string              // filesystem path
    pending     map[string]*InterventionRequest
    mu          sync.RWMutex
    waiters     map[string]chan string  // request ID → channel for answer
}

func (m *Manager) CreateRequest(req *InterventionRequest) error
func (m *Manager) AnswerRequest(requestID, answer string) error
func (m *Manager) WaitForAnswer(ctx context.Context, requestID string) (string, error)
func (m *Manager) FindPendingByChat(channel, chatID string) *InterventionRequest
func (m *Manager) ExpireStale() int
func (m *Manager) GetPending(requestID string) *InterventionRequest
```

---

## Integration Points

### 1. New Tool: `ask_human` (LLM-Initiated Pause)

The LLM can call this tool when it determines it needs human input. This is the most natural integration — the LLM already decides when to use tools.

```go
// pkg/tools/ask_human.go

type AskHumanTool struct {
    interventionMgr *intervention.Manager
}

func (t *AskHumanTool) Name() string { return "ask_human" }

func (t *AskHumanTool) Description() string {
    return `Pause execution and ask the human a question. Use this when you need
clarification, approval, or a decision before proceeding. Execution will resume
when the human responds. Examples:
- "Should I overwrite the existing config or create a backup?"
- "Which database migration strategy: blue-green or rolling?"
- "I found 3 matching files. Which one should I modify?"`
}

func (t *AskHumanTool) Parameters() map[string]any {
    return map[string]any{
        "type": "object",
        "properties": map[string]any{
            "question": map[string]any{
                "type":        "string",
                "description": "The question to ask the human",
            },
            "options": map[string]any{
                "type":        "array",
                "items":       map[string]any{"type": "string"},
                "description": "Optional list of choices to present",
            },
            "context": map[string]any{
                "type":        "string",
                "description": "Brief context about why you need this input",
            },
        },
        "required": []string{"question"},
    }
}
```

**Execution flow:**

```go
func (t *AskHumanTool) Execute(ctx context.Context, args map[string]any) *ToolResult {
    channel := ToolChannel(ctx)
    chatID := ToolChatID(ctx)
    question := args["question"].(string)

    // 1. Create intervention request
    req := &intervention.InterventionRequest{
        ID:        uuid.New().String(),
        Channel:   channel,
        ChatID:    chatID,
        Question:  question,
        Options:   extractOptions(args),
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(30 * time.Minute),
        Status:    "pending",
    }
    t.interventionMgr.CreateRequest(req)

    // 2. Format question for user (with request ID for correlation)
    formatted := formatQuestion(req)

    // 3. Block until human responds or timeout
    answer, err := t.interventionMgr.WaitForAnswer(ctx, req.ID)
    if err != nil {
        return ErrorResult("Human did not respond in time: " + err.Error())
    }

    // 4. Return answer to LLM as tool result
    return SilentResult(fmt.Sprintf("Human responded: %s", answer))
}
```

### 2. Message Interception in Agent Loop

When a new inbound message arrives on a channel+chatID that has a pending intervention, route it as an answer instead of starting a new agent turn.

```go
// In pkg/agent/loop.go, inside processMessage():

func (al *AgentLoop) processMessage(ctx context.Context, msg bus.InboundMessage) (string, error) {
    // NEW: Check for pending intervention on this channel+chatID
    if al.interventionMgr != nil {
        pending := al.interventionMgr.FindPendingByChat(msg.Channel, msg.ChatID)
        if pending != nil {
            // Route this message as an answer, not a new conversation
            err := al.interventionMgr.AnswerRequest(pending.ID, msg.Content)
            if err != nil {
                logger.WarnCF("agent", "Failed to answer intervention",
                    map[string]any{"request_id": pending.ID, "error": err.Error()})
            }
            return "", nil  // Don't process as normal message
        }
    }

    // ... existing routing logic ...
}
```

### 3. Question Formatting for Channels

The question sent to the user should be clearly identifiable and actionable:

```
---
🔲 Agent needs your input (ref: abc123)

**Question:** Should I overwrite the existing config or create a backup?

**Context:** Found config.json with 47 custom settings that would be lost.

**Options:**
  1. Overwrite (lose current settings)
  2. Create backup at config.json.bak first
  3. Skip this step entirely

Reply with your choice or type a custom answer.
Expires in 30 minutes.
---
```

For Telegram specifically, this could use inline keyboard buttons:

```go
// pkg/channels/telegram/intervention.go

func (c *TelegramChannel) SendIntervention(req *intervention.InterventionRequest) error {
    if len(req.Options) > 0 {
        // Use inline keyboard for structured choices
        keyboard := telego.InlineKeyboardMarkup{
            InlineKeyboard: buildOptionButtons(req.ID, req.Options),
        }
        return c.sendWithKeyboard(req.ChatID, formatQuestion(req), keyboard)
    }
    // Free-text question
    return c.send(req.ChatID, formatQuestion(req))
}
```

### 4. Tool Approval Gates (Configuration-Driven)

Beyond LLM-initiated pauses, allow config-driven approval for specific tools:

```json
{
  "agents": {
    "defaults": {
      "intervention": {
        "enabled": true,
        "timeout_minutes": 30,
        "require_approval": ["exec", "write_file", "delete_file"],
        "auto_approve": ["read_file", "web_fetch", "list_files"]
      }
    }
  }
}
```

This inserts a gate in `runLLMIteration()` at line 1131, before tool execution:

```go
// Before executing each tool call
for i, tc := range normalizedToolCalls {
    // NEW: Check if tool requires human approval
    if al.interventionMgr != nil && al.requiresApproval(agent, tc.Name) {
        argsJSON, _ := json.Marshal(tc.Arguments)
        req := &intervention.InterventionRequest{
            ID:         uuid.New().String(),
            AgentID:    agent.ID,
            Channel:    opts.Channel,
            ChatID:     opts.ChatID,
            Question:   fmt.Sprintf("Approve tool call: %s(%s)?", tc.Name, argsJSON),
            Options:    []string{"Approve", "Deny", "Approve all remaining"},
            ToolCallID: tc.ID,
            CreatedAt:  time.Now(),
            ExpiresAt:  time.Now().Add(time.Duration(cfg.TimeoutMinutes) * time.Minute),
            Status:     "pending",
        }

        // Send question, block until answered
        al.interventionMgr.CreateRequest(req)
        al.bus.PublishOutbound(ctx, bus.OutboundMessage{
            Channel: opts.Channel,
            ChatID:  opts.ChatID,
            Content: formatApprovalRequest(req),
        })

        answer, err := al.interventionMgr.WaitForAnswer(ctx, req.ID)
        if err != nil || strings.ToLower(answer) == "deny" {
            agentResults[i].result = ErrorResult("Tool call denied by human")
            continue
        }
        if strings.Contains(strings.ToLower(answer), "approve all") {
            al.skipApprovalForTurn = true // skip remaining approvals this turn
        }
    }

    // Existing tool execution...
}
```

---

## Session Continuity Across Channel Reconnects

### Problem
If the agent asks a question via Telegram and the user doesn't respond for hours (or the bot restarts), the pending request must survive.

### Solution
Intervention requests are persisted to disk. On startup:

```go
func (al *AgentLoop) Start(ctx context.Context) {
    // ... existing startup ...

    // Restore pending interventions
    if al.interventionMgr != nil {
        pending := al.interventionMgr.LoadPending()
        for _, req := range pending {
            if req.ExpiresAt.Before(time.Now()) {
                al.interventionMgr.ExpireRequest(req.ID)
                continue
            }
            // Re-register waiter for this request
            go al.watchIntervention(ctx, req)
        }
    }
}
```

### Cross-Channel Resume
A user could ask a question on Telegram and answer on Discord (or CLI). The correlation is by `request_id`, not by channel:

```
# On Telegram:
Agent: "Should I use PostgreSQL or SQLite? (ref: abc123)"

# On Discord (or CLI):
User: "/respond abc123 PostgreSQL"

# Or simply reply in the same Telegram chat — auto-correlated by channel+chatID
```

The `/respond` command provides explicit correlation:

```go
// pkg/commands/respond.go

func respondHandler(ctx context.Context, req commands.Request, rt *commands.Runtime) error {
    parts := strings.SplitN(req.Text, " ", 2)
    if len(parts) < 2 {
        return req.Reply("Usage: /respond <request-id> <answer>")
    }
    requestID := parts[0]
    answer := parts[1]

    err := rt.InterventionMgr.AnswerRequest(requestID, answer)
    if err != nil {
        return req.Reply("No pending request with that ID: " + err.Error())
    }
    return req.Reply("Response recorded. Agent is resuming.")
}
```

---

## Sequence Diagram

```
Human              Channel(Telegram)        MessageBus         AgentLoop           ask_human tool
  |                      |                      |                  |                     |
  |--- "deploy to prod" -|                      |                  |                     |
  |                      |-- PublishInbound() -->|                  |                     |
  |                      |                      |-- Consume() ---->|                     |
  |                      |                      |                  |-- runAgentLoop() --->|
  |                      |                      |                  |    (LLM iteration 1) |
  |                      |                      |                  |    LLM decides to    |
  |                      |                      |                  |    call ask_human    |
  |                      |                      |                  |--  Execute() ------->|
  |                      |                      |                  |                     |
  |                      |                      |<-- PublishOutbound("Which env?") ------|
  |                      |<-- Send() -----------|                  |                     |
  |<-- "Which env?       |                      |                  |     (BLOCKED on     |
  |     1. staging       |                      |                  |      WaitForAnswer)  |
  |     2. production"   |                      |                  |                     |
  |                      |                      |                  |                     |
  |  (human thinks...)   |                      |                  |                     |
  |                      |                      |                  |                     |
  |--- "production" ---->|                      |                  |                     |
  |                      |-- PublishInbound() -->|                  |                     |
  |                      |                      |-- processMsg() ->|                     |
  |                      |                      |    (detects       |                     |
  |                      |                      |     pending       |                     |
  |                      |                      |     intervention) |                     |
  |                      |                      |                  |-- AnswerRequest() -->|
  |                      |                      |                  |     (unblocks        |
  |                      |                      |                  |      WaitForAnswer)  |
  |                      |                      |                  |                     |
  |                      |                      |                  |<- "production" ------|
  |                      |                      |                  |   (tool result)      |
  |                      |                      |                  |                      |
  |                      |                      |                  |-- continue iteration |
  |                      |                      |                  |   LLM sees answer,   |
  |                      |                      |                  |   calls deploy tool  |
  |                      |                      |<-- PublishOutbound("Deployed!") --------|
  |                      |<-- Send() -----------|                  |                      |
  |<-- "Deployed to prod"|                      |                  |                      |
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (P0)

**New package:** `pkg/intervention/`

| File | Purpose |
|------|---------|
| `manager.go` | InterventionManager — create, answer, wait, expire |
| `request.go` | InterventionRequest data model |
| `store.go` | File-based persistence (pending/answered/expired) |
| `format.go` | Question formatting for channels |

**Modifications:**

| File | Change |
|------|--------|
| `pkg/agent/loop.go` | Inject InterventionManager; intercept inbound messages for pending interventions |
| `pkg/bus/types.go` | No changes needed (Metadata field already exists) |
| `pkg/tools/ask_human.go` | New tool: `ask_human` |
| `pkg/tools/registry.go` | Register `ask_human` tool |
| `pkg/agent/instance.go` | Pass InterventionManager to agent |

**Estimated scope:** ~400 lines new code, ~50 lines modified

### Phase 2: Channel-Specific UX (P1)

| File | Change |
|------|--------|
| `pkg/channels/telegram/intervention.go` | Inline keyboard buttons for options |
| `pkg/channels/discord/intervention.go` | Discord components (buttons, select menus) |
| `pkg/channels/slack/intervention.go` | Slack Block Kit interactive elements |
| `pkg/commands/respond.go` | `/respond` command for cross-channel answers |

### Phase 3: Config-Driven Tool Approval (P2)

| File | Change |
|------|--------|
| `pkg/config/config.go` | Add `intervention` config block |
| `pkg/agent/loop.go` | Pre-tool-execution approval gate |
| `config/config.example.json` | Document intervention settings |

### Phase 4: Advanced Features (P3)

- **Intervention history dashboard** — view past questions/answers
- **Escalation chains** — if no response in N minutes, escalate to different channel
- **Batch approval** — "Approve all file writes for this session"
- **Intervention analytics** — what questions are asked most, average response time

---

## Design Decisions & Trade-offs

### Why block the goroutine instead of saving state and resuming?

**Blocking (chosen):**
- Simpler — the LLM iteration loop doesn't need to be refactored into a state machine
- Natural — the tool call looks like any other tool (just slower)
- Session state is already maintained in memory (the `messages` slice in `runLLMIteration`)
- The agent loop goroutine is already dedicated to one conversation turn

**State machine alternative (rejected for v1):**
- Would require serializing the full `messages` slice, iteration counter, model candidates, and routing state
- `runLLMIteration` would need to become resumable (complex refactor)
- Risk of state corruption on partial saves
- Can revisit in v2 if blocking goroutines become a resource concern

### Why not use the existing session for state?

Sessions track the *conversation history* (user/assistant/tool messages). The intervention state is *execution control flow* — which iteration we're on, what we're waiting for, when to expire. These are orthogonal concerns and should be separate.

### What happens if the bot restarts while blocked?

The `InterventionRequest` is persisted to disk immediately on creation. On restart:
1. Pending requests are loaded from `{workspace}/interventions/pending/`
2. Expired requests are moved to `expired/`
3. Still-valid requests re-register their waiters
4. **However**, the blocked goroutine is lost — the LLM iteration won't resume automatically

For v1, the behavior on restart is: the intervention request becomes "orphaned" — the human can still answer it, but the agent loop that was waiting is gone. The answer is persisted, and the next time the human sends a message in that session, the context will include the question+answer from the session history.

For v2, we could implement full state-machine resumption from persisted state.

### Concurrency: what if the human sends multiple messages while the agent is paused?

Only the **first** message is treated as the answer. Subsequent messages on the same channel+chatID while a pending intervention exists are queued normally and processed after the current agent turn completes.

Alternative: buffer additional messages and append to the answer (for multi-part responses). This could be a v2 feature.

---

## Configuration Example

```json
{
  "agents": {
    "defaults": {
      "intervention": {
        "enabled": true,
        "timeout_minutes": 30,
        "require_approval": [],
        "ask_human_tool": true
      }
    },
    "list": [
      {
        "id": "cautious-agent",
        "intervention": {
          "require_approval": ["exec", "write_file", "delete_file"],
          "timeout_minutes": 60
        }
      },
      {
        "id": "autonomous-agent",
        "intervention": {
          "enabled": false
        }
      }
    ]
  }
}
```

---

## Summary

This proposal adds human-in-the-loop capability through three mechanisms:

1. **`ask_human` tool** — The LLM decides when to ask (most flexible, lowest config)
2. **Message interception** — Replies in the same chat auto-correlate to pending questions
3. **Tool approval gates** — Config-driven mandatory approval before dangerous tools

The design leverages existing patterns (AsyncExecutor, session persistence, message metadata) and requires minimal changes to the core agent loop. The goroutine-blocking approach keeps the implementation simple while the file-based persistence ensures requests survive restarts.

The key insight is that the agent loop goroutine is already dedicated to processing a single turn — blocking it while waiting for human input is architecturally sound, since no other work needs that goroutine. The message bus continues consuming other messages on other sessions normally.
