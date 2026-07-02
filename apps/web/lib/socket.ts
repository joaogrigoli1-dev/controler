"use client";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";
import { getAccessToken } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_WS_URL || (typeof window !== "undefined" ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}` : "");
    socket = io(url, {
      path: "/ws",
      transports: ["websocket"],
      autoConnect: true,
      // BE-01: o gateway exige JWT no handshake — função é reavaliada a cada (re)conexão,
      // então pega sempre o token mais recente (pós-refresh). A-02: token vem da memória.
      auth: cb => cb({ token: getAccessToken() })
    });
  }
  return socket;
}

/** Desconecta e descarta o socket (usado no logout — evita reconectar com token antigo). */
export function disposeSocket() {
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
