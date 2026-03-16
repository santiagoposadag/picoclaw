# PicoClaw + NVIDIA NIM: Build Your Personal AI Workforce

> A practical guide to building a multi-agent personal assistant system using PicoClaw and free LLM APIs — optimized for budget-conscious deployment.

---

## Table of Contents

1. [Overview](#overview)
2. [What You're Building](#what-youre-building)
3. [Prerequisites](#prerequisites)
4. [Step 1: Install PicoClaw](#step-1-install-picoclaw)
5. [Step 2: Get Your Free API Keys](#step-2-get-your-free-api-keys)
6. [Step 3: Configure NVIDIA NIM as Primary Provider](#step-3-configure-nvidia-nim-as-primary-provider)
7. [Step 4: Set Up Multi-Agent Workforce](#step-4-set-up-multi-agent-workforce)
8. [Step 5: Configure Fallback Providers](#step-5-configure-fallback-providers)
9. [Step 6: Add Communication Channels](#step-6-add-communication-channels)
10. [Step 7: Enable Web Search and Tools](#step-7-enable-web-search-and-tools)
11. [Complete config.json Reference](#complete-configjson-reference)
12. [Recommended Free NVIDIA NIM Models](#recommended-free-nvidia-nim-models)
13. [All Free & Budget Provider Reference](#all-free--budget-provider-reference)
14. [Multi-Agent Workforce Architecture](#multi-agent-workforce-architecture)
15. [Cost Estimation](#cost-estimation)
16. [Troubleshooting](#troubleshooting)
17. [Next Steps](#next-steps)

---

## Overview

**PicoClaw** is an ultra-lightweight AI agent framework written in Go by Sipeed. It compiles to a single binary, uses under 10MB of RAM, boots in under 1 second, and runs on hardware as cheap as a $10 RISC-V board. It connects to external LLM providers via API keys configured in a local `config.json` file.

**NVIDIA NIM** provides free GPU-accelerated API endpoints for dozens of frontier AI models at `build.nvidia.com`. The free tier offers 40 requests per minute with no credit card required and an OpenAI-compatible API, making it a perfect primary provider for PicoClaw.

By combining these two, you can build a **workforce of specialized AI agents** — each with its own role, model, and fallback chain — running 24/7 on minimal hardware for nearly zero cost.

---

## What You're Building

```
You (Telegram / Discord / CLI / WhatsApp)
    │
    ▼
PicoClaw Gateway (your VPS, SBC, or old phone)
    │
    ├── Agent 1: Orchestrator ──► NVIDIA NIM (Nemotron 3 Super 120B)
    │                              └─ fallback: Cerebras → OpenRouter
    │
    ├── Agent 2: Coder ─────────► NVIDIA NIM (DeepSeek V3.2)
    │                              └─ fallback: Groq (Llama 3.3 70B)
    │
    ├── Agent 3: Researcher ────► NVIDIA NIM (MiniMax M2.5)
    │                              └─ fallback: Mistral → Google AI Studio
    │
    ├── Agent 4: Vision ────────► NVIDIA NIM (Qwen 3.5 VLM)
    │                              └─ fallback: OpenRouter
    │
    └── Tools: web search, file access, shell, cron, memory
```

**Estimated monthly cost: $0–10 using free tiers only.**

---

## Prerequisites

- A Linux machine (VPS, Raspberry Pi, old Android phone with Termux, or any SBC)
- Internet connection
- 10 minutes of setup time

**Minimum hardware:**

| Platform | Cost | Notes |
|---|---|---|
| Old Android phone + Termux | $0 | Recycle any phone running Android 7+ |
| Raspberry Pi Zero 2 W | ~$15 | ARM64, perfect for PicoClaw |
| Hetzner VPS (CX22) | ~$4/mo | If you need 24/7 uptime without hardware |
| RISC-V MaixCAM / LicheeRV Nano | ~$10 | What PicoClaw was literally designed for |

---

## Step 1: Install PicoClaw

### Option A: Download Prebuilt Binary (Recommended)

```bash
# Detect your architecture
ARCH=$(uname -m)

# Download the latest release (replace v0.1.1 with latest from GitHub Releases)
# For x86_64:
wget https://github.com/sipeed/picoclaw/releases/download/v0.1.1/picoclaw-linux-amd64

# For ARM64 (Raspberry Pi, most phones):
wget https://github.com/sipeed/picoclaw/releases/download/v0.1.1/picoclaw-linux-arm64

# For RISC-V:
wget https://github.com/sipeed/picoclaw/releases/download/v0.1.1/picoclaw-linux-riscv64

# Make executable and move to PATH
chmod +x picoclaw-linux-*
sudo mv picoclaw-linux-* /usr/local/bin/picoclaw
```

### Option B: Build from Source

```bash
# Requires Go 1.21+
git clone https://github.com/sipeed/picoclaw.git
cd picoclaw
go build -o picoclaw .
sudo mv picoclaw /usr/local/bin/
```

### Option C: Termux on Android

```bash
pkg install proot wget
wget https://github.com/sipeed/picoclaw/releases/download/v0.1.1/picoclaw-linux-arm64
chmod +x picoclaw-linux-arm64
termux-chroot
./picoclaw-linux-arm64
```

### Verify Installation

```bash
picoclaw --version
```

---

## Step 2: Get Your Free API Keys

You'll need API keys from multiple providers to build a robust workforce with fallbacks. Here's where to get each one:

### Required: NVIDIA NIM (Primary Provider)

1. Go to [build.nvidia.com](https://build.nvidia.com)
2. Click **Sign In** → enter your email → create an account
3. Verify your phone number (takes ~1 minute)
4. Go to your **Profile → API Keys → Generate**
5. Copy and save your key (format: `nvapi-xxxx...`)

> **Free tier:** 40 requests/minute, no credit card required.

### Recommended: Fallback Providers

| Provider | Signup URL | Free Tier | Key Format |
|---|---|---|---|
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | 40 req/min, varies by model | `gsk_xxxx` |
| **Cerebras** | [cloud.cerebras.ai](https://cloud.cerebras.ai) | 30 RPM, 1M tokens/day | Standard key |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | 50 req/day (1000 with $10 top-up) | `sk-or-xxxx` |
| **Mistral** | [console.mistral.ai](https://console.mistral.ai) | 1B tokens/month | Standard key |
| **Google AI Studio** | [aistudio.google.com](https://aistudio.google.com) | Generous free tier | Standard key |

### Optional: Web Search

| Provider | Signup URL | Free Tier |
|---|---|---|
| **Tavily** | [tavily.com](https://tavily.com) | 1,000 queries/month |
| **Brave Search** | [brave.com/search/api](https://brave.com/search/api/) | 2,000 queries/month |
| **DuckDuckGo** | No key needed | Unlimited (built into PicoClaw) |

---

## Step 3: Configure NVIDIA NIM as Primary Provider

Create the configuration directory and file:

```bash
mkdir -p ~/.picoclaw
nano ~/.picoclaw/config.json
```

Start with this minimal configuration to test NVIDIA NIM:

```json
{
  "agents": {
    "defaults": {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20
    }
  },
  "providers": {
    "nvidia": {
      "api_key": "nvapi-YOUR_KEY_HERE",
      "api_base": "https://integrate.api.nvidia.com/v1"
    }
  }
}
```

### Test It

```bash
picoclaw agent
```

Type a message and confirm you get a response from NVIDIA NIM. Press `Ctrl+C` to exit.

> **How NVIDIA NIM works with PicoClaw:** PicoClaw uses the OpenAI-compatible protocol. NVIDIA NIM exposes the same `/v1/chat/completions` endpoint format, so PicoClaw connects natively — no custom code needed. You specify models using the `vendor/model-name` format.

---

## Step 4: Set Up Multi-Agent Workforce

PicoClaw's model-centric configuration lets you assign different models (and different providers) to different agents. Each agent can have its own fallback chain.

### Agent Roles Explained

| Agent | Role | Best Model | Why |
|---|---|---|---|
| **Orchestrator** | Main brain, routes tasks, reasons | Nemotron 3 Super 120B | 12B active MoE, built for agentic reasoning and tool use |
| **Coder** | Code generation, debugging | DeepSeek V3.2 | Frontier-class coding, available free on NIM |
| **Researcher** | Document analysis, web research | MiniMax M2.5 | 1M context window, 230B MoE with only 10B active |
| **Vision** | Image/document understanding | Qwen 3.5 VLM | 400B native multimodal VLM, free on NIM |

### Multi-Agent Configuration

Update your `config.json` to define the workforce:

```json
{
  "agents": {
    "defaults": {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20,
      "restrict_to_workspace": true
    },
    "list": [
      {
        "id": "orchestrator",
        "default": true,
        "name": "Orchestrator",
        "model": {
          "name": "nvidia/nemotron-3-super-120b-a12b",
          "fallbacks": [
            "cerebras/llama-3.3-70b",
            "openrouter/deepseek/deepseek-chat-v3-0324:free"
          ]
        }
      },
      {
        "id": "coder",
        "name": "Coder",
        "model": {
          "name": "nvidia/deepseek-ai/deepseek-v3.2",
          "fallbacks": [
            "groq/llama-3.3-70b-versatile",
            "mistral/codestral-latest"
          ]
        }
      },
      {
        "id": "researcher",
        "name": "Researcher",
        "model": {
          "name": "nvidia/minimax/minimax-m2.5",
          "fallbacks": [
            "mistral/mistral-small-latest",
            "google/gemini-2.0-flash"
          ]
        }
      },
      {
        "id": "vision",
        "name": "Vision",
        "model": {
          "name": "nvidia/qwen/qwen3.5-vl-400b",
          "fallbacks": [
            "openrouter/qwen/qwen-2.5-vl-72b-instruct:free"
          ]
        }
      }
    ]
  }
}
```

> **How fallbacks work:** If the primary model fails (rate limit, downtime, etc.), PicoClaw automatically tries the next model in the `fallbacks` array. This happens transparently — you don't even notice.

---

## Step 5: Configure Fallback Providers

Add all your provider API keys. PicoClaw auto-detects which provider to use based on the model name prefix:

```json
{
  "providers": {
    "nvidia": {
      "api_key": "nvapi-YOUR_NVIDIA_KEY",
      "api_base": "https://integrate.api.nvidia.com/v1"
    },
    "groq": {
      "api_key": "gsk_YOUR_GROQ_KEY"
    },
    "cerebras": {
      "api_key": "YOUR_CEREBRAS_KEY",
      "api_base": "https://api.cerebras.ai/v1"
    },
    "openrouter": {
      "api_key": "sk-or-YOUR_OPENROUTER_KEY"
    },
    "mistral": {
      "api_key": "YOUR_MISTRAL_KEY"
    },
    "google": {
      "api_key": "YOUR_GOOGLE_AI_KEY"
    }
  }
}
```

### Provider Selection Priority

PicoClaw selects the provider by parsing the model string's prefix:

- `nvidia/...` → uses the `nvidia` provider config
- `groq/...` → uses the `groq` provider config
- `openrouter/...` → uses the `openrouter` provider config
- `mistral/...` → uses the `mistral` provider config
- and so on

If no prefix matches, PicoClaw falls back to auto-detection based on which API keys are present.

---

## Step 6: Add Communication Channels

Choose one or more chat platforms to interact with your agents.

### Telegram (Recommended for Mobile)

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
      "allow_from": ["YOUR_TELEGRAM_USER_ID"]
    }
  }
}
```

> **Find your Telegram user ID:** Message [@userinfobot](https://t.me/userinfobot) on Telegram.

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot → copy the token
3. Invite the bot to your server

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "YOUR_DISCORD_BOT_TOKEN",
      "allow_from": ["YOUR_DISCORD_USER_ID"]
    }
  }
}
```

### CLI Only (Simplest)

No channel configuration needed. Just run:

```bash
picoclaw agent
```

---

## Step 7: Enable Web Search and Tools

Give your agents the ability to search the web, run commands, and manage files:

```json
{
  "tools": {
    "web_search": {
      "provider": "duckduckgo"
    },
    "tavily": {
      "api_key": "tvly-YOUR_TAVILY_KEY"
    },
    "brave_search": {
      "api_key": "YOUR_BRAVE_KEY"
    },
    "exec": {
      "enabled": true
    },
    "file": {
      "enabled": true
    }
  }
}
```

> **DuckDuckGo** works without an API key and is unlimited. Start with it, then add Tavily (1,000 free queries/month) or Brave (2,000 free queries/month) for better results.

---

## Complete config.json Reference

Here's the full configuration bringing everything together:

```json
{
  "agents": {
    "defaults": {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "max_tokens": 8192,
      "temperature": 0.7,
      "max_tool_iterations": 20,
      "restrict_to_workspace": true,
      "workspace": "~/.picoclaw/workspace"
    },
    "list": [
      {
        "id": "orchestrator",
        "default": true,
        "name": "Orchestrator",
        "model": {
          "name": "nvidia/nemotron-3-super-120b-a12b",
          "fallbacks": [
            "cerebras/llama-3.3-70b",
            "openrouter/deepseek/deepseek-chat-v3-0324:free"
          ]
        }
      },
      {
        "id": "coder",
        "name": "Coder",
        "model": {
          "name": "nvidia/deepseek-ai/deepseek-v3.2",
          "fallbacks": [
            "groq/llama-3.3-70b-versatile",
            "mistral/codestral-latest"
          ]
        }
      },
      {
        "id": "researcher",
        "name": "Researcher",
        "model": {
          "name": "nvidia/minimax/minimax-m2.5",
          "fallbacks": [
            "mistral/mistral-small-latest",
            "google/gemini-2.0-flash"
          ]
        }
      },
      {
        "id": "vision",
        "name": "Vision",
        "model": {
          "name": "nvidia/qwen/qwen3.5-vl-400b",
          "fallbacks": [
            "openrouter/qwen/qwen-2.5-vl-72b-instruct:free"
          ]
        }
      }
    ]
  },
  "providers": {
    "nvidia": {
      "api_key": "nvapi-YOUR_NVIDIA_KEY",
      "api_base": "https://integrate.api.nvidia.com/v1"
    },
    "groq": {
      "api_key": "gsk_YOUR_GROQ_KEY"
    },
    "cerebras": {
      "api_key": "YOUR_CEREBRAS_KEY",
      "api_base": "https://api.cerebras.ai/v1"
    },
    "openrouter": {
      "api_key": "sk-or-YOUR_OPENROUTER_KEY"
    },
    "mistral": {
      "api_key": "YOUR_MISTRAL_KEY"
    },
    "google": {
      "api_key": "YOUR_GOOGLE_AI_KEY"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_TELEGRAM_BOT_TOKEN",
      "allow_from": ["YOUR_TELEGRAM_USER_ID"]
    },
    "discord": {
      "enabled": false,
      "token": "",
      "allow_from": []
    }
  },
  "tools": {
    "web_search": {
      "provider": "duckduckgo"
    },
    "tavily": {
      "api_key": ""
    },
    "brave_search": {
      "api_key": ""
    },
    "exec": {
      "enabled": true
    },
    "file": {
      "enabled": true
    }
  }
}
```

---

## Recommended Free NVIDIA NIM Models

These are all available at `https://integrate.api.nvidia.com/v1` with your free NVIDIA API key.

### Large Language Models

| Model | NIM Model String | Active Params | Best For | Context |
|---|---|---|---|---|
| **Nemotron 3 Super 120B** | `nvidia/nemotron-3-super-120b-a12b` | 12B (MoE) | Agentic reasoning, orchestration, tool use | Large |
| **DeepSeek V3.2** | `nvidia/deepseek-ai/deepseek-v3.2` | MoE | Coding, reasoning, debugging | Large |
| **MiniMax M2.5** | `nvidia/minimax/minimax-m2.5` | 10B (MoE) | Long docs, coding (SWE-Bench 80.2%) | 1M tokens |
| **GLM-4.7** | `nvidia/zhipu/glm-4.7` | — | Multilingual agentic coding, tool use | Large |
| **Kimi K2.5 Instruct** | `nvidia/moonshotai/kimi-k2-instruct` | — | Strong reasoning, complex tasks | Large |
| **GLM-5 744B** | `nvidia/zhipu/glm-5` | MoE | Complex systems reasoning, long-horizon tasks | Large |
| **Llama 3.1 8B Instruct** | `nvidia/meta/llama-3.1-8b-instruct` | 8B | Fast, lightweight tasks | 128K |

### Vision & Multimodal

| Model | NIM Model String | Best For |
|---|---|---|
| **Qwen 3.5 VLM 400B** | `nvidia/qwen/qwen3.5-vl-400b` | Image understanding, document analysis, agentic vision |

### Specialized

| Model | NIM Model String | Best For |
|---|---|---|
| **NVIDIA DeepSeek R1 FP4** | `nvidia/deepseek-r1` | Deep reasoning (quantized for speed) |
| **GLiNER PII** | (check build.nvidia.com) | Personally identifiable information detection |
| **NV-Embed** | (check build.nvidia.com) | Multilingual embedding for RAG, 26 languages |

> **Important:** Model availability on the free tier can change. Always check [build.nvidia.com/models](https://build.nvidia.com/models) for the current list. Filter by "Preview" to see free-tier models.

---

## All Free & Budget Provider Reference

### Tier 1: Completely Free (No Credit Card)

| Provider | Free Limit | Best Models Available | Speed | Setup |
|---|---|---|---|---|
| **NVIDIA NIM** | 40 req/min | Nemotron, DeepSeek, MiniMax, Qwen, GLM | Fast | 5 min |
| **Groq** | 40 req/min (varies) | Llama 3.3 70B, DeepSeek R1 | Ultra-fast (<1s) | 5 min |
| **Cerebras** | 30 RPM, 1M tok/day | Llama 3.3 70B | Ultra-fast | 5 min |
| **Mistral** | 1B tokens/month | Mistral Small, Codestral | Good | 5 min |
| **Google AI Studio** | Generous (varies) | Gemini 2.5 Pro/Flash (1M context) | Good | 5 min |
| **OpenRouter** | 50 req/day | 24+ free models, many providers | Varies | 5 min |
| **Cloudflare Workers AI** | 10K neurons/day | Llama 3.3 70B, Mistral 7B | Edge-fast | 10 min |
| **Cohere** | 20 RPM, 1K/month | Command R+ (generation + embed + rerank) | Good | 5 min |

### Tier 2: One-Time or Trial Credits

| Provider | Credit | Duration | Best For |
|---|---|---|---|
| **OpenRouter ($10 top-up)** | 1,000 req/day unlocked | Permanent | Universal fallback |
| **SambaNova** | $5 signup credit | 3 months | Llama models at high throughput |
| **DeepSeek** | $5 signup credit | 30 days | DeepSeek R1 reasoning |
| **Fireworks AI** | $1 signup credit | 30 days | Testing |

### Tier 3: Budget Paid (When You Scale)

| Provider | Pricing | Best For |
|---|---|---|
| **DeepInfra** | $0.80/M tokens | Cheapest per-token for Llama 405B |
| **MiniMax Lightning** | ~$1/hr continuous use | Quality/cost ratio |
| **Ollama (local)** | $0 (your GPU) | Full privacy, unlimited, offline |

---

## Multi-Agent Workforce Architecture

### How Agents Collaborate

```
User message arrives via Telegram/Discord/CLI
    │
    ▼
┌─────────────────────────────────────────────┐
│           PicoClaw Gateway                   │
│                                              │
│  Message Bus routes to the right agent:      │
│                                              │
│  "write a script" ──► Coder Agent            │
│  "summarize this PDF" ──► Researcher Agent   │
│  "what's in this image" ──► Vision Agent     │
│  everything else ──► Orchestrator Agent      │
│                                              │
│  The Orchestrator can also spawn sub-agents  │
│  for complex multi-step tasks.               │
└─────────────────────────────────────────────┘
```

### Agent Routing with Bindings

You can bind specific keywords or channels to specific agents:

```json
{
  "agents": {
    "bindings": [
      {
        "pattern": "code|script|debug|function|refactor",
        "agent": "coder"
      },
      {
        "pattern": "research|summarize|analyze|pdf|paper",
        "agent": "researcher"
      },
      {
        "pattern": "image|screenshot|photo|ocr|scan",
        "agent": "vision"
      }
    ]
  }
}
```

### Subagent Spawning

The Orchestrator can spawn specialized subagents for complex tasks:

```
User: "Research the latest AI papers, write a summary, and create a script to track citations"

Orchestrator:
  ├── Spawns Researcher → finds and summarizes papers
  ├── Spawns Coder → writes the citation tracking script
  └── Combines results → delivers final response
```

This happens automatically when the Orchestrator uses PicoClaw's built-in `spawn` tool.

---

## Cost Estimation

### Scenario: Personal use, ~50 messages/day

| Component | Provider | Monthly Cost |
|---|---|---|
| Primary LLM calls | NVIDIA NIM (free) | $0 |
| Speed-critical calls | Groq (free) | $0 |
| Fallback calls | Cerebras / Mistral (free) | $0 |
| Web search | DuckDuckGo (free) | $0 |
| Hosting (optional) | Old phone / Pi / $4 VPS | $0–4 |
| **Total** | | **$0–4/month** |

### Scenario: Heavy use, ~200 messages/day with research

| Component | Provider | Monthly Cost |
|---|---|---|
| Primary LLM calls | NVIDIA NIM (free) | $0 |
| Overflow calls | OpenRouter ($10 one-time) | $0 (after one-time) |
| High-volume research | Mistral (1B tokens free) | $0 |
| Premium web search | Tavily (1K free queries) | $0 |
| Hosting | Hetzner VPS | $4 |
| **Total** | | **~$4–14/month** |

### The Single Best Investment

If you're going to spend any money at all, the **$10 one-time OpenRouter top-up** is the highest-value purchase. It permanently upgrades your free tier from 50 to 1,000 requests/day and gives you access to 24+ models as a universal fallback.

---

## Troubleshooting

### "Model not allowed" or "Model not found"

The model string must exactly match what the provider expects. For NVIDIA NIM, check the exact string at [build.nvidia.com](https://build.nvidia.com) by clicking on a model and looking at the API example.

### Rate limit errors

This is expected with free tiers. The fallback chain handles it automatically. If you're hitting limits across all providers, you may need to reduce request frequency or add more fallback providers.

### PicoClaw won't start

```bash
# Check config syntax
python3 -c "import json; json.load(open('$HOME/.picoclaw/config.json'))"

# Check for permission issues
ls -la ~/.picoclaw/config.json

# Run with verbose output
picoclaw agent --verbose
```

### Provider connection errors

```bash
# Test NVIDIA NIM directly
curl https://integrate.api.nvidia.com/v1/models \
  -H "Authorization: Bearer nvapi-YOUR_KEY"

# Test Groq directly
curl https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer gsk_YOUR_KEY"
```

### Telegram bot not responding

1. Confirm the bot token is correct (test with BotFather)
2. Make sure `allow_from` contains your numeric Telegram user ID (not username)
3. Check that PicoClaw gateway is running: `picoclaw gateway`

---

## Next Steps

1. **Start simple:** Get one agent working with NVIDIA NIM on CLI before adding channels or more agents.

2. **Add channels gradually:** Start with Telegram (easiest), then add Discord or others as needed.

3. **Explore skills:** PicoClaw has a skills marketplace. Check `picoclaw skills list` for available automation skills.

4. **Set up cron jobs:** Use PicoClaw's built-in cron for recurring tasks:
   - "Send me a daily news summary at 8am"
   - "Check my GitHub repos for new issues every hour"
   - "Remind me to drink water every 2 hours"

5. **Monitor usage:** Keep an eye on your free tier limits across providers. Most have dashboards showing remaining quota.

6. **Join the community:**
   - GitHub: [github.com/sipeed/picoclaw](https://github.com/sipeed/picoclaw)
   - Discussions: Check the GitHub Discussions tab for help and feature requests

---

## Quick Reference Card

```
┌──────────────────────────────────────────────────────────┐
│                    QUICK REFERENCE                        │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Config file:  ~/.picoclaw/config.json                   │
│  Workspace:    ~/.picoclaw/workspace                     │
│                                                          │
│  NVIDIA NIM base URL:                                    │
│    https://integrate.api.nvidia.com/v1                   │
│                                                          │
│  Start agent:   picoclaw agent                           │
│  Start gateway: picoclaw gateway                         │
│  List skills:   picoclaw skills list                     │
│                                                          │
│  ENV overrides:                                          │
│    PICOCLAW_CONFIG=/path/to/config.json                  │
│    PICOCLAW_HOME=/path/to/data                           │
│                                                          │
│  Free API keys:                                          │
│    NVIDIA  → build.nvidia.com (Profile → API Keys)       │
│    Groq    → console.groq.com/keys                       │
│    Cerebras → cloud.cerebras.ai                          │
│    OpenRouter → openrouter.ai/keys                       │
│    Mistral → console.mistral.ai                          │
│    Google  → aistudio.google.com                         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

*Last updated: March 2026. Model availability and free tier limits change frequently — always verify current offerings on each provider's website.*
