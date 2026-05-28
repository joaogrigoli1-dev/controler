"use client";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_WS_URL || (typeof window !== "undefined" ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}` : "");
    socket = io(url, { path: "/ws", transports: ["websocket"], autoConnect: true });
  }
  return socket;
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
