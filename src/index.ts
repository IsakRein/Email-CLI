#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, mailDateToISO } from "./db";
import { readEmlx, parseEmlx } from "./emlx";

const server = new McpServer({
  name: "mac-mail-mcp",
  version: "1.0.0",
});

// --- list_accounts ---
server.tool("list_accounts", "List all email accounts configured in Mail.app", {}, () => {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT url FROM mailboxes`)
    .all() as { url: string }[];

  const accounts = new Map<string, { protocol: string; id: string; folders: string[] }>();
  for (const row of rows) {
    const match = row.url.match(/^(ews|imap|local):\/\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const [, protocol, id, folder] = match;
    if (!accounts.has(id)) {
      accounts.set(id, { protocol, id, folders: [] });
    }
    accounts.get(id)!.folders.push(decodeURIComponent(folder));
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify([...accounts.values()], null, 2),
      },
    ],
  };
});

// --- list_folders ---
server.tool(
  "list_folders",
  "List all mailbox folders, optionally filtered by account",
  { account_id: z.string().optional().describe("Filter by account UUID") },
  ({ account_id }) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT url, total_count, unread_count FROM mailboxes ORDER BY url`
      )
      .all() as { url: string; total_count: number; unread_count: number }[];

    const folders = rows
      .filter((r) => !account_id || r.url.includes(account_id))
      .map((r) => {
        const match = r.url.match(/^(ews|imap|local):\/\/([^/]+)\/(.+)$/);
        return {
          url: r.url,
          account: match?.[2] || "unknown",
          folder: match ? decodeURIComponent(match[3]) : r.url,
          total: r.total_count,
          unread: r.unread_count,
        };
      });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(folders, null, 2) }],
    };
  }
);

// --- search ---
server.tool(
  "search",
  "Search emails by subject, sender, or date range",
  {
    query: z.string().optional().describe("Search term for subject or sender"),
    folder: z.string().optional().describe("Folder name to filter (e.g. 'Inbox', 'Sent Items')"),
    account_id: z.string().optional().describe("Account UUID to filter"),
    from: z.string().optional().describe("Sender email to filter"),
    since: z.string().optional().describe("ISO date string - only show messages after this date"),
    limit: z.number().default(25).describe("Max results to return"),
    unread_only: z.boolean().default(false).describe("Only show unread messages"),
  },
  ({ query, folder, account_id, from, since, limit, unread_only }) => {
    const db = getDb();
    const conditions: string[] = ["m.deleted = 0"];
    const params: any[] = [];

    if (query) {
      conditions.push("(s.subject LIKE ? OR a.address LIKE ? OR a.comment LIKE ?)");
      const q = `%${query}%`;
      params.push(q, q, q);
    }
    if (folder) {
      conditions.push("mb.url LIKE ?");
      params.push(`%/${encodeURIComponent(folder)}%`);
    }
    if (account_id) {
      conditions.push("mb.url LIKE ?");
      params.push(`%${account_id}%`);
    }
    if (from) {
      conditions.push("a.address LIKE ?");
      params.push(`%${from}%`);
    }
    if (since) {
      conditions.push("m.date_received >= ?");
      params.push(new Date(since).getTime() / 1000);
    }
    if (unread_only) {
      conditions.push("m.read = 0");
    }

    const sql = `
      SELECT m.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
             m.date_received, m.date_sent, m.read, m.flagged, m.flags,
             mb.url as mailbox_url, m.conversation_id
      FROM messages m
      JOIN subjects s ON m.subject = s.ROWID
      JOIN addresses a ON m.sender = a.ROWID
      JOIN mailboxes mb ON m.mailbox = mb.ROWID
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.date_received DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    const results = rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      sender: r.sender_name ? `${r.sender_name} <${r.sender}>` : r.sender,
      date: mailDateToISO(r.date_received),
      read: r.read === 1,
      flagged: r.flagged === 1,
      folder: decodeURIComponent(r.mailbox_url.split("/").pop() || ""),
      conversation_id: r.conversation_id,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- get_email ---
server.tool(
  "get_email",
  "Get full email content by message ID (includes body from .emlx file)",
  { id: z.number().describe("Message ROWID from search results") },
  ({ id }) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT m.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
                m.date_received, m.date_sent, m.read, m.flagged, m.size,
                mb.url as mailbox_url, m.conversation_id
         FROM messages m
         JOIN subjects s ON m.subject = s.ROWID
         JOIN addresses a ON m.sender = a.ROWID
         JOIN mailboxes mb ON m.mailbox = mb.ROWID
         WHERE m.ROWID = ?`
      )
      .get(id) as any;

    if (!row) {
      return { content: [{ type: "text" as const, text: "Message not found" }] };
    }

    // Get recipients
    const recipients = db
      .prepare(
        `SELECT a.address, a.comment, r.type FROM recipients r
         JOIN addresses a ON r.address = a.ROWID
         WHERE r.message = ?`
      )
      .all(id) as { address: string; comment: string; type: number }[];

    // Get attachments
    const attachments = db
      .prepare(`SELECT name FROM attachments WHERE message = ?`)
      .all(id) as { name: string }[];

    // Try to read the full message body from .emlx
    let body = "";
    const emlxContent = readEmlx(id);
    if (emlxContent) {
      const parsed = parseEmlx(emlxContent);
      body = parsed.textBody;
    }

    const result = {
      id: row.id,
      subject: row.subject,
      sender: row.sender_name ? `${row.sender_name} <${row.sender}>` : row.sender,
      to: recipients
        .filter((r) => r.type === 0)
        .map((r) => (r.comment ? `${r.comment} <${r.address}>` : r.address)),
      cc: recipients
        .filter((r) => r.type === 1)
        .map((r) => (r.comment ? `${r.comment} <${r.address}>` : r.address)),
      date: mailDateToISO(row.date_received),
      read: row.read === 1,
      flagged: row.flagged === 1,
      size: row.size,
      folder: decodeURIComponent(row.mailbox_url.split("/").pop() || ""),
      conversation_id: row.conversation_id,
      attachments: attachments.map((a) => a.name),
      body,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- get_thread ---
server.tool(
  "get_thread",
  "Get all messages in a conversation thread",
  { conversation_id: z.number().describe("Conversation ID from search or get_email results") },
  ({ conversation_id }) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT m.ROWID as id, s.subject, a.address as sender, a.comment as sender_name,
                m.date_received, m.read, mb.url as mailbox_url
         FROM messages m
         JOIN subjects s ON m.subject = s.ROWID
         JOIN addresses a ON m.sender = a.ROWID
         JOIN mailboxes mb ON m.mailbox = mb.ROWID
         WHERE m.conversation_id = ? AND m.deleted = 0
         ORDER BY m.date_received ASC`
      )
      .all(conversation_id) as any[];

    const messages = rows.map((r) => {
      let body = "";
      const emlxContent = readEmlx(r.id);
      if (emlxContent) {
        const parsed = parseEmlx(emlxContent);
        body = parsed.textBody;
      }

      return {
        id: r.id,
        subject: r.subject,
        sender: r.sender_name ? `${r.sender_name} <${r.sender}>` : r.sender,
        date: mailDateToISO(r.date_received),
        read: r.read === 1,
        folder: decodeURIComponent(r.mailbox_url.split("/").pop() || ""),
        body,
      };
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }],
    };
  }
);

// --- unread_count ---
server.tool(
  "unread_count",
  "Get unread message counts per folder/account",
  { account_id: z.string().optional().describe("Filter by account UUID") },
  ({ account_id }) => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT url, unread_count FROM mailboxes WHERE unread_count > 0 ORDER BY unread_count DESC`)
      .all() as { url: string; unread_count: number }[];

    const results = rows
      .filter((r) => !account_id || r.url.includes(account_id))
      .map((r) => {
        const match = r.url.match(/^(ews|imap|local):\/\/([^/]+)\/(.+)$/);
        return {
          account: match?.[2] || "unknown",
          folder: match ? decodeURIComponent(match[3]) : r.url,
          unread: r.unread_count,
        };
      });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
