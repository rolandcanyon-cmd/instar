# Example: Telegram Agent

A minimal Instar agent with two-way Telegram messaging.

## Files

### `AGENT.md`

```markdown
# Assistant

I am a helpful assistant reachable via Telegram.

## Core Behavior
- Respond to messages promptly and helpfully
- Remember context from previous conversations
- Be concise but thorough
```

### `config.json`

```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  }
}
```

## Setup

1. **Create a Telegram bot** — message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and follow the prompts. Save the bot token.

2. **Create a forum group** — create a new Telegram group, enable Topics in group settings, and add your bot as an admin.

3. **Get the chat ID** — send a message in the group, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find the chat ID (it will be negative for groups).

4. **Configure** — create a project directory with `AGENT.md` and `config.json` as shown above, replacing the placeholder values.

5. **Start** — run `instar server start`

6. **Message your agent** — create a topic in the Telegram group and send a message. Your agent responds in the same topic.

## How It Works

- Each Telegram forum topic maps to a separate Claude Code session
- Messages you send appear as input to the agent
- The agent's responses are relayed back to the topic
- Conversation history persists across restarts via the memory system

## Tips

- Use different topics for different conversations (e.g., "General", "Code Review", "Ideas")
- The agent can send you messages proactively from scheduled jobs using the Telegram skill
- If you use the setup wizard (`npx instar`), it handles bot creation and config automatically

> **Full docs:** [Telegram](https://instar.sh/features/telegram/) · [Quick Start](https://instar.sh/quickstart/)
