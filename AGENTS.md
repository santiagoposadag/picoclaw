# AGENTS.md - PicoClaw Development Guidelines

PicoClaw is an ultra-lightweight personal AI assistant written in Go 1.25+.
Target: <10MB RAM, 1-second boot on $10 hardware. Every change must respect these constraints.

## Build, Test, and Lint Commands

```bash
# Dependencies
make deps              # Download and verify dependencies

# Build
make build             # Build for current platform (output: build/picoclaw)
make build-all         # Build for all supported platforms
go generate ./...      # Run code generation (required before build)

# Test
make test              # Run all tests
go test ./...          # Run all tests (alternative)
go test ./pkg/tools/...                    # Run tests for a specific package
go test -run TestName ./...                # Run a single test by name
go test -run TestCooldown_StandardEscalation ./pkg/providers/...  # Run specific test in package
go test -v ./pkg/tools/...                 # Verbose output
go test -race ./...                        # Run with race detector

# Lint and Format
make fmt               # Format code with gofmt
make vet               # Run go vet static analysis
golangci-lint run      # Run full linter suite (golangci-lint v2)
make check             # Run deps + fmt + vet + test

# Run
make run ARGS="--config config.json"  # Build and run with arguments
make install           # Install to ~/.local/bin
```

## Code Style Guidelines

### Imports

Organize imports in three groups separated by blank lines:
1. Standard library
2. External dependencies
3. Local module (`github.com/sipeed/picoclaw/...`)

```go
import (
    "context"
    "fmt"
    "sync"

    "github.com/stretchr/testify/assert"

    "github.com/sipeed/picoclaw/pkg/logger"
    "github.com/sipeed/picoclaw/pkg/tools"
)
```

### Naming Conventions

- **Packages**: lowercase, single-word (`agent`, `tools`, `providers`)
- **Exported types**: PascalCase (`AgentLoop`, `ToolResult`, `LLMProvider`)
- **Unexported types**: camelCase (`processOptions`, `errorPattern`)
- **Constants**: PascalCase for exported, camelCase for unexported
- **Interfaces**: verb-noun or noun (`Tool`, `LLMProvider`, `ContextualTool`)

### Error Handling

Always wrap errors with context using `%w`:

```go
if err != nil {
    return fmt.Errorf("failed to resolve workspace path: %w", err)
}
```

For provider errors, use `FailoverError` with classification:

```go
return &FailoverError{
    Reason:   FailoverRateLimit,
    Provider: "openai",
    Model:    model,
    Wrapped:  err,
}
```

For tool errors, use `ToolResult` with `IsError: true`:

```go
return ErrorResult("file not found: " + path).WithError(err)
```

### Logging

Use component-based structured logging via `pkg/logger`:

```go
logger.InfoCF("agent", "Processing message", map[string]interface{}{
    "session": sessionKey,
    "user":    userID,
})
logger.ErrorCF("tool", "Execution failed", map[string]interface{}{
    "tool": name,
    "err":  err.Error(),
})
```

Components: `"agent"`, `"tool"`, `"provider"`, `"channel"`, `"auth"`, `"config"`

### Concurrency

- Use pointer receivers for methods that mutate state
- Protect shared state with `sync.RWMutex`
- Use `sync.Map` for concurrent map access
- Pass `context.Context` as first parameter

```go
type AgentLoop struct {
    mu       sync.RWMutex
    running  atomic.Bool
    sessions sync.Map
}

func (a *AgentLoop) Stop() {
    a.mu.Lock()
    defer a.mu.Unlock()
    a.running.Store(false)
}
```

## Architecture

**Core flow**: `Channel → Bus → AgentLoop → Provider → Tools → Results → Bus → Channel`

### Key Packages

| Package | Purpose |
|---------|---------|
| `pkg/agent/` | Agent loop, instance management, context building |
| `pkg/providers/` | LLM provider interface, fallback chains, error classification |
| `pkg/tools/` | Tool interface, registry, filesystem/shell/web tools |
| `pkg/channels/` | Chat platform integrations (Telegram, Discord, Slack, etc.) |
| `pkg/bus/` | Thread-safe message bus connecting channels to agents |
| `pkg/routing/` | Multi-agent session routing with priority cascade |
| `pkg/config/` | Configuration loading/validation |
| `pkg/logger/` | Structured component-based logging |

### Implementing Tools

Tools must implement the `Tool` interface:

```go
type Tool interface {
    Name() string
    Description() string
    Parameters() map[string]interface{}
    Execute(ctx context.Context, args map[string]interface{}) *ToolResult
}
```

Return appropriate result types:
- `NewToolResult(msg)` - Basic result for LLM
- `SilentResult(msg)` - No user message (file ops, status updates)
- `ErrorResult(msg)` - Error with `IsError: true`
- `UserResult(msg)` - Content shown to both LLM and user
- `AsyncResult(msg)` - Long-running background operations

## Testing Conventions

Use table-driven tests with descriptive names:

```go
func TestToolResult_Serialization(t *testing.T) {
    tests := []struct {
        name   string
        result *ToolResult
        want   string
    }{
        {"basic result", NewToolResult("content"), "content"},
        {"error result", ErrorResult("failed"), "failed"},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := tt.result.ForLLM; got != tt.want {
                t.Errorf("ForLLM = %v, want %v", got, tt.want)
            }
        })
    }
}
```

- Use `os.MkdirTemp` for filesystem tests
- Mock providers for unit tests (see `pkg/providers/*_test.go`)
- Integration tests use `_integration_test.go` suffix

## Security Constraints

- **Path validation**: All file operations must use `validatePath()` to restrict access to workspace
- **Tool permissions**: Exec tool disabled by default (`allow_dangerous_operations` config)
- **OAuth tokens**: Stored in `~/.picoclaw/credentials.json` with restricted permissions
- **Channel allowlists**: `BaseChannel` filters users/guilds before processing

## Key File References

- Entry point: `cmd/picoclaw/main.go`
- Agent loop: `pkg/agent/loop.go`
- Tool interface: `pkg/tools/base.go`
- Tool results: `pkg/tools/result.go`
- Provider interface: `pkg/providers/types.go`
- Error classification: `pkg/providers/error_classifier.go`
- Fallback logic: `pkg/providers/fallback.go`
- Config example: `config/config.example.json`
- Workspace templates: `workspace/` (embedded via `//go:embed`)
