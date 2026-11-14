import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createApp } from "./app";

if (existsSync(".env")) loadEnvFile(".env");
const app = await createApp({
  logger: true,
  serveStatic: process.env.NODE_ENV === "production",
});
const port = Number(
  process.env.PORT ?? (process.env.NODE_ENV === "production" ? 3000 : 3001),
);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535");
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
