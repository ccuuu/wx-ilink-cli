import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_ACCOUNT = process.env.USER ?? "wx-ilink-cli";

async function runSecurity(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("security", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = [error.message, (error as Error & { stderr?: string }).stderr ?? ""]
    .join("\n")
    .toLowerCase();
  return message.includes("could not be found") || message.includes("item not found");
}

export async function getSecret(service: string, account = DEFAULT_ACCOUNT): Promise<string | null> {
  try {
    return await runSecurity(["find-generic-password", "-a", account, "-s", service, "-w"]);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function setSecret(service: string, value: string, account = DEFAULT_ACCOUNT): Promise<void> {
  await runSecurity(["add-generic-password", "-U", "-a", account, "-s", service, "-w", value]);
}

export async function deleteSecret(service: string, account = DEFAULT_ACCOUNT): Promise<void> {
  try {
    await runSecurity(["delete-generic-password", "-a", account, "-s", service]);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
}
