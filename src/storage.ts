import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CachedMessage {
  direction: "in" | "out";
  text: string;
  timestamp: string;
}

export interface MessageCache {
  messagesByUserId: Record<string, CachedMessage[]>;
  updatedAt?: string;
}

const STATE_DIR = path.join(os.homedir(), ".wx-ilink-cli");
const CACHE_PATH = path.join(STATE_DIR, "cache.json");
const RUNTIME_PATH = path.join(STATE_DIR, "runtime.json");
const DAEMON_PID_PATH = path.join(STATE_DIR, "daemon.pid");
const DAEMON_LOG_PATH = path.join(STATE_DIR, "daemon.log");
const MEDIA_DIR = path.join(STATE_DIR, "media");
const MAX_MESSAGES_PER_USER = 50;

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureStateDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getStateDir(): string {
  ensureStateDir();
  return STATE_DIR;
}

export function getCachePath(): string {
  return CACHE_PATH;
}

export function getRuntimePath(): string {
  ensureStateDir();
  return RUNTIME_PATH;
}

export function getDaemonPidPath(): string {
  ensureStateDir();
  return DAEMON_PID_PATH;
}

export function getDaemonLogPath(): string {
  ensureStateDir();
  return DAEMON_LOG_PATH;
}

export function getMediaDir(): string {
  ensureStateDir();
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  return MEDIA_DIR;
}

export function loadCache(): MessageCache {
  const parsed = readJsonFile<Partial<MessageCache>>(CACHE_PATH, {});
  return {
    messagesByUserId: parsed.messagesByUserId ?? {},
    updatedAt: parsed.updatedAt,
  };
}

export function saveCache(cache: MessageCache): void {
  writeJsonFile(CACHE_PATH, cache);
}

export function appendCachedMessage(
  cache: MessageCache,
  userId: string,
  message: CachedMessage,
): MessageCache {
  const existing = cache.messagesByUserId[userId] ?? [];
  const nextMessages = [...existing, message].slice(-MAX_MESSAGES_PER_USER);
  return {
    messagesByUserId: {
      ...cache.messagesByUserId,
      [userId]: nextMessages,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function clearCache(): void {
  try {
    fs.unlinkSync(CACHE_PATH);
  } catch {
    // ignore
  }
}

export function loadStateFile<T>(filePath: string, fallback: T): T {
  return readJsonFile(filePath, fallback);
}

export function saveStateFile(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

export function removeStateFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function readDaemonPid(): number | null {
  try {
    const raw = fs.readFileSync(DAEMON_PID_PATH, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeDaemonPid(pid: number): void {
  ensureStateDir();
  fs.writeFileSync(DAEMON_PID_PATH, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export function removeDaemonPid(): void {
  try {
    fs.unlinkSync(DAEMON_PID_PATH);
  } catch {
    // ignore
  }
}
