#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import qrcodeTerminal from "qrcode-terminal";

import {
  DEFAULT_BASE_URL,
  MessageItemType,
  MessageType,
  WeChatClient,
  normalizeAccountId,
  type MessageItem,
  type WeixinMessage,
} from "../vendor/wechat-ilink-client/src/index.js";
import {
  clearState,
  clearSession,
  loadRuntime,
  saveRuntime,
  touchRuntime,
  type RuntimeState,
} from "./session.js";
import {
  appendCachedMessage,
  clearCache,
  getDaemonLogPath,
  getMediaDir,
  loadCache,
  readDaemonPid,
  removeDaemonPid,
  saveCache,
  writeDaemonPid,
} from "./storage.js";

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type DownloadedAttachment = {
  kind: "image" | "voice" | "file" | "video";
  path: string;
  fileName?: string;
  size: number;
};

type WeixinMessageWithAttachments = WeixinMessage & {
  attachments?: DownloadedAttachment[];
};

function usage(): string {
  return [
    "Usage:",
    "  wx login [--fresh]",
    "  wx status",
    "  wx logout",
    "  wx watch [--resume] [--json]",
    "  wx bridge [--resume] [--json]",
    "  wx daemon start|stop|status",
    "  wx peers",
    "  wx recent",
    "  wx chat <user-id|alias>",
    "  wx tail [--limit <n>] <user-id|alias>",
    "  wx alias",
    "  wx alias set <alias> <user-id>",
    "  wx alias rm <alias>",
    "  wx send [--context-token <token>] <user-id|alias> <text>",
    "  wx send-file [--context-token <token>] <user-id|alias> <file-path> [caption]",
    "",
    "Notes:",
    "  - Login sessions are kept in memory only. Commands that connect to WeChat",
    "    scan a QR code each time they start.",
    "  - `send` and `send-file` need a context token. The easiest path is to run `wx watch`",
    "    first so the peer is cached.",
    "  - Recent message cache is stored locally for `tail` and daemon mode.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) {
      positionals.push(part);
      continue;
    }
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { positionals, flags };
}

function getFlagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}

function describeItem(item: MessageItem): string {
  switch (item.type) {
    case MessageItemType.TEXT:
      return item.text_item?.text ?? "";
    case MessageItemType.IMAGE:
      return "[image]";
    case MessageItemType.VOICE:
      return item.voice_item?.text ? `[voice] ${item.voice_item.text}` : "[voice]";
    case MessageItemType.FILE:
      return `[file] ${item.file_item?.file_name ?? "attachment"}`;
    case MessageItemType.VIDEO:
      return "[video]";
    default:
      return `[item:${item.type ?? "unknown"}]`;
  }
}

function describeMessage(msg: WeixinMessage): string {
  const parts = (msg.item_list ?? []).map(describeItem).filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  const text = WeChatClient.extractText(msg);
  if (text) {
    return text;
  }
  return "[empty]";
}

function describeMessageForCache(msg: WeixinMessage, attachments: DownloadedAttachment[]): string {
  const base = describeMessage(msg);
  if (attachments.length === 0) return base;
  const lines = attachments.map((attachment) => {
    const label = attachment.fileName ? `${attachment.fileName} -> ${attachment.path}` : attachment.path;
    return `[${attachment.kind}] ${label}`;
  });
  return [base, ...lines].filter(Boolean).join(" ");
}

function inferAttachmentExtension(kind: DownloadedAttachment["kind"], fileName: string | undefined, data: Buffer): string {
  const namedExt = fileName ? path.extname(fileName) : "";
  if (namedExt) return namedExt;

  if (kind === "image") {
    if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return ".jpg";
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return ".gif";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
    return ".jpg";
  }
  if (kind === "voice") return ".silk";
  if (kind === "video") return ".mp4";
  return ".bin";
}

function safeFileName(value: string): string {
  return value
    .replace(/[\\/:\0]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "attachment";
}

async function downloadMessageAttachments(client: WeChatClient, msg: WeixinMessage): Promise<DownloadedAttachment[]> {
  const attachments: DownloadedAttachment[] = [];
  const items = msg.item_list ?? [];
  if (items.length === 0) return attachments;

  const dateDir = new Date().toISOString().slice(0, 10);
  const mediaDir = path.join(getMediaDir(), dateDir);
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!WeChatClient.isMediaItem(item)) continue;
    try {
      const downloaded = await client.downloadMedia(item);
      if (!downloaded) continue;
      const ext = inferAttachmentExtension(downloaded.kind, downloaded.fileName, downloaded.data);
      const fallbackName = `${downloaded.kind}-${msg.message_id ?? msg.seq ?? Date.now()}-${index}${ext}`;
      const fileName = safeFileName(downloaded.fileName ?? fallbackName);
      const filePath = path.join(mediaDir, fileName);
      const finalPath = uniquePath(filePath);
      fs.writeFileSync(finalPath, downloaded.data, { mode: 0o600 });
      attachments.push({
        kind: downloaded.kind,
        path: finalPath,
        fileName,
        size: downloaded.data.byteLength,
      });
    } catch (error) {
      console.error(`media download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return attachments;
}

function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function formatTs(value?: number): string {
  const time = value ? new Date(value) : new Date();
  return time.toISOString();
}

function printQr(url: string, stderr = false): void {
  if (stderr) {
    qrcodeTerminal.generate(url, { small: true }, (qr) => {
      console.error(qr);
    });
    console.error(`QR URL: ${url}`);
    return;
  }
  qrcodeTerminal.generate(url, { small: true });
  console.log(`QR URL: ${url}`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findAliasByUserId(runtime: RuntimeState, userId: string): string | undefined {
  return Object.values(runtime.aliases).find((record) => record.userId === userId)?.alias;
}

function resolveTarget(runtime: RuntimeState, rawTarget: string): { userId: string; alias?: string } {
  const aliasRecord = runtime.aliases[rawTarget];
  if (aliasRecord) {
    return {
      userId: aliasRecord.userId,
      alias: aliasRecord.alias,
    };
  }
  return {
    userId: rawTarget,
    alias: findAliasByUserId(runtime, rawTarget),
  };
}

function formatTargetLabel(target: { userId: string; alias?: string }): string {
  return target.alias ? `${target.alias} (${target.userId})` : target.userId;
}

function getRecentMessagesForTarget(
  runtime: RuntimeState,
  rawTarget: string,
  limit: number,
): { target: { userId: string; alias?: string }; messages: ReturnType<typeof loadCache>["messagesByUserId"][string] } {
  const target = resolveTarget(runtime, rawTarget);
  const cache = loadCache();
  const messages = (cache.messagesByUserId[target.userId] ?? []).slice(-limit);
  return { target, messages };
}

function printRecentMessages(
  target: { userId: string; alias?: string },
  messages: { direction: "in" | "out"; text: string; timestamp: string }[],
): void {
  console.log(`Recent messages for ${formatTargetLabel(target)}:`);
  for (const message of messages) {
    const marker = message.direction === "in" ? "<" : ">";
    console.log(`[${message.timestamp}] ${marker} ${message.text}`);
  }
}

type EphemeralLogin = {
  client: WeChatClient;
  accountId: string;
  baseUrl: string;
  userId?: string;
};

async function loginEphemeral(options: { fresh?: boolean; stderr?: boolean } = {}): Promise<EphemeralLogin> {
  if (options.fresh) {
    await clearState();
  } else {
    await clearSession();
  }

  const client = new WeChatClient();
  let lastStatus = "";
  const log = options.stderr ? console.error : console.log;

  log("Scan the QR code with WeChat.");
  const result = await client.login({
    onQRCode(url) {
      printQr(url, options.stderr);
    },
    onStatus(status) {
      if (!status || status === lastStatus) {
        return;
      }
      lastStatus = status;
      if (status === "scaned") {
        log("QR scanned. Confirm on your phone.");
        return;
      }
      if (status === "expired") {
        log("QR expired. Refreshing.");
        return;
      }
      if (status === "confirmed") {
        log("Login confirmed.");
      }
    },
  });

  if (!result.connected || !result.botToken || !result.accountId) {
    throw new Error(result.message || "Login failed.");
  }

  const runtime = await loadRuntime();
  await saveRuntime(touchRuntime(runtime));

  return {
    client,
    accountId: normalizeAccountId(result.accountId),
    baseUrl: result.baseUrl ?? DEFAULT_BASE_URL,
    userId: result.userId,
  };
}

async function loginCommand(flags: Record<string, string | boolean>): Promise<void> {
  const session = await loginEphemeral({ fresh: hasFlag(flags, "fresh") });

  console.log(`Login completed for ${session.accountId}.`);
  console.log("Session credentials were not saved. Start `wx watch` or `wx bridge` to log in and keep a live in-memory session.");
}

async function statusCommand(): Promise<void> {
  const runtime = await loadRuntime();
  const peerCount = Object.keys(runtime.peers).length;
  const aliasCount = Object.keys(runtime.aliases).length;
  const daemonPid = readDaemonPid();
  const cache = loadCache();
  const cachedChats = Object.keys(cache.messagesByUserId).length;
  console.log("loginMode: ephemeral");
  console.log("savedSession: none");
  console.log("loginRequired: yes, scan QR when starting `wx watch`, `wx bridge`, `wx chat`, or `wx send`.");
  console.log(`cachedPeers: ${peerCount}`);
  console.log(`aliases: ${aliasCount}`);
  if (runtime.updatedAt) {
    console.log(`runtimeUpdatedAt: ${runtime.updatedAt}`);
  }
  console.log(`resumeCursor: ${runtime.syncBuf ? "present" : "absent"}`);
  console.log(`cachedChats: ${cachedChats}`);
  console.log(`daemon: ${daemonPid && isProcessRunning(daemonPid) ? `running (${daemonPid})` : "stopped"}`);
}

async function logoutCommand(): Promise<void> {
  const daemonPid = readDaemonPid();
  if (daemonPid && isProcessRunning(daemonPid)) {
    process.kill(daemonPid, "SIGTERM");
  }
  await clearState();
  clearCache();
  removeDaemonPid();
  console.log("Cleared session, runtime state, and local cache.");
}

function updateRuntimeFromMessage(runtime: RuntimeState, msg: WeixinMessage): RuntimeState {
  if (!msg.from_user_id || !msg.context_token) {
    return touchRuntime(runtime);
  }

  return touchRuntime({
    ...runtime,
    peers: {
      ...runtime.peers,
      [msg.from_user_id]: {
        userId: msg.from_user_id,
        contextToken: msg.context_token,
        lastSeenAt: formatTs(msg.create_time_ms),
      },
    },
  });
}

async function peersCommand(): Promise<void> {
  const runtime = await loadRuntime();
  const peers = Object.values(runtime.peers).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (peers.length === 0) {
    console.log("No cached peers. Run `wx watch` and receive at least one message first.");
    return;
  }

  for (const peer of peers) {
    const alias = findAliasByUserId(runtime, peer.userId) ?? "-";
    console.log(`${alias}\t${peer.userId}\t${peer.lastSeenAt}`);
  }
}

async function recentCommand(): Promise<void> {
  const runtime = await loadRuntime();
  const peers = Object.values(runtime.peers).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (peers.length === 0) {
    console.log("No recent chats yet. Run `wx watch` and wait for an incoming message.");
    return;
  }

  console.log(`${pad("ALIAS", 16)} ${pad("USER ID", 40)} LAST SEEN`);
  for (const peer of peers) {
    const alias = findAliasByUserId(runtime, peer.userId) ?? "-";
    console.log(`${pad(alias, 16)} ${pad(peer.userId, 40)} ${peer.lastSeenAt}`);
  }
}

async function aliasCommand(args: ParsedArgs): Promise<void> {
  const runtime = await loadRuntime();
  const [subcommand, ...rest] = args.positionals;

  if (!subcommand || subcommand === "list") {
    const aliases = Object.values(runtime.aliases).sort((a, b) => a.alias.localeCompare(b.alias));
    if (aliases.length === 0) {
      console.log("No aliases yet.");
      return;
    }

    console.log(`${pad("ALIAS", 16)} ${pad("USER ID", 40)} UPDATED AT`);
    for (const record of aliases) {
      console.log(`${pad(record.alias, 16)} ${pad(record.userId, 40)} ${record.updatedAt}`);
    }
    return;
  }

  if (subcommand === "set") {
    const [aliasRaw, userIdRaw] = rest;
    if (!aliasRaw || !userIdRaw) {
      throw new Error("Usage: wx alias set <alias> <user-id>");
    }

    const alias = aliasRaw.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
      throw new Error("Alias may only contain letters, numbers, dot, underscore, and hyphen.");
    }

    const target = resolveTarget(runtime, userIdRaw.trim());
    const nextRuntime = touchRuntime({
      ...runtime,
      aliases: {
        ...runtime.aliases,
        [alias]: {
          alias,
          userId: target.userId,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    await saveRuntime(nextRuntime);
    console.log(`Alias ${alias} -> ${target.userId} saved.`);
    return;
  }

  if (subcommand === "rm") {
    const [alias] = rest;
    if (!alias) {
      throw new Error("Usage: wx alias rm <alias>");
    }
    if (!runtime.aliases[alias]) {
      throw new Error(`Alias not found: ${alias}`);
    }

    const nextAliases = { ...runtime.aliases };
    delete nextAliases[alias];
    await saveRuntime(touchRuntime({ ...runtime, aliases: nextAliases }));
    console.log(`Alias ${alias} removed.`);
    return;
  }

  throw new Error("Usage: wx alias [list] | wx alias set <alias> <user-id> | wx alias rm <alias>");
}

async function watchCommand(flags: Record<string, string | boolean>): Promise<void> {
  let runtime = await loadRuntime();
  let cache = loadCache();
  const printJson = hasFlag(flags, "json");
  const cacheOnly = hasFlag(flags, "cache-only");
  const { client } = await loginEphemeral({ fresh: hasFlag(flags, "fresh"), stderr: printJson || cacheOnly });

  client.on("message", (msg) => {
    if (msg.message_type !== MessageType.USER) {
      return;
    }
    void handleIncomingMessage(msg);
  });

  async function handleIncomingMessage(msg: WeixinMessage): Promise<void> {
    const attachments = await downloadMessageAttachments(client, msg);
    const enriched: WeixinMessageWithAttachments = attachments.length > 0
      ? { ...msg, attachments }
      : msg;
    runtime = updateRuntimeFromMessage(runtime, msg);
    void saveRuntime(runtime);
    if (msg.from_user_id) {
      cache = appendCachedMessage(cache, msg.from_user_id, {
        direction: "in",
        text: describeMessageForCache(msg, attachments),
        timestamp: formatTs(msg.create_time_ms),
      });
      saveCache(cache);
    }

    if (printJson) {
      console.log(JSON.stringify(enriched));
      return;
    }
    if (cacheOnly) {
      return;
    }

    const from = msg.from_user_id ?? "unknown";
    const alias = from === "unknown" ? undefined : findAliasByUserId(runtime, from);
    const text = describeMessageForCache(msg, attachments);
    const label = alias ? `${alias} (${from})` : from;
    console.log(`[${formatTs(msg.create_time_ms)}] ${label}: ${text}`);
  }

  client.on("error", (error) => {
    console.error(`poll error: ${error.message}`);
  });

  client.on("sessionExpired", () => {
    console.error("Session expired. Restart this command to scan a new QR code.");
    process.exitCode = 2;
    client.stop();
  });

  const stopWatching = () => {
    client.stop();
  };
  process.on("SIGINT", stopWatching);
  process.on("SIGTERM", stopWatching);
  process.on("exit", () => {
    const daemonPid = readDaemonPid();
    if (cacheOnly && daemonPid === process.pid) {
      removeDaemonPid();
    }
  });

  if (!cacheOnly) {
    console.log("Watching for incoming messages. Press Ctrl+C to stop.");
  }
  await client.start(
    hasFlag(flags, "resume")
      ? {
          loadSyncBuf: () => runtime.syncBuf,
          saveSyncBuf: async (buf) => {
            runtime = touchRuntime({
              ...runtime,
              syncBuf: buf,
            });
            await saveRuntime(runtime);
          },
        }
      : {},
  );
}

async function bridgeCommand(flags: Record<string, string | boolean>): Promise<void> {
  let runtime = await loadRuntime();
  let cache = loadCache();
  const printJson = hasFlag(flags, "json");
  const { client } = await loginEphemeral({ fresh: hasFlag(flags, "fresh"), stderr: printJson });
  let stdinBuffer = "";

  client.on("message", (msg) => {
    if (msg.message_type !== MessageType.USER) {
      return;
    }
    void handleIncomingMessage(msg);
  });

  async function handleIncomingMessage(msg: WeixinMessage): Promise<void> {
    const attachments = await downloadMessageAttachments(client, msg);
    const enriched: WeixinMessageWithAttachments = attachments.length > 0
      ? { ...msg, attachments }
      : msg;
    runtime = updateRuntimeFromMessage(runtime, msg);
    void saveRuntime(runtime);
    if (msg.from_user_id) {
      cache = appendCachedMessage(cache, msg.from_user_id, {
        direction: "in",
        text: describeMessageForCache(msg, attachments),
        timestamp: formatTs(msg.create_time_ms),
      });
      saveCache(cache);
    }

    if (printJson) {
      console.log(JSON.stringify(enriched));
      return;
    }

    const from = msg.from_user_id ?? "unknown";
    const alias = from === "unknown" ? undefined : findAliasByUserId(runtime, from);
    const text = describeMessageForCache(msg, attachments);
    const label = alias ? `${alias} (${from})` : from;
    console.log(`[${formatTs(msg.create_time_ms)}] ${label}: ${text}`);
  }

  client.on("error", (error) => {
    console.error(`poll error: ${error.message}`);
  });

  client.on("sessionExpired", () => {
    console.error("Session expired. Restart this command to scan a new QR code.");
    process.exitCode = 2;
    client.stop();
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    let idx: number;
    while ((idx = stdinBuffer.indexOf("\n")) >= 0) {
      const line = stdinBuffer.slice(0, idx).trim();
      stdinBuffer = stdinBuffer.slice(idx + 1);
      if (!line) continue;
      void handleBridgeLine(line).catch((error) => {
        console.error(`bridge command failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  async function handleBridgeLine(line: string): Promise<void> {
    let command: unknown;
    try {
      command = JSON.parse(line);
    } catch (error) {
      console.error(`bridge command parse failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!command || typeof command !== "object") {
      console.error("bridge command must be a JSON object.");
      return;
    }
    const record = command as Record<string, unknown>;
    if (record.cmd !== "send" && record.cmd !== "sendMedia") {
      console.error(`bridge command ignored: ${String(record.cmd ?? "unknown")}`);
      return;
    }
    const to = typeof record.to === "string" ? record.to : "";
    const text = typeof record.text === "string" ? record.text : "";
    const filePath = typeof record.path === "string" ? record.path : "";
    const caption = typeof record.caption === "string" ? record.caption : undefined;
    const commandId = typeof record.id === "string" ? record.id : undefined;
    const explicitContextToken = typeof record.contextToken === "string" ? record.contextToken : undefined;
    if (!to || (!text && !filePath)) {
      console.error("bridge send requires `to` and either `text` or `path`.");
      return;
    }

    const latestRuntime = await loadRuntime();
    const target = resolveTarget(latestRuntime, to);
    const contextToken = explicitContextToken ?? latestRuntime.peers[target.userId]?.contextToken;
    if (!contextToken) {
      console.error(`No cached context token for ${target.userId}. Receive a message from that peer first.`);
      return;
    }

    try {
      if (filePath) {
        await client.sendMedia(target.userId, filePath, caption, contextToken);
      } else {
        await client.sendText(target.userId, text, contextToken);
      }
      const cacheText = filePath
        ? `[file] ${filePath}${caption ? ` ${caption}` : ""}`
        : text;
      cache = appendCachedMessage(loadCache(), target.userId, {
        direction: "out",
        text: cacheText,
        timestamp: new Date().toISOString(),
      });
      saveCache(cache);
      if (printJson && commandId) {
        console.log(JSON.stringify({ bridge_event: "send.ok", id: commandId, cmd: record.cmd, to: target.userId }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (printJson && commandId) {
        console.log(JSON.stringify({ bridge_event: "send.error", id: commandId, cmd: record.cmd, to: target.userId, error: message }));
      } else {
        console.error(`bridge command failed: ${message}`);
      }
    }
  }

  const stopWatching = () => {
    client.stop();
  };
  process.on("SIGINT", stopWatching);
  process.on("SIGTERM", stopWatching);

  if (!printJson) {
    console.log("Bridge is running. Send JSON lines on stdin. Press Ctrl+C to stop.");
  }

  await client.start(
    hasFlag(flags, "resume")
      ? {
          loadSyncBuf: () => runtime.syncBuf,
          saveSyncBuf: async (buf) => {
            runtime = touchRuntime({
              ...runtime,
              syncBuf: buf,
            });
            await saveRuntime(runtime);
          },
        }
      : {},
  );
}

async function daemonCommand(args: ParsedArgs): Promise<void> {
  const [subcommand] = args.positionals;
  const pid = readDaemonPid();
  const running = pid != null && isProcessRunning(pid);

  if (subcommand === "status" || !subcommand) {
    if (running) {
      console.log(`running\tpid=${pid}\tlog=${getDaemonLogPath()}`);
      return;
    }
    console.log("stopped");
    if (pid != null) {
      removeDaemonPid();
    }
    return;
  }

  if (subcommand === "start") {
    if (running) {
      console.log(`Already running with pid ${pid}.`);
      return;
    }
    if (pid != null) {
      removeDaemonPid();
    }

    const scriptPath = fileURLToPath(import.meta.url);
    const logFd = fs.openSync(getDaemonLogPath(), "a", 0o600);
    const child = spawn(
      process.execPath,
      [scriptPath, "watch", "--resume", "--cache-only"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    if (!child.pid) {
      fs.closeSync(logFd);
      throw new Error("Failed to start daemon process.");
    }
    writeDaemonPid(child.pid);
    fs.closeSync(logFd);
    console.log(`Started daemon pid=${child.pid} log=${getDaemonLogPath()}`);
    return;
  }

  if (subcommand === "stop") {
    if (!running || pid == null) {
      console.log("Daemon is not running.");
      if (pid != null) {
        removeDaemonPid();
      }
      return;
    }
    process.kill(pid, "SIGTERM");
    removeDaemonPid();
    console.log(`Stopped daemon pid=${pid}.`);
    return;
  }

  throw new Error("Usage: wx daemon start|stop|status");
}

async function tailCommand(args: ParsedArgs): Promise<void> {
  const [targetRaw] = args.positionals;
  if (!targetRaw) {
    throw new Error("Usage: wx tail [--limit <n>] <user-id|alias>");
  }

  const limitRaw = getFlagString(args.flags, "limit");
  const limit = limitRaw ? Number(limitRaw) : 10;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("`--limit` must be a positive integer.");
  }

  const runtime = await loadRuntime();
  const { target, messages } = getRecentMessagesForTarget(runtime, targetRaw, limit);
  if (messages.length === 0) {
    throw new Error(
      `No cached messages for ${formatTargetLabel(target)}. Start \`wx daemon start\` or run \`wx watch\` first.`,
    );
  }

  printRecentMessages(target, messages);
}

async function chatCommand(args: ParsedArgs): Promise<void> {
  const [targetRaw] = args.positionals;
  if (!targetRaw) {
    throw new Error("Usage: wx chat <user-id|alias>");
  }

  const runtime = await loadRuntime();
  const target = resolveTarget(runtime, targetRaw);
  const initialMessages = getRecentMessagesForTarget(runtime, targetRaw, 10).messages;

  console.log(`Chat with ${formatTargetLabel(target)}`);
  if (initialMessages.length > 0) {
    printRecentMessages(target, initialMessages);
  } else {
    console.log("No cached messages yet. Start `wx daemon start` if you want incoming messages to appear here later.");
  }
  console.log("Commands: /tail, /tail N, /exit");

  const { client } = await loginEphemeral();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const line = (await rl.question(`${target.alias ?? target.userId}> `)).trim();
      if (!line) {
        continue;
      }
      if (line === "/exit" || line === "/quit") {
        break;
      }
      if (line.startsWith("/tail")) {
        const [, limitRaw] = line.split(/\s+/, 2);
        const limit = limitRaw ? Number(limitRaw) : 10;
        if (!Number.isInteger(limit) || limit <= 0) {
          console.log("Usage: /tail [positive-integer]");
          continue;
        }
        const { messages } = getRecentMessagesForTarget(await loadRuntime(), target.userId, limit);
        if (messages.length === 0) {
          console.log("No cached messages.");
          continue;
        }
        printRecentMessages(target, messages);
        continue;
      }

      const latestRuntime = await loadRuntime();
      const latestTarget = resolveTarget(latestRuntime, target.userId);
      const contextToken = latestRuntime.peers[latestTarget.userId]?.contextToken;
      if (!contextToken) {
        console.log("No cached context token for this contact. Receive one message from them first, then try again.");
        continue;
      }

      await client.sendText(latestTarget.userId, line, contextToken);
      const cache = appendCachedMessage(loadCache(), latestTarget.userId, {
        direction: "out",
        text: line,
        timestamp: new Date().toISOString(),
      });
      saveCache(cache);
      console.log(`[${new Date().toISOString()}] > ${line}`);
    }
  } finally {
    rl.close();
  }
}

async function sendCommand(args: ParsedArgs): Promise<void> {
  const [targetRaw, ...textParts] = args.positionals;
  if (!targetRaw || textParts.length === 0) {
    throw new Error("Usage: wx send [--context-token <token>] <user-id|alias> <text>");
  }

  const runtime = await loadRuntime();
  const target = resolveTarget(runtime, targetRaw);
  const contextToken = getFlagString(args.flags, "context-token") ?? runtime.peers[target.userId]?.contextToken;
  if (!contextToken) {
    throw new Error(
      `No cached context token for ${target.userId}. Run \`wx watch\` and receive a message from that peer first, or pass --context-token.`,
    );
  }

  const { client } = await loginEphemeral();

  await client.sendText(target.userId, textParts.join(" "), contextToken);
  const cache = appendCachedMessage(loadCache(), target.userId, {
    direction: "out",
    text: textParts.join(" "),
    timestamp: new Date().toISOString(),
  });
  saveCache(cache);
  console.log(`Sent message to ${target.alias ? `${target.alias} (${target.userId})` : target.userId}.`);
}

async function sendFileCommand(args: ParsedArgs): Promise<void> {
  const [targetRaw, filePath, ...captionParts] = args.positionals;
  if (!targetRaw || !filePath) {
    throw new Error("Usage: wx send-file [--context-token <token>] <user-id|alias> <file-path> [caption]");
  }

  const runtime = await loadRuntime();
  const target = resolveTarget(runtime, targetRaw);
  const contextToken = getFlagString(args.flags, "context-token") ?? runtime.peers[target.userId]?.contextToken;
  if (!contextToken) {
    throw new Error(
      `No cached context token for ${target.userId}. Run \`wx watch\` and receive a message from that peer first, or pass --context-token.`,
    );
  }

  const { client } = await loginEphemeral();
  const caption = captionParts.join(" ") || undefined;

  await client.sendMedia(target.userId, filePath, caption, contextToken);
  const cache = appendCachedMessage(loadCache(), target.userId, {
    direction: "out",
    text: `[file] ${filePath}${caption ? ` ${caption}` : ""}`,
    timestamp: new Date().toISOString(),
  });
  saveCache(cache);
  console.log(`Sent file to ${target.alias ? `${target.alias} (${target.userId})` : target.userId}.`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (command) {
    case "login":
      await loginCommand(args.flags);
      return;
    case "status":
      await statusCommand();
      return;
    case "logout":
      await logoutCommand();
      return;
    case "watch":
      await watchCommand(args.flags);
      return;
    case "bridge":
      await bridgeCommand(args.flags);
      return;
    case "daemon":
      await daemonCommand(args);
      return;
    case "peers":
      await peersCommand();
      return;
    case "recent":
      await recentCommand();
      return;
    case "chat":
      await chatCommand(args);
      return;
    case "tail":
      await tailCommand(args);
      return;
    case "alias":
      await aliasCommand(args);
      return;
    case "send":
      await sendCommand(args);
      return;
    case "send-file":
      await sendFileCommand(args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
