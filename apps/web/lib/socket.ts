"use client";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import { getAccessToken } from "./api";

let socket: Socket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reconexão resiliente: o gateway derruba (server disconnect) handshakes sem JWT
 * válido — e o socket.io NÃO reconecta sozinho nesse caso. Após um reload o access
 * token só existe em memória depois do 1º refresh, então tentamos reconectar em
 * loop curto; assim que o token estiver disponível, o handshake passa.
 */
function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (socket && !socket.connected) socket.connect();
  }, 2500);
}

export function getSocket(): Socket {
  if (!socket) {
    // Mesma origem do app — o /ws é roteado pelo Traefik até o gateway da API.
    // NEXT_PUBLIC_WS_URL é ignorado de propósito: já apontou para um domínio
    // inexistente (painel.*), quebrando o realtime. Usar sempre o host atual.
    const url =
      typeof window !== "undefined"
        ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`
        : "";
    socket = io(url, {
      path: "/ws",
      // websocket é o preferido; polling é fallback quando o upgrade WS falha no proxy.
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
      // BE-01: o gateway exige JWT no handshake — função reavaliada a cada (re)conexão,
      // pega sempre o token mais recente (pós-refresh). A-02: token vem da memória.
      auth: cb => cb({ token: getAccessToken() })
    });

    // Auth ausente/expirada → server disconnect (não reconecta sozinho): reagenda.
    socket.on("connect_error", scheduleReconnect);
    socket.on("disconnect", reason => {
      if (reason === "io server disconnect") scheduleReconnect();
    });
  }
  return socket;
}

/** Desconecta e descarta o socket (usado no logout — evita reconectar com token antigo). */
export function disposeSocket() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function useSocketEvent<T = any>(event: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const s = getSocket();
    const handler = (payload: T) => setData(payload);
    s.on(event, handler);
    return () => { s.off(event, handler); };
  }, [event]);
  return data;
}
