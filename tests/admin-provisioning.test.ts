import { it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../server/store";
it("provisions into the same .env database as the server, keeps credentials private and refuses overwrites", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentrader-provision-"));
  const env = { ...process.env };
  delete env.DATABASE_PATH;
  const command = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/create-admin.ts"),
        ...args,
      ],
      { cwd: directory, env, encoding: "utf8" },
    );
  let store: Store | undefined;
  try {
    writeFileSync(
      join(directory, ".env"),
      "DATABASE_PATH=./custom/economy.sqlite\n",
    );
    const run = command();
    expect(run.status, run.stderr).toBe(0);
    const database = join(directory, "custom/economy.sqlite");
    expect(existsSync(database)).toBe(true);
    expect(existsSync(join(directory, "data/opentrader.sqlite"))).toBe(false);
    const credentials = join(directory, "data/admin-credentials.txt");
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    const receipt = readFileSync(credentials, "utf8"),
      password = /Password: (.+)/.exec(receipt)![1]!;
    expect((run.stdout + run.stderr).includes(password)).toBe(false);
    store = new Store({ path: database });
    expect(store.login("admin", password).user).toMatchObject({
      platformRole: "ADMIN",
      status: "APPROVED",
    });
    const duplicate = command();
    expect(duplicate.status).not.toBe(0);
    expect(readFileSync(credentials, "utf8") === receipt).toBe(true);
    const duplicateHandle = command("--credentials", "data/another.txt");
    expect(duplicateHandle.status).not.toBe(0);
    expect(existsSync(join(directory, "data/another.txt"))).toBe(false);
    expect(store.reconcileSystem().balanced).toBe(true);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
