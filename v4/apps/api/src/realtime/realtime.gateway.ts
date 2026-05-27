import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { RT_CHANNELS } from "../../../../packages/shared/src";

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  path: "/ws"
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger("WS");

  handleConnection(socket: Socket) {
    this.log.log(`connected ${socket.id} (n=${this.server.engine.clientsCount})`);
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
