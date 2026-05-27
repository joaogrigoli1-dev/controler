"use client";

export const tokenKey = "controler:token";
export const refreshKey = "controler:refresh";
export const userKey = "controler:user";

export function setSession(token: string, refresh: string, user: any) {
  localStorage.setItem(tokenKey, token);
  localStorage.setItem(refreshKey, refresh);
  localStorage.setItem(userKey, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(refreshKey);
  localStorage.removeItem(userKey);
}
export function getUser(): any | null {
  try { return JSON.parse(localStorage.getItem(userKey) || "null"); } catch { return null; }
}
export function isAuthed() { return !!localStorage.getItem(tokenKey); }
