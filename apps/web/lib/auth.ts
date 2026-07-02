"use client";

import { setAccessToken, getAccessToken } from "./api";

export const userKey = "controler:user";

// A-02: access token em memória (api.ts); refresh no cookie httpOnly. localStorage guarda
// só o objeto `user` (dado não-sensível de UX), nunca tokens.
export function setSession(token: string, user: any) {
  setAccessToken(token);
  localStorage.setItem(userKey, JSON.stringify(user));
}
export function clearSession() {
  setAccessToken(null);
  localStorage.removeItem(userKey);
}
export function getUser(): any | null {
  try { return JSON.parse(localStorage.getItem(userKey) || "null"); } catch { return null; }
}
/** Sessão presumida se há access token em memória OU user em cache (será revalidado via refresh). */
export function isAuthed() {
  if (getAccessToken()) return true;
  try { return !!localStorage.getItem(userKey); } catch { return false; }
}
