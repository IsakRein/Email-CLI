# mac-mail-mcp

MCP server that reads your Apple Mail.app data directly from the local SQLite database. No OAuth, no API keys — just local file access.

Works with any email account configured in Mail.app (Gmail, Outlook/Exchange, iCloud, IMAP).

## Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List all email accounts configured in Mail.app |
| `list_folders` | List mailbox folders with message counts |
| `search` | Search by subject, sender, date range, folder |
| `get_email` | Get full email with body (from .emlx files) |
| `get_thread` | Get all messages in a conversation |
| `unread_count` | Unread counts per folder/account |

## Setup

```bash
npm install
npm run build
```

Add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mac-mail": {
      "command": "node",
      "args": ["/path/to/mac-mail-mcp/dist/index.js"]
    }
  }
}
```

## How it works

Mail.app stores all email metadata in a SQLite database at `~/Library/Mail/V*/MailData/Envelope Index` and message bodies as `.emlx` files. This server reads both to give you full access to your email.

## Requirements

- macOS with Mail.app configured
- Node.js 18+
- Full Disk Access may be required for the process reading the database

## Limitations

- Read-only — cannot send, move, or delete emails
- Message bodies are only available for emails Mail.app has downloaded locally
- Mail.app must be configured with the accounts you want to access
