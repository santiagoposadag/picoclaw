# PicoClaw Architecture Documentation

PicoClaw is an ultra-lightweight personal AI assistant written in Go, designed to run on minimal
hardware (including embedded systems like MaixCam). It bridges 13+ chat platforms to multiple LLM
providers through an async message bus, with a configurable agent loop that supports tool execution,
skill loading, model routing, and persistent memory.

## Diagrams

| File | Diagram Type | Description |
|------|-------------|-------------|
| [01-system-context.md](01-system-context.md) | C4 Level 1 — Context | PicoClaw as a black box: who uses it and what external systems it touches |
| [02-containers.md](02-containers.md) | C4 Level 2 — Containers | Major deployable units and runtimes inside PicoClaw |
| [03-components.md](03-components.md) | C4 Level 3 — Components | Internal structure of the Agent Loop and Provider Layer |
| [04-architecture-overview.md](04-architecture-overview.md) | Layered Architecture | Technology layers top-to-bottom, plus a Docker deployment diagram |
| [05-message-flow.md](05-message-flow.md) | Sequence Diagram | End-to-end lifecycle of a user message (simple and tool-calling paths) |

## Rendering

All diagrams use [Mermaid](https://mermaid.js.org/). To view them:

- **GitHub** — renders automatically in `.md` files
- **VS Code** — install the [Mermaid Preview](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) extension
- **Browser** — paste any diagram block at [mermaid.live](https://mermaid.live)

> C4 diagrams (`C4Context`, `C4Container`) require Mermaid v10.3 or later.
