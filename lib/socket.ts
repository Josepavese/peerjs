import { EventEmitter } from "eventemitter3";
const logger = console;
import { ServerMessageType, SocketEventType } from "./enums";
import { version } from "../package.json";

/**
 * Production-ready, robust WebSocket abstraction for PeerJS.
 * - Instant auto-reconnect: new WebSocket is created immediately on close/error (usher-style).
 * - Clean login/logout; prevents double sockets, race, and starvation.
 * - Queueing and flushing of messages while not connected.
 * - Retrocompatible with PeerJS expectations.
 */
export class Socket extends EventEmitter {
    private _id?: string;
    private _token?: string;
    private _messagesQueue: Array<object> = [];
    private _socket?: WebSocket;
    private _wsPingTimer?: ReturnType<typeof setTimeout>;
    private _wsHealthTimer?: ReturnType<typeof setTimeout>;
    private _connectTimer?: ReturnType<typeof setTimeout>;
    private _instanceId: number = 0; // Used to kill stale sockets/timers
    private _userClosed: boolean = false; // True if closed by user/logout
    private readonly _baseUrl: string;
    private _lastPong: number = Date.now();
    private readonly _pongTimeout: number = 20000; // 20s: consider dead if no heartbeat
    private _reconnectAttempts: number = 0;
    private readonly _maxReconnectAttempts = 10;
    // usher.js: retry ~10/s (100ms), qui usiamo 200ms con backoff dopo troppi errori
    private readonly _minReconnectDelay = 200;   // 200ms, very aggressive
    private readonly _maxReconnectDelay = 30000; // 30s (backoff cap)
    private readonly _pingInterval: number;

    /**
     * @param secure  - Use wss or ws
     * @param host    - Hostname
     * @param port    - Port
     * @param path    - Path to ws endpoint
     * @param key     - PeerJS key
     * @param pingInterval - ms for ping/heartbeat
     */
    constructor(
        secure: boolean,
        host: string,
        port: number,
        path: string,
        key: string,
        pingInterval: number = 5000
    ) {
        super();
        const wsProtocol = secure ? "wss://" : "ws://";
        this._baseUrl = wsProtocol + host + ":" + port + path + "peerjs?key=" + key;
        this._pingInterval = pingInterval;
    }

    /**
     * Start a new connection (login or reconnect).
     * Cleans up any previous connection. Safe to call repeatedly.
     */
    start(id: string, token: string): void {
        logger.log(`[Socket] start() called with id=${id}, token=${token}`);
        this._id = id;
        this._token = token;
        this._userClosed = false;
        this._instanceId++; // Invalidate old sockets/timers

        this._cleanup(); // Ensures only one active socket

        this._openSocket(this._instanceId);
    }

    /**
     * Opens the WebSocket connection (internal).
     * InstanceId ensures that only the most recent connection is active.
     */
    private _openSocket(instanceId: number): void {
        if (this._userClosed) {
            logger.log("[Socket] Not opening socket: user requested close.");
            return;
        }
        if (!this._id || !this._token) {
            logger.error("[Socket] Cannot open socket: missing id/token.");
            return;
        }
        const wsUrl = `${this._baseUrl}&id=${this._id}&token=${this._token}&version=${version}`;
        logger.log(`[Socket] Opening WebSocket to ${wsUrl}`);
        this._socket = new WebSocket(wsUrl);

        // Timeout: if the socket isn't open in 2s, force close (usher uses very short timeouts)
        this._connectTimer = setTimeout(() => {
            if (this._socket && this._socket.readyState !== WebSocket.OPEN) {
                logger.warn(`[Socket] No open in 2000ms, force-closing...`);
                this._socket.close();
            }
        }, 2000);

        // --- WebSocket event handlers ---
        this._socket.onopen = () => {
            if (instanceId !== this._instanceId) return; // Race protection
            if (this._connectTimer) {
                clearTimeout(this._connectTimer);
                this._connectTimer = undefined;
            }
            logger.log("[Socket] Socket open");
            this._reconnectAttempts = 0;
            this._sendQueuedMessages();
            this._lastPong = Date.now();
            this._scheduleHeartbeat();
            this._scheduleHealthCheck();
            this.emit(SocketEventType.Open);
        };

        this._socket.onmessage = (event) => {
            if (instanceId !== this._instanceId) return;
            let data: any;
            try {
                data = JSON.parse(event.data as string);
            } catch { return; }

            if (data.type === ServerMessageType.Heartbeat) {
                this._lastPong = Date.now();
                return;
            }
            this.emit(SocketEventType.Message, data);
        };

        this._socket.onclose = (event) => {
            if (instanceId !== this._instanceId) return;
            logger.log("[Socket] Socket closed.", event);

            this._cleanup();

            if (this._userClosed) {
                logger.log("[Socket] Not reconnecting: closed by user.");
                this.emit(SocketEventType.Disconnected);
                return;
            }

            // --- IMMEDIATE RECONNECT, usher-style ---
            this._immediateReconnect();
            this.emit(SocketEventType.Disconnected);
        };

        this._socket.onerror = (event) => {
            if (instanceId !== this._instanceId) return;
            logger.log("[Socket] Error:", event);
            this._socket!.close(); // Let onclose handle recovery
            this.emit(SocketEventType.Error, event);
        };
    }

    /**
     * IMMEDIATE reconnect: opens a new socket instantly, unless retry limit reached.
     * Fastest recovery, like usher.js (no wait between socket failures).
     */
    private _immediateReconnect(): void {
        if (this._userClosed) {
            logger.log("[Socket] Not reconnecting: closed by user.");
            return;
        }

        // If too many failures, backoff after N attempts (avoid browser/infra flood)
        this._reconnectAttempts++;
        let delay = this._minReconnectDelay;
        if (this._reconnectAttempts > this._maxReconnectAttempts) {
            delay = Math.min(
                this._minReconnectDelay * this._reconnectAttempts,
                this._maxReconnectDelay
            );
            logger.warn(`[Socket] Too many retries, backoff to ${delay}ms`);
        }
        // Open new socket *immediately* or after minimal delay
        const instanceIdAtSchedule = this._instanceId;
        setTimeout(() => {
            if (instanceIdAtSchedule === this._instanceId) {
                logger.log(`[Socket] IMMEDIATE RECONNECT (attempt ${this._reconnectAttempts}, delay=${delay}ms)`);
                this._openSocket(this._instanceId);
            }
        }, delay);
    }

    /** Schedule the next heartbeat ping. */
    private _scheduleHeartbeat(): void {
        if (this._wsPingTimer !== undefined) clearTimeout(this._wsPingTimer);
        this._wsPingTimer = setTimeout(() => this._sendHeartbeat(), this._pingInterval);
    }

    /** Send heartbeat ping to server, closes and reconnects if fails. */
    private _sendHeartbeat(): void {
        if (!this._wsOpen()) {
            logger.log("[Socket] Skipping ping: socket not open.");
            return;
        }
        try {
            this._socket!.send(JSON.stringify({ type: ServerMessageType.Heartbeat }));
        } catch (err) {
            logger.error("[Socket] Heartbeat send failed, closing.", err);
            this._socket!.close();
            return;
        }
        this._scheduleHeartbeat();
    }

    /** Schedules the health check watchdog (watchdog restarts connection if needed). */
    private _scheduleHealthCheck(): void {
        if (this._wsHealthTimer !== undefined) clearTimeout(this._wsHealthTimer);
        this._wsHealthTimer = setTimeout(() => this._checkHealth(), 1000);
    }

    /** Health check: closes if no pong in time, triggers reconnect. */
    private _checkHealth(): void {
        const delta = Date.now() - this._lastPong;
        if (delta > this._pongTimeout) {
            logger.warn(`[Socket] Heartbeat timeout (${delta}ms > ${this._pongTimeout}ms), closing socket.`);
            this.emit(SocketEventType.HeartbeatTimeout);
            this._socket?.close();
            return;
        }
        // logger.log(`[Socket] Heartbeat OK (${delta} ms since last pong).`);
        this._scheduleHealthCheck();
    }

    /** Returns true if the underlying WebSocket is open. */
    private _wsOpen(): boolean {
        return !!this._socket && this._socket.readyState === WebSocket.OPEN;
    }

    /** Flush all queued messages (after open). */
    private _sendQueuedMessages(): void {
        const copiedQueue = [...this._messagesQueue];
        this._messagesQueue = [];
        for (const message of copiedQueue) this.send(message);
    }

    /** Send a message to the server (queue if not ready). */
    send(data: any): void {
        if (this._userClosed) return;
        if (!this._id) {
            this._messagesQueue.push(data);
            return;
        }
        if (!data.type) {
            this.emit(SocketEventType.Error, "Invalid message");
            return;
        }
        if (!this._wsOpen()) {
            this._messagesQueue.push(data);
            return;
        }
        this._socket!.send(JSON.stringify(data));
    }

    /**
     * Cleanly close the socket (logout), stops all timers, disables auto-reconnect.
     * After close(), reconnection requires new start().
     */
    close(): void {
        logger.log("[Socket] close() called by user: closing and disabling reconnect.");
        this._userClosed = true;
        this._instanceId++; // Invalidate all pending reconnects, timers, etc.
        this._cleanup();
    }

    /**
     * Clean up all event listeners, timers, and the socket itself.
     * Safe for repeated calls and for race condition handling.
     */
    private _cleanup(): void {
        if (this._socket) {
            this._socket.onopen = null;
            this._socket.onmessage = null;
            this._socket.onerror = null;
            this._socket.onclose = null;
            this._socket.close();
            this._socket = undefined;
        }
        if (this._connectTimer !== undefined) {
            clearTimeout(this._connectTimer);
            this._connectTimer = undefined;
        }
        if (this._wsHealthTimer !== undefined) {
            clearTimeout(this._wsHealthTimer);
            this._wsHealthTimer = undefined;
        }
        if (this._wsPingTimer !== undefined) {
            clearTimeout(this._wsPingTimer);
            this._wsPingTimer = undefined;
        }
        // Optionally clear message queue here for logout safety:
        // this._messagesQueue = [];
    }
}
