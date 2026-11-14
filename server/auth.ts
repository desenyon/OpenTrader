import type { FastifyRequest } from "fastify";
import { Store, fail } from "./store.js";
export function currentUser(request: FastifyRequest, store: Store) {
  return store.authenticate(request.cookies.session);
}
export function requireUser(request: FastifyRequest, store: Store) {
  return (
    currentUser(request, store) ??
    fail(401, "AUTH_REQUIRED", "Sign in to continue")
  );
}
export const getUser = currentUser;
