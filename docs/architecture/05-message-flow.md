# Message Flow — Sequence Diagrams

End-to-end lifecycle of a single user message. Two scenarios are shown.

---

## Scenario 1 — Simple Message (no tool calls)

```mermaid
sequenceDiagram
  autonumber

  actor User
  participant Platform  as Chat Platform<br/>(e.g. Telegram)
  participant ChAdapter as Channel Adapter<br/>(pkg/channels)
  participant Bus       as MessageBus<br/>(inbound channel)
  participant AgentLoop as Agent Loop<br/>(pkg/agent)
  participant Router    as Router +<br/>Classifier
  participant CtxBld    as ContextBuilder
  participant Memory    as MemoryStore<br/>(JSONL)
  participant Provider  as LLM Provider<br/>(pkg/providers)
  participant OutBus    as MessageBus<br/>(outbound channel)

  User->>Platform: Sends message
  Platform->>ChAdapter: Webhook / poll event
  ChAdapter->>Bus: PublishInbound(InboundMessage)

  Bus->>AgentLoop: ConsumeInbound()
  AgentLoop->>AgentLoop: Resolve AgentInstance by channel/agent ID

  AgentLoop->>Router: SelectModel(msg, history, primaryModel)
  Router->>Router: ExtractFeatures() → score
  alt score < threshold (0.35)
    Router-->>AgentLoop: Use light model candidates
  else score >= threshold
    Router-->>AgentLoop: Use primary (heavy) model candidates
  end

  AgentLoop->>Memory: GetHistory(sessionKey)
  Memory-->>AgentLoop: []Message (conversation history)

  AgentLoop->>Memory: GetSummary(sessionKey)
  Memory-->>AgentLoop: summary string (may be empty)

  AgentLoop->>CtxBld: BuildSystemPrompt(workspace, skills, tools, summary)
  CtxBld-->>AgentLoop: system prompt string

  AgentLoop->>Provider: Complete(ctx, Request{messages, tools, model})
  Provider-->>AgentLoop: Response{content, usage}

  AgentLoop->>Memory: AddFullMessage(sessionKey, userMsg)
  AgentLoop->>Memory: AddFullMessage(sessionKey, assistantMsg)

  AgentLoop->>OutBus: PublishOutbound(OutboundMessage{channel, chatID, content})
  OutBus->>ChAdapter: SubscribeOutbound() → dispatch to channel worker
  ChAdapter->>Platform: Send response (rate-limited, with retry)
  Platform->>User: Delivers response
```

---

## Scenario 2 — Tool-Calling Message

```mermaid
sequenceDiagram
  autonumber

  actor User
  participant Platform  as Chat Platform
  participant ChAdapter as Channel Adapter
  participant Bus       as MessageBus (inbound)
  participant AgentLoop as Agent Loop
  participant Router    as Router + Classifier
  participant CtxBld    as ContextBuilder
  participant Memory    as MemoryStore
  participant Provider  as LLM Provider
  participant ToolLoop  as Tool Loop<br/>(pkg/tools/toolloop)
  participant Tool      as Tool<br/>(e.g. web_search / exec / read_file)
  participant MCPMgr    as MCP Manager<br/>(for MCP tools)
  participant OutBus    as MessageBus (outbound)

  User->>Platform: Sends message (complex query)
  Platform->>ChAdapter: Webhook event
  ChAdapter->>Bus: PublishInbound(InboundMessage)
  Bus->>AgentLoop: ConsumeInbound()

  AgentLoop->>Router: SelectModel() → heavy model (high complexity score)
  AgentLoop->>Memory: GetHistory(sessionKey)
  AgentLoop->>CtxBld: BuildSystemPrompt()
  CtxBld-->>AgentLoop: system prompt

  AgentLoop->>Provider: Complete(ctx, Request{messages, tools, model})
  Provider-->>AgentLoop: Response{tool_calls: [{name, args}]}

  loop Tool execution loop (up to MaxIterations = 20)
    AgentLoop->>ToolLoop: ExecuteToolCalls(tool_calls)

    alt Built-in tool
      ToolLoop->>Tool: Execute(ctx, args)
      Tool-->>ToolLoop: ToolResult{content}
    else MCP tool
      ToolLoop->>MCPMgr: CallTool(serverName, toolName, args)
      MCPMgr-->>ToolLoop: CallToolResult
    end

    ToolLoop-->>AgentLoop: tool results appended to messages

    AgentLoop->>Provider: Complete(ctx, updated Request with tool results)
    Provider-->>AgentLoop: Response

    alt Response has more tool_calls
      Note over AgentLoop,Provider: Continue loop
    else Response is final text
      Note over AgentLoop,Provider: Break loop
    end
  end

  AgentLoop->>Memory: AddFullMessage(sessionKey, userMsg)
  AgentLoop->>Memory: AddFullMessage(sessionKey, assistantMsg with tool history)

  AgentLoop->>OutBus: PublishOutbound(OutboundMessage)
  OutBus->>ChAdapter: Dispatch to channel worker
  ChAdapter->>Platform: Send response
  Platform->>User: Delivers response
```

---

## Optional Path A — Summarization Trigger

Fires when message count exceeds `SummarizeMessageThreshold` (default 20) or token usage
exceeds `SummarizeTokenPercent` (default 75%) of the context window.

```mermaid
sequenceDiagram
  participant AgentLoop as Agent Loop
  participant Memory    as MemoryStore
  participant Provider  as LLM Provider

  Note over AgentLoop: After processing a message turn
  AgentLoop->>Memory: GetHistory(sessionKey)
  Memory-->>AgentLoop: history (len > threshold)

  AgentLoop->>Provider: Complete(ctx, summarize_prompt + history)
  Provider-->>AgentLoop: summary text

  AgentLoop->>Memory: SetSummary(sessionKey, summary)
  AgentLoop->>Memory: TruncateHistory(sessionKey, keepLast=5)
  AgentLoop->>Memory: Compact(sessionKey)

  Note over AgentLoop: Next turn uses summary in system prompt<br/>instead of full history
```

---

## Optional Path B — Cron-Triggered Agent Invocation

```mermaid
sequenceDiagram
  participant CronScheduler as Cron Scheduler<br/>(pkg/cron)
  participant AgentLoop     as Agent Loop
  participant Memory        as MemoryStore
  participant Provider      as LLM Provider
  participant Bus           as MessageBus (outbound)
  participant ChAdapter     as Channel Adapter

  CronScheduler->>CronScheduler: Tick fires for scheduled job
  CronScheduler->>AgentLoop: ProcessMessage(ctx, InboundMessage{<br/>  channel: "cron",<br/>  content: job_prompt,<br/>  sessionKey: cron_session_key<br/>})

  AgentLoop->>Memory: GetHistory(cron_session_key)
  AgentLoop->>Provider: Complete(ctx, Request)
  Provider-->>AgentLoop: Response

  AgentLoop->>Memory: AddFullMessage(cron_session_key, ...)
  AgentLoop->>Bus: PublishOutbound(OutboundMessage{<br/>  channel: target_channel,<br/>  chatID: target_chat_id<br/>})

  Bus->>ChAdapter: Dispatch
  ChAdapter->>ChAdapter: Send to configured target channel
```
