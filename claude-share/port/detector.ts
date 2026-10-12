import net from "node:net";

type Handler = (socket: net.Socket) => void;
interface PortDetectorOptions {
  onConnect: Handler;
  onHttp: Handler;
  onTls: Handler;
}
export function sniffSocket(socket: net.Socket, options: PortDetectorOptions, detectTls = true) {
  let buffered = Buffer.alloc(0);
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeListener("data", data);
    socket.removeListener("close", cleanup);
  };
  const timer = setTimeout(() => {
    cleanup();
    socket.destroy();
  }, 5000);
  const data = (chunk: Buffer) => {
    if (buffered.length + chunk.length > 8192) {
      cleanup();
      socket.destroy();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const prefix = buffered.subarray(0, 8).toString("ascii");
    const isTls = detectTls && buffered[0] === 0x16;
    if (!isTls && buffered.length < 8 && "CONNECT ".startsWith(prefix)) return;
    const handler = isTls
      ? options.onTls
      : prefix === "CONNECT "
        ? options.onConnect
        : options.onHttp;
    cleanup();
    socket.pause();
    socket.unshift(buffered);
    handler(socket);
  };
  socket.on("data", data);
  socket.once("close", cleanup);
}
export function createPortDetector(options: PortDetectorOptions) {
  return net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    sniffSocket(socket, options);
  });
}
