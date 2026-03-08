import type { User } from "../session/User";
import WebSocket from "ws";

export interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * PhotoManager — captures, stores, and broadcasts photos for a single user.
 */
export class PhotoManager {
  private photos: Map<string, StoredPhoto> = new Map();
  private sseClients: Set<SSEWriter> = new Set();
  private uploaderSocket: WebSocket | null = null;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private shouldReconnectUploader = false;
  private captureInProgress = false;

  private readonly streamWebsocketUrl = this.normalizeWebsocketUrl(
    process.env.CAMERA_STREAM_WS_URL ||
      "https://lotic-oralia-arseno.ngrok-free.dev",
  );
  private readonly captureIntervalMs = Number.parseInt(
    process.env.CAMERA_STREAM_INTERVAL_MS || "1000",
    10,
  );

  constructor(private user: User) {}

  private normalizeWebsocketUrl(url: string): string {
    if (url.startsWith("https://")) return url.replace("https://", "wss://");
    if (url.startsWith("http://")) return url.replace("http://", "ws://");
    return url;
  }

  /** Start continuous capture + websocket upload loop */
  setup(): void {
    this.shouldReconnectUploader = true;
    this.ensureUploaderSocket();

    if (this.captureInterval) {
      return;
    }

    this.captureInterval = setInterval(async () => {
      if (this.captureInProgress) return;

      try {
        this.captureInProgress = true;
        await this.takePhoto();
      } catch (err) {
        console.error(`Failed to capture/upload frame for ${this.user.userId}:`, err);
      } finally {
        this.captureInProgress = false;
      }
    }, this.captureIntervalMs);

    console.log(
      `🎥 Continuous camera upload enabled for ${this.user.userId} (${this.captureIntervalMs}ms interval)`,
    );
  }

  /** Capture a photo from the glasses and store + broadcast it */
  async takePhoto(): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");

    const photo = await session.camera.requestPhoto();

    const stored: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId: this.user.userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
    };

    this.photos.set(photo.requestId, stored);
    this.broadcastPhoto(stored);
    this.uploadPhoto(stored);
    console.log(
      `📸 Photo captured for ${this.user.userId} (${photo.size} bytes)`,
    );
  }

  /** Send the photo payload to the external websocket endpoint */
  private uploadPhoto(photo: StoredPhoto): void {
    this.ensureUploaderSocket();

    if (!this.uploaderSocket || this.uploaderSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = JSON.stringify({
      type: "camera-frame",
      userId: photo.userId,
      requestId: photo.requestId,
      timestamp: photo.timestamp.toISOString(),
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
      imageBase64: photo.buffer.toString("base64"),
    });

    this.uploaderSocket.send(message);
  }

  private ensureUploaderSocket(): void {
    if (
      this.uploaderSocket &&
      (this.uploaderSocket.readyState === WebSocket.OPEN ||
        this.uploaderSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.uploaderSocket = new WebSocket(this.streamWebsocketUrl);

    this.uploaderSocket.on("open", () => {
      console.log(
        `🔌 Connected websocket uploader for ${this.user.userId}: ${this.streamWebsocketUrl}`,
      );
    });

    this.uploaderSocket.on("close", () => {
      this.uploaderSocket = null;

      if (!this.shouldReconnectUploader) return;

      setTimeout(() => this.ensureUploaderSocket(), 2000);
    });

    this.uploaderSocket.on("error", (err) => {
      console.error(`Websocket uploader error for ${this.user.userId}:`, err);
    });
  }


  isUploaderConnected(): boolean {
    return this.uploaderSocket?.readyState === WebSocket.OPEN;
  }

  getUploaderReadyStateLabel(): string {
    if (!this.uploaderSocket) return "CLOSED";

    switch (this.uploaderSocket.readyState) {
      case WebSocket.CONNECTING:
        return "CONNECTING";
      case WebSocket.OPEN:
        return "OPEN";
      case WebSocket.CLOSING:
        return "CLOSING";
      case WebSocket.CLOSED:
      default:
        return "CLOSED";
    }
  }

  getUploaderWebsocketUrl(): string {
    return this.streamWebsocketUrl;
  }

  /** Push a photo to all connected SSE clients */
  broadcastPhoto(photo: StoredPhoto): void {
    const base64Data = photo.buffer.toString("base64");
    const payload = JSON.stringify({
      requestId: photo.requestId,
      timestamp: photo.timestamp.getTime(),
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
      userId: photo.userId,
      base64: base64Data,
      dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
    });

    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  getPhoto(requestId: string): StoredPhoto | undefined {
    return this.photos.get(requestId);
  }

  /** All photos for this user, sorted newest-first */
  getAll(): StoredPhoto[] {
    return Array.from(this.photos.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
  }

  /** The full photos map (used by SSE to send history on connect) */
  getAllMap(): Map<string, StoredPhoto> {
    return this.photos;
  }

  removeAll(): void {
    this.photos.clear();
  }

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client);
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client);
  }

  stopContinuousUpload(): void {
    this.shouldReconnectUploader = false;

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.uploaderSocket) {
      this.uploaderSocket.close();
      this.uploaderSocket = null;
    }
  }

  /** Tear down — clear photos and SSE clients */
  destroy(): void {
    this.stopContinuousUpload();

    this.photos.clear();
    this.sseClients.clear();
  }
}
