import type { FastifyRequest } from "fastify";
import { Store, fail } from "./store.js";
export function currentUser(request: FastifyRequest, store: Store) {
  return store.authenticate(request.cookies.session);
}
export function requireUser(request: FastifyRequest, store: Store) {
  const identity =
    currentUser(request, store) ??
    fail(401, "AUTH_REQUIRED", "Sign in to continue");
  return store.user(identity.id);
}
export const getUser = currentUser;
