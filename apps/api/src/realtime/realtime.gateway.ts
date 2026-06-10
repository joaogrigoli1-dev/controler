import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RT_CHANNELS } from "../shared";
import { requireAccessSecret } from "../common/crypto.util";

// BE-01: CORS restrito às origens conhecidas (antes: origin: true = qualquer origem)
const WS_ALLOWED_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^https?:\/\/(noc\.controler|painel\.controler|controler)\.net\.br$/,
  /^https?:\/\/[a-z0-9-]+\.62\.72\.63\.18\.sslip\.io$/
];

@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || WS_ALLOWED_ORIGINS.some(rx => rx.test(origin))) return cb(null, true);
      cb(new Error("CORS blocked"), false);
    },
    credentials: true
  },
  path: "/ws"
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger("WS");

  constructor(private readonly jwt: JwtService) {}

  /** BE-01: valida JWT no handshake — conexão sem token válido é desconectada. */
  handleConnection(socket: Socket) {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers.authorization || "").toString().replace(/^Bearer\s+/i, "");
    try {
      if (!token) throw new Error("missing token");
      const payload: any = this.jwt.verify(token, { secret: requireAccessSecret() });
      socket.data.user = { id: payload.sub, name: payload.name, role: payload.role };
    } catch {
      this.log.warn(`WS rejeitado (sem JWT válido) ${socket.id} ip=${socket.handshake.address}`);
      socket.disconnect(true);
      return;
    }
    this.log.log(`connected ${socket.id} user=${socket.data.user?.name} (n=${this.server.engine.clientsCount})`);
  }
  handleDisconnect(socket: Socket) {
    this.log.log(`disconnected ${socket.id}`);
  }

  emitHostMetrics(payload: unknown) {
    this.server.emit(RT_CHANNELS.HOST_METRICS, payload);
  }
  emitContainerMetrics(payload: unknown) {
    this.server.emit(RT_CHANNELS.CONTAINER_METRICS, payload);
  }
  emitTimeline(payload: unknown) {
    this.server.emit(RT_CHANNELS.TIMELINE, payload);
  }
  emitAlert(payload: unknown) {
    this.server.emit(RT_CHANNELS.ALERT_FIRED, payload);
  }
  emitDeploy(payload: unknown) {
    this.server.emit(RT_CHANNELS.DEPLOY_UPDATE, payload);
  }
}
