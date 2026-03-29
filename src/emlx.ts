import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getDb, getMailDir } from "./db";

/**
 * Find and read the .emlx file for a given message ROWID.
 * Mail.app stores messages as .emlx files in a directory structure based on
 * the mailbox URL and message ROWID.
 */
export function readEmlx(messageRowId: number): string | null {
  const mailDir = getMailDir();
  const db = getDb();

  // Get the mailbox URL for this message
  const row = db
    .prepare(
      `SELECT mb.url FROM messages m
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.ROWID = ?`
    )
    .get(messageRowId) as { url: string } | undefined;

  if (!row) return null;

  const mailboxPath = mailboxUrlToPath(row.url, mailDir);
  if (!mailboxPath) return null;

  // Search for the .emlx file - Mail.app uses the message ROWID as filename
  const filename = `${messageRowId}.emlx`;
  const found = findFile(mailboxPath, filename);
  if (!found) return null;

  return readFileSync(found, "utf-8");
}

/**
 * Parse an .emlx file into headers and body.
 * Format: first line is byte count, then raw RFC 822 message, then Apple plist.
 */
export function parseEmlx(content: string): {
  headers: Record<string, string>;
  body: string;
  textBody: string;
} {
  const lines = content.split("\n");
  // First line is the byte count of the message portion
  const byteCount = parseInt(lines[0], 10);
  const messageStart = lines[0].length + 1;
  const rawMessage = content.substring(messageStart, messageStart + byteCount);

  // Split headers and body
  const headerEnd = rawMessage.indexOf("\r\n\r\n");
  const splitIdx = headerEnd !== -1 ? headerEnd : rawMessage.indexOf("\n\n");
  const headerSection =
    splitIdx !== -1 ? rawMessage.substring(0, splitIdx) : rawMessage;
  const bodySection =
    splitIdx !== -1
      ? rawMessage.substring(splitIdx + (headerEnd !== -1 ? 4 : 2))
      : "";

  const headers: Record<string, string> = {};
  let currentKey = "";
  for (const line of headerSection.split(/\r?\n/)) {
    if (line.match(/^\s/) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        currentKey = line.substring(0, colonIdx).toLowerCase();
        headers[currentKey] = line.substring(colonIdx + 1).trim();
      }
    }
  }

  // Extract plain text from body (handle multipart, base64, quoted-printable)
  const textBody = extractText(bodySection, headers["content-type"] || "", headers["content-transfer-encoding"] || "");

  return { headers, body: bodySection, textBody };
}

function extractText(
  body: string,
  contentType: string,
  encoding: string
): string {
  // Handle multipart messages
  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(`--${boundary}`);
    // Find the text/plain part first, fall back to text/html
    for (const part of parts) {
      if (part.includes("Content-Type: text/plain") || part.includes("content-type: text/plain")) {
        const partHeaderEnd = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
        if (partHeaderEnd === -1) continue;
        const partHeaders = part.substring(0, partHeaderEnd);
        const partBody = part.substring(partHeaderEnd + (part.indexOf("\r\n\r\n") !== -1 ? 4 : 2));
        const partEncoding = partHeaders.match(/Content-Transfer-Encoding:\s*(\S+)/i)?.[1] || "";
        return decodeBody(partBody, partEncoding);
      }
    }
    // Try html part
    for (const part of parts) {
      if (part.includes("Content-Type: text/html") || part.includes("content-type: text/html")) {
        const partHeaderEnd = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
        if (partHeaderEnd === -1) continue;
        const partHeaders = part.substring(0, partHeaderEnd);
        const partBody = part.substring(partHeaderEnd + (part.indexOf("\r\n\r\n") !== -1 ? 4 : 2));
        const partEncoding = partHeaders.match(/Content-Transfer-Encoding:\s*(\S+)/i)?.[1] || "";
        return stripHtml(decodeBody(partBody, partEncoding));
      }
    }
  }

  const decoded = decodeBody(body, encoding);
  if (contentType.includes("text/html")) {
    return stripHtml(decoded);
  }
  return decoded;
}

function decodeBody(body: string, encoding: string): string {
  encoding = encoding.toLowerCase().trim();
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
  }
  return body;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mailboxUrlToPath(url: string, mailDir: string): string | null {
  // ews://UUID/FolderName -> UUID/FolderName.mbox
  // imap://UUID/FolderName -> UUID/FolderName.mbox
  const match = url.match(/^(?:ews|imap|local):\/\/([^/]+)\/(.+)$/);
  if (!match) return null;

  const [, accountId, folderPath] = match;
  const decodedFolder = decodeURIComponent(folderPath);

  // Try with .mbox suffix
  const mboxPath = join(mailDir, accountId, `${decodedFolder}.mbox`);
  if (existsSync(mboxPath)) return mboxPath;

  // Try without .mbox
  const plainPath = join(mailDir, accountId, decodedFolder);
  if (existsSync(plainPath)) return plainPath;

  return null;
}

function findFile(dir: string, filename: string): string | null {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return fullPath;
      if (entry.isDirectory()) {
        const found = findFile(fullPath, filename);
        if (found) return found;
      }
    }
  } catch {
    // Permission denied or similar
  }
  return null;
}
