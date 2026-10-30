// Minimal RFC 6455 WebSocket server side, enough for the LuzCrawl extension link: text messages (fragmented or not),
// ping/pong and close. Server frames are never masked; client frames must be.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 128 * 1024 * 1024;
export const OPEN = 1;
export const CLOSED = 3;

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', (error) => {
      this.emit('error', error);
      this.finish();
    });
  }

  send(text, callback) {
    if (this.readyState !== OPEN) {
      callback?.(new Error('WebSocket is not open'));
      return;
    }
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')), callback);
  }

  ping() {
    if (this.readyState === OPEN) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.socket.end(frame(0x8, payload));
    this.finish();
  }

  terminate() {
    this.socket.destroy();
    this.finish();
  }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readyState === OPEN) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) return;
      if (parsed.error) {
        this.close(parsed.error);
        return;
      }
      this.buffer = this.buffer.subarray(parsed.length);
      this.handle(parsed);
    }
  }

  handle({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) {
      this.emit('pong');
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
      this.close(1002);
      return;
    }
    if (opcode !== 0x0 && this.fragments.length) {
      this.close(1002);
      return;
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE) {
      this.close(1009);
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.emit('message', message.toString('utf8'));
  }
}

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

// Returns null when more bytes are needed, { error } for a protocol violation, or the decoded frame.
function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  if (!masked) return { error: 1002 };
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE)) return { error: 1009 };
    length = Number(big);
    offset = 10;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, length: offset + 4 + length };
}

// Completes the handshake for an HTTP 'upgrade' request; returns the connection, or null after rejecting it.
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const connection = new WebSocketConnection(socket);
  if (head?.length) connection.receive(head);
  return connection;
}
