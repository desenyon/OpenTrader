import { randomBytes } from "node:crypto";
import {
  openSync,
  closeSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../server/store.js";
if (existsSync(".env")) loadEnvFile(".env");
const { values } = parseArgs({
  options: {
    handle: { type: "string", default: "admin" },
    database: { type: "string" },
    credentials: { type: "string" },
  },
});
const database = resolve(
  values.database ?? process.env.DATABASE_PATH ?? "data/opentrader.sqlite",
);
const credentials = resolve(values.credentials ?? "data/admin-credentials.txt");
mkdirSync(dirname(credentials), { recursive: true });
// Never overwrite an existing credential receipt. Passwords are not CLI arguments or stdout.
const fd = openSync(credentials, "wx", 0o600);
let store: Store | undefined;
try {
  const password = randomBytes(30).toString("base64url");
  store = new Store({ path: database });
  const admin = store.atomic(() => {
    const created = store!.createAdmin(values.handle!, password);
    writeFileSync(
      fd,
      `OpenTrader platform administrator\nHandle: ${created.user.handle}\nPassword: ${password}\nSign in: http://localhost:3000\nDashboard: http://localhost:3000/#/admin\n\nKeep this file private. Credits are fictional and nonredeemable.\n`,
      { encoding: "utf8" },
    );
    return created;
  });
  console.log(
    `Created administrator ${admin.user.handle}. Credentials saved privately to ${credentials}`,
  );
} catch (error) {
  unlinkSync(credentials);
  console.error(
    error instanceof Error
      ? error.message
      : "Administrator provisioning failed",
  );
  process.exitCode = 1;
} finally {
  closeSync(fd);
  store?.close();
}
