import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readdirSync } from "fs";

const MAIL_BASE = join(homedir(), "Library", "Mail");

function findMailVersion(): string {
  const entries = readdirSync(MAIL_BASE).filter((e) => e.startsWith("V"));
  if (entries.length === 0) throw new Error("No Mail.app data found");
  entries.sort((a, b) => parseInt(b.slice(1)) - parseInt(a.slice(1)));
  return entries[0];
}

function getDbPath(): string {
  const version = findMailVersion();
  const dbPath = join(MAIL_BASE, version, "MailData", "Envelope Index");
  if (!existsSync(dbPath)) {
    throw new Error(`Mail database not found at ${dbPath}`);
  }
  return dbPath;
}

export function getMailDir(): string {
  return join(MAIL_BASE, findMailVersion());
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(getDbPath(), { readonly: true });
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

// Convert Mail.app's date to ISO string
export function mailDateToISO(mailDate: number | null): string | null {
  if (mailDate == null) return null;
  // Mail.app stores dates as Unix timestamps (seconds since 1970-01-01)
  return new Date(mailDate * 1000).toISOString();
}
