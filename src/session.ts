import { deleteSecret, getSecret } from "./keychain.js";
import { getRuntimePath, loadStateFile, removeStateFile, saveStateFile } from "./storage.js";

export interface SavedSession {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
}

export interface PeerRecord {
  userId: string;
  contextToken: string;
  lastSeenAt: string;
}

export interface AliasRecord {
  alias: string;
  userId: string;
  updatedAt: string;
}

export interface RuntimeState {
  peers: Record<string, PeerRecord>;
  aliases: Record<string, AliasRecord>;
  syncBuf?: string;
  updatedAt?: string;
}

const SESSION_SERVICE = "wx-ilink-cli/session";
const RUNTIME_SERVICE = "wx-ilink-cli/runtime";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function loadLegacyRuntime(): Promise<Partial<RuntimeState>> {
  return parseJson<Partial<RuntimeState>>(await getSecret(RUNTIME_SERVICE), {});
}

async function deleteLegacyRuntimeSecrets(): Promise<void> {
  await Promise.all([
    deleteSecret(SESSION_SERVICE).catch(() => {}),
    deleteSecret(RUNTIME_SERVICE).catch(() => {}),
  ]);
}

export async function loadSession(): Promise<SavedSession | null> {
  return null;
}

export async function saveSession(_session: SavedSession): Promise<void> {
  return;
}

export async function loadRuntime(): Promise<RuntimeState> {
  const fromFile = loadStateFile<Partial<RuntimeState>>(getRuntimePath(), {});
  if (
    fromFile.updatedAt ||
    fromFile.syncBuf ||
    Object.keys(fromFile.peers ?? {}).length > 0 ||
    Object.keys(fromFile.aliases ?? {}).length > 0
  ) {
    return {
      peers: fromFile.peers ?? {},
      aliases: fromFile.aliases ?? {},
      syncBuf: fromFile.syncBuf,
      updatedAt: fromFile.updatedAt,
    };
  }

  const legacy = await loadLegacyRuntime();
  return {
    peers: legacy.peers ?? {},
    aliases: legacy.aliases ?? {},
    syncBuf: legacy.syncBuf,
    updatedAt: legacy.updatedAt,
  };
}

export async function saveRuntime(runtime: RuntimeState): Promise<void> {
  saveStateFile(getRuntimePath(), runtime);
  await deleteLegacyRuntimeSecrets();
}

export async function clearState(): Promise<void> {
  removeStateFile(getRuntimePath());
  await deleteLegacyRuntimeSecrets();
}

export async function clearSession(): Promise<void> {
  await deleteSecret(SESSION_SERVICE).catch(() => {});
}

export function touchRuntime(runtime: RuntimeState): RuntimeState {
  return {
    ...runtime,
    updatedAt: new Date().toISOString(),
  };
}
