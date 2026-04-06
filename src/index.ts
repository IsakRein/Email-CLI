#!/usr/bin/env node

import { Command } from "commander";
import { getDb, mailDateToISO } from "./db";
import { readEmlx, parseEmlx } from "./emlx";

const program = new Command();
program.name("mac-mail").description("Read Apple Mail.app data from the command line").version("1.0.0");

// --- list-accounts ---
program
  .command("list-accounts")
  .description("List all email accounts configured in Mail.app")
  .action(() => {
    const db = getDb();
    const rows = db.prepare(`SELECT DISTINCT url FROM mailboxes`).all() as { url: string }[];

    const accounts = new Map<string, { protocol: string; id: string; folders: string[] }>();
    for (const row of rows) {
      const match = row.url.match(/^(ews|imap|local):\/\/([^/]+)\/(.+)$/);
      if (!match) continue;
      const [, protocol, id, folder] = match;
      if (!accounts.has(id)) accounts.set(id, { protocol, id, folders: [] });
      accounts.get(id)!.folders.push(decodeURIComponent(folder));
    }

    console.log(JSON.stringify([...accounts.values()], null, 2));
  });

// --- list-folders ---
program
  .command("list-folders")
  .description("List all mailbox folders")
  .option("--account <uuid>", "Filter by account UUID")
  .action(({ account }) => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT url, total_count, unread_count FROM mailboxes ORDER BY url`)
      .all() as { url: string; total_count: number; unread_count: number }[];

    const folders = rows
      .filter((r) => !account || r.url.includes(account))
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

    console.log(JSON.stringify(folders, null, 2));
  });

// --- search ---
program
  .command("search")
  .description("Search emails by subject, sender, or date range")
  .option("--query <text>", "Search term for subject or sender")
  .option("--folder <name>", "Folder name to filter (e.g. Inbox)")
  .option("--account <uuid>", "Account UUID to filter")
  .option("--from <email>", "Sender email to filter")
  .option("--since <date>", "ISO date - only show messages after this date")
  .option("--limit <n>", "Max results to return", "25")
  .option("--unread-only", "Only show unread messages", false)
  .action(({ query, folder, account, from, since, limit, unreadOnly }) => {
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
    if (account) {
      conditions.push("mb.url LIKE ?");
      params.push(`%${account}%`);
    }
    if (from) {
      conditions.push("a.address LIKE ?");
      params.push(`%${from}%`);
    }
    if (since) {
      conditions.push("m.date_received >= ?");
      params.push(new Date(since).getTime() / 1000);
    }
    if (unreadOnly) {
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
    params.push(parseInt(limit, 10));

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

    console.log(JSON.stringify(results, null, 2));
  });

// --- get-email ---
program
  .command("get-email <id>")
  .description("Get full email content by message ID")
  .action((idStr) => {
    const id = parseInt(idStr, 10);
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
      console.error("Message not found");
      process.exit(1);
    }

    const recipients = db
      .prepare(
        `SELECT a.address, a.comment, r.type FROM recipients r
         JOIN addresses a ON r.address = a.ROWID
         WHERE r.message = ?`
      )
      .all(id) as { address: string; comment: string; type: number }[];

    const attachments = db
      .prepare(`SELECT name FROM attachments WHERE message = ?`)
      .all(id) as { name: string }[];

    let body = "";
    const emlxContent = readEmlx(id);
    if (emlxContent) {
      body = parseEmlx(emlxContent).textBody;
    }

    console.log(
      JSON.stringify(
        {
          id: row.id,
          subject: row.subject,
          sender: row.sender_name ? `${row.sender_name} <${row.sender}>` : row.sender,
          to: recipients.filter((r) => r.type === 0).map((r) => (r.comment ? `${r.comment} <${r.address}>` : r.address)),
          cc: recipients.filter((r) => r.type === 1).map((r) => (r.comment ? `${r.comment} <${r.address}>` : r.address)),
          date: mailDateToISO(row.date_received),
          read: row.read === 1,
          flagged: row.flagged === 1,
          size: row.size,
          folder: decodeURIComponent(row.mailbox_url.split("/").pop() || ""),
          conversation_id: row.conversation_id,
          attachments: attachments.map((a) => a.name),
          body,
        },
        null,
        2
      )
    );
  });

// --- get-thread ---
program
  .command("get-thread <conversation_id>")
  .description("Get all messages in a conversation thread")
  .action((convIdStr) => {
    const conversation_id = parseInt(convIdStr, 10);
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
      if (emlxContent) body = parseEmlx(emlxContent).textBody;
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

    console.log(JSON.stringify(messages, null, 2));
  });

// --- unread-count ---
program
  .command("unread-count")
  .description("Get unread message counts per folder/account")
  .option("--account <uuid>", "Filter by account UUID")
  .action(({ account }) => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT url, unread_count FROM mailboxes WHERE unread_count > 0 ORDER BY unread_count DESC`)
      .all() as { url: string; unread_count: number }[];

    const results = rows
      .filter((r) => !account || r.url.includes(account))
      .map((r) => {
        const match = r.url.match(/^(ews|imap|local):\/\/([^/]+)\/(.+)$/);
        return {
          account: match?.[2] || "unknown",
          folder: match ? decodeURIComponent(match[3]) : r.url,
          unread: r.unread_count,
        };
      });

    console.log(JSON.stringify(results, null, 2));
  });

program.parse();
