# Getting Started with PicoClaw

> A step-by-step guide to building, configuring, and running PicoClaw for the
> first time. Aimed at developers who are new to the project and may be unfamiliar
> with Go tooling or `make`.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [What is `make`?](#2-what-is-make)
3. [Build the Binary](#3-build-the-binary)
4. [Configure a Model Provider](#4-configure-a-model-provider)
   - [Option A: Google Gemini API (API key)](#option-a-google-gemini-api-api-key)
   - [Option B: Google Antigravity (free OAuth)](#option-b-google-antigravity-free-oauth)
5. [Run the Agent](#5-run-the-agent)
6. [Understanding the Debug Output](#6-understanding-the-debug-output)
7. [CLI Commands Reference](#7-cli-commands-reference)
8. [Makefile Targets Reference](#8-makefile-targets-reference)

---

## 1. Prerequisites

Before building, make sure the following are installed:

| Tool | Purpose | Check |
|------|---------|-------|
| **Go 1.21+** | Compiles the Go source code | `go version` |
| **git** | Required by the build to embed version info | `git --version` |
| **make** | Runs build scripts (explained below) | `make --version` |

To install Go: https://go.dev/dl/

---

## 2. What is `make`?

`make` is a standard Unix build tool. A `Makefile` is a recipe file that defines
named **targets** — each target is a named shortcut for one or more shell commands.

Instead of remembering and typing long commands like:

```bash
CGO_ENABLED=0 go build -v -tags stdjson \
  -ldflags "-X .../config.Version=$(git describe) ..." \
  -o build/picoclaw ./cmd/picoclaw
```

You just type:

```bash
make build
```

`make` reads the `Makefile` in the current directory and runs the commands for
the target you specified. Targets can also depend on other targets — for example,
`make build` first runs `make generate` automatically before compiling.

To see all available targets in this project:

```bash
make help
```

---

## 3. Build the Binary

From the project root:

```bash
# Download Go module dependencies (first time only)
make deps

# Compile the binary for your current platform
make build
```

What this does step by step:

1. **`make deps`** — runs `go mod download` + `go mod verify`. Downloads all
   third-party Go packages listed in `go.mod` into the local module cache.

2. **`make build`** — first runs `make generate` (which regenerates any
   auto-generated Go files), then compiles the binary. The output goes to:

   ```
   build/picoclaw-<os>-<arch>   # e.g. build/picoclaw-linux-amd64
   build/picoclaw               # symlink pointing to the above
   ```

After a successful build, verify it works:

```bash
./build/picoclaw version
```

### Optional: install system-wide

```bash
make install
```

This copies the binary to `~/.local/bin/picoclaw` so you can run `picoclaw`
from anywhere (as long as `~/.local/bin` is in your `$PATH`).

---

## 4. Configure a Model Provider

PicoClaw needs an LLM (AI model) to power the agent. Configuration lives in
`~/.picoclaw/config.json`. Create the directory first:

```bash
mkdir -p ~/.picoclaw
```

### Option A: Google Gemini API (API key)

This is the straightforward path. You get a Gemini API key from Google AI Studio
and put it in the config.

**Step 1 — Get an API key:**
Go to https://aistudio.google.com → click "Get API key" → create a key.
The free tier is sufficient for testing.

**Step 2 — Create `~/.picoclaw/config.json`:**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.picoclaw/workspace",
      "model_name": "gemini-best",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20
    }
  },
  "model_list": [
    {
      "model_name": "gemini-best",
      "model": "gemini/gemini-2.5-pro",
      "api_key": "AIza-YOUR-KEY-HERE"
    }
  ]
}
```

**How the config is interpreted:**

- `agents.defaults.model_name` — the name PicoClaw looks up in `model_list`.
- `model_list[].model` — the **protocol/model-id** string. The prefix before `/`
  tells PicoClaw which provider driver to use:
  - `gemini/` → direct Google Gemini API (`generativelanguage.googleapis.com`)
  - `anthropic/` → Anthropic Claude API
  - `openai/` → OpenAI API
  - `antigravity/` → Google Cloud Code Assist (OAuth, no key needed)
- `api_key` — the key sent in the `Authorization: Bearer` header.
- `api_base` — optional; each protocol has a built-in default, so you only
  need this if you're pointing at a proxy or custom endpoint.

**Available Gemini models:**

| Model ID | Notes |
|---|---|
| `gemini/gemini-2.5-pro` | Best reasoning, highest quality |
| `gemini/gemini-2.0-flash` | Fast and cheap, very capable |
| `gemini/gemini-2.0-flash-thinking-exp` | Flash with extended thinking mode |
| `gemini/gemini-1.5-pro` | Previous generation, large context |

---

### Option B: Google Antigravity (free OAuth)

This uses Google's **Cloud Code Assist** internal API — the same backend that
powers Gemini Code Assist inside VS Code. It is free and requires no API key,
but requires a one-time OAuth login.

**Step 1 — Login:**

```bash
./build/picoclaw auth login --provider google-antigravity
```

This opens a browser tab. Sign in with your Google account. The OAuth token is
saved to `~/.picoclaw/credentials.json`.

**Step 2 — Create `~/.picoclaw/config.json`:**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.picoclaw/workspace",
      "model_name": "gemini-free",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20
    }
  },
  "model_list": [
    {
      "model_name": "gemini-free",
      "model": "antigravity/gemini-3-flash"
    }
  ]
}
```

No `api_key` field needed — the `antigravity/` prefix tells PicoClaw to use the
`AntigravityProvider`, which reads the OAuth token from `~/.picoclaw/credentials.json`
automatically and refreshes it when it expires.

---

## 5. Run the Agent

### Send a single message (non-interactive)

```bash
./build/picoclaw agent -m "Hello, what tools do you have?"
```

### Interactive REPL (type messages back and forth)

```bash
./build/picoclaw agent
```

### Debug mode — see every step the agent takes

```bash
./build/picoclaw agent -d -m "Create a file called hello.txt in your workspace"
```

The `-d` flag enables debug logging. This is the most useful flag when learning
how the agent works — it prints each LLM call, every tool invocation, tool
results, and the final response.

### Keep a session across multiple invocations

```bash
./build/picoclaw agent -s my-session -m "Remember that my name is Santiago"
./build/picoclaw agent -s my-session -m "What is my name?"
```

The `-s` flag sets a session key. Conversation history for that key is stored in
`~/.picoclaw/workspace/sessions/` and replayed on each call.

---

## 6. Understanding the Debug Output

When you run with `-d`, you will see output like this:

```
[agent] Starting session cli:default
[provider.gemini] Chat  model=gemini-2.5-pro messages=2
[agent] LLM response  finish_reason=tool_calls tool_calls=1
[tools] Executing write_file  path=hello.txt
[tools] write_file result  success=true
[provider.gemini] Chat  model=gemini-2.5-pro messages=4
[agent] LLM response  finish_reason=stop
```

What each line means:

| Line | What is happening |
|------|------------------|
| `Starting session` | The AgentLoop picks up the message from the bus |
| `provider.gemini Chat messages=2` | First LLM call: system prompt + user message |
| `finish_reason=tool_calls` | The model decided to call a tool instead of answering directly |
| `Executing write_file` | The AgentLoop calls the `write_file` tool |
| `write_file result` | Tool finished, result will be fed back to the model |
| `provider.gemini Chat messages=4` | Second LLM call: original messages + tool call + tool result |
| `finish_reason=stop` | Model produced a final answer — the loop ends |

This cycle — **LLM → tool call → result → LLM → ...** — is the agent's
think-act loop. `max_tool_iterations` in the config caps how many tool calls
it can make per message.

---

## 7. CLI Commands Reference

```
picoclaw agent      Interact with the AI agent directly
picoclaw gateway    Start the bot gateway (connects to Telegram, Discord, etc.)
picoclaw auth       Manage OAuth logins (Google, Anthropic, OpenAI)
picoclaw onboard    Interactive setup wizard
picoclaw cron       Manage scheduled tasks
picoclaw skills     Install / manage community skill plugins
picoclaw status     Show current configuration and workspace info
picoclaw model      List and test configured models
picoclaw version    Show build version, git commit, and Go version
```

### `picoclaw agent` flags

| Flag | Short | Description |
|------|-------|-------------|
| `--message` | `-m` | Send a single message (non-interactive mode) |
| `--session` | `-s` | Session key for conversation history (default: `cli:default`) |
| `--model` | | Override the configured model for this run |
| `--debug` | `-d` | Enable verbose debug logging |

---

## 8. Makefile Targets Reference

Run `make help` at any time to print this list from the Makefile itself.

| Target | What it does |
|--------|-------------|
| `make deps` | Downloads and verifies Go module dependencies (`go mod download`) |
| `make generate` | Runs `go generate ./...` to regenerate any auto-generated files |
| `make build` | Compiles the binary for your current OS and CPU architecture |
| `make build-all` | Cross-compiles for all supported platforms (Linux x86/ARM/MIPS/RISC-V, macOS, Windows, NetBSD) |
| `make build-linux-arm64` | Compiles specifically for Linux ARM64 (e.g. Raspberry Pi 4, 64-bit) |
| `make build-linux-arm` | Compiles for Linux ARMv7 (e.g. Raspberry Pi Zero 2 W, 32-bit) |
| `make build-pi-zero` | Shortcut that runs both `build-linux-arm` and `build-linux-arm64` |
| `make build-linux-mipsle` | Compiles for MIPS32 LE (e.g. cheap routers, Ingenic SoCs) |
| `make install` | Builds then copies the binary to `~/.local/bin/picoclaw` |
| `make uninstall` | Removes the binary from `~/.local/bin/` |
| `make uninstall-all` | Removes the binary **and** deletes `~/.picoclaw/` (all config and data) |
| `make clean` | Deletes the `build/` directory |
| `make test` | Runs the Go test suite (`go test ./...`) |
| `make fmt` | Formats all Go source files via `golangci-lint fmt` |
| `make vet` | Runs `go vet` for static analysis (catches common bugs) |
| `make lint` | Runs the full `golangci-lint` linter suite |
| `make fix` | Runs `golangci-lint --fix` to auto-fix linting issues |
| `make check` | Runs `deps + fmt + vet + test` — full validation before committing |
| `make run ARGS="..."` | Builds then immediately runs with the given arguments (e.g. `make run ARGS="-m hello"`) |
| `make docker-build` | Builds a minimal Alpine-based Docker image |
| `make docker-build-full` | Builds a full Docker image with Node.js 24 (for MCP tool support) |
| `make docker-run` | Starts the gateway in Docker (minimal image) |
| `make docker-run-agent` | Runs the agent interactively in Docker |
| `make help` | Prints all targets with descriptions |

### Why does `make build` always run `make generate` first?

`go generate` processes special `//go:generate` comments in the source to produce
Go files from templates or external tools. If these generated files are stale or
missing, the build will fail. Making `generate` a prerequisite of `build` ensures
you never accidentally compile against outdated generated code.
