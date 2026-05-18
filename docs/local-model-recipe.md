# Local-model adapter recipe (Phase 6)

Instar can run an agent topic against a locally-hosted model — no
OpenAI or Anthropic API spend, prompt never leaves your machine. This
guide walks through the setup end-to-end.

## When to use this

- You want a topic that never sends data outside your machine.
- You want to test how a small local model handles routine tasks
  before committing to subscription spend.
- You want to keep working when your network is down or your
  subscription quota is exhausted.

## When NOT to use this

- For complex multi-file refactors. The small local models (3B–8B
  params) handle short decisions well; complex coding work still
  needs a frontier model.
- For long-context work. Local models typically cap at 8K–32K
  tokens vs the 200K+ that hosted frontier models offer.
- For long-running autonomous loops where reliability is critical.
  Local models retry less reliably than GPT-5.x.

## Prerequisites

1. **Ollama installed.** `brew install ollama` on macOS, or download
   from <https://ollama.com>.
2. **Ollama serving.** `ollama serve` (it usually auto-starts on
   install; `curl http://localhost:11434/api/version` returns the
   version if it's up).
3. **A model pulled.** `ollama pull llama3.2:latest` (2GB) is the
   smallest one that produces useful output. For coding work, try
   `ollama pull qwen2.5-coder:7b` (~5GB) once you've verified the
   path works with the small model.
4. **Codex CLI installed.** `npm install -g @openai/codex` or via
   homebrew.

## How to switch a topic to local model

For now the switch is config-driven — a future release adds a
conversational shortcut. Edit the agent's `.instar/config.json` and
add the per-topic override:

```json
{
  "topicFrameworks": {
    "9984": "codex-cli"
  },
  "topicCodexLocalProvider": {
    "9984": "ollama"
  },
  "topicCodexLocalModel": {
    "9984": "llama3.2:latest"
  }
}
```

Restart the agent (`instar restart` or kill the server process). The
next time topic 9984 spawns a session, it'll spawn `codex exec --oss
--local-provider ollama --model llama3.2:latest` instead of the
subscription path.

## Verifying it works

Send a message to the topic via Telegram. The session should respond
within ~5 seconds for the small model. Check the dashboard's terminal
stream — you'll see `--oss --local-provider ollama` in the spawn line.

If the response is empty or the session hangs:

1. **Check Ollama:** `curl http://localhost:11434/api/version`. If
   it's not responding, run `ollama serve` in another terminal.
2. **Check the model is pulled:** `ollama list` shows what's
   available. If your configured model isn't there, run `ollama pull
   <model>`.
3. **Check the spawn command:** look at the dashboard's terminal view
   for the topic. The first line will show the exact `codex exec`
   command. Try running it yourself to see Codex's error.
4. **Check Codex CLI version:** `codex --version`. The `--oss` flag
   was added in Codex CLI 0.50.x; older versions will error.

## Common pitfalls

- **Model name typos.** Ollama is strict — `llama3.2:latest` works,
  `llama-3.2` doesn't. Use `ollama list` to copy the exact name.
- **Context-window limits.** Small models choke around 8K tokens of
  prompt + history. For long conversations, switch back to a hosted
  framework via `/route claude-code`.
- **The dashboard shows "session failed to start."** Almost always
  means Ollama isn't running, or Codex CLI can't find Ollama at the
  default port. Verify port 11434 is reachable.

## Architecture note

This isn't a new adapter — it's Codex CLI's built-in `--oss
--local-provider` flag, threaded through `frameworkSessionLaunch.ts`
so per-topic routing works. The advantage of reusing Codex's flag is
zero new translation code (Codex CLI handles the local-API
translation); the trade-off is that you can only use providers Codex
already supports (Ollama, LM Studio). Other local backends would need
a dedicated Instar adapter.

See `specs/provider-portability/08-model-fitness-catalog.md` §
"Local-model adapter via Codex CLI (Phase 6 path)" for the design
detail and the verified-backends table.
