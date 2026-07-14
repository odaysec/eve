import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  closeServer,
  createPublicRequest,
  createWorkerRequest,
  stampWorkerUpgradeRequest,
  writeRequestError,
  writeResponse,
} from "#internal/nitro/host/dev-worker-http.js";
import { toErrorMessage } from "#shared/errors.js";

const DEVELOPMENT_WORKER_READY_TIMEOUT_MS = 60_000;

export interface DevelopmentWorkerGeneration {
  readonly id: string;
  readonly runtimeAppRoot: string;
}

export interface DevelopmentWorkerRunner {
  readonly closed: boolean;
  close(cause?: unknown): Promise<void>;
  fetch(request: Request): Promise<Response>;
  upgrade(input: {
    readonly node: {
      readonly head: Buffer;
      readonly req: IncomingMessage;
      readonly socket: Socket;
    };
  }): Promise<void>;
  waitForReady(timeout: number): Promise<void>;
}

export interface DevelopmentWorkerRunnerFactoryInput {
  readonly appRoot: string;
  readonly entry: string;
  readonly name: string;
  readonly onClose: (cause?: unknown) => void;
  readonly transportSecret: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export type DevelopmentWorkerRunnerFactory = (
  input: DevelopmentWorkerRunnerFactoryInput,
) => DevelopmentWorkerRunner;

type WorkerState = "candidate" | "active" | "retired" | "closed";

interface WorkerSlot {
  readonly entry: string;
  readonly generation: DevelopmentWorkerGeneration;
  leases: number;
  readonly runner: DevelopmentWorkerRunner;
  state: WorkerState;
  readonly workerData: Readonly<Record<string, unknown>>;
}

export interface DevelopmentWorkerCandidate {
  readonly slot: WorkerSlot;
}

export interface DevelopmentWorkerListener {
  close(): Promise<void>;
  readonly node: { readonly server: Server };
  ready(): Promise<void>;
  readonly url: string | undefined;
}

interface RequestLease {
  readonly generation: DevelopmentWorkerGeneration;
  release(): void;
  readonly slot: WorkerSlot;
}

interface ActiveExchange {
  cancel(): void;
  readonly slot: WorkerSlot;
}

interface ListenerState {
  readonly beginClose: () => Promise<void>;
  destroySockets(): void;
}

export interface DevelopmentWorkerServer {
  close(): Promise<void>;
  discardCandidate(candidate: DevelopmentWorkerCandidate): Promise<void>;
  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener;
  prepareCandidate(input: {
    readonly entry: string;
    readonly generation: DevelopmentWorkerGeneration;
    readonly workerData: Readonly<Record<string, unknown>>;
  }): Promise<DevelopmentWorkerCandidate>;
  promote(candidate: DevelopmentWorkerCandidate): Promise<void>;
  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void;
}

export function createDevelopmentWorkerServer(input: {
  readonly appRoot: string;
  readonly createRunner: DevelopmentWorkerRunnerFactory;
  readonly resolveAdmissionGeneration: (
    workerGeneration: DevelopmentWorkerGeneration,
  ) => DevelopmentWorkerGeneration;
}): DevelopmentWorkerServer {
  return new ParentDevelopmentWorkerServer(input);
}

class ParentDevelopmentWorkerServer implements DevelopmentWorkerServer {
  readonly #activeExchanges = new Set<ActiveExchange>();
  readonly #activeWaiters = new Set<() => void>();
  readonly #appRoot: string;
  readonly #createRunner: DevelopmentWorkerRunnerFactory;
  readonly #listeners = new Set<ListenerState>();
  readonly #resolveAdmissionGeneration: (
    workerGeneration: DevelopmentWorkerGeneration,
  ) => DevelopmentWorkerGeneration;
  readonly #slots = new Set<WorkerSlot>();
  readonly #transportSecret = randomBytes(32).toString("base64url");
  #accepting = true;
  #activeSlot: WorkerSlot | undefined;
  #closePromise: Promise<void> | undefined;
  #controlHandler: ((request: Request) => Promise<Response | undefined>) | undefined;
  #promotion: Promise<void> = Promise.resolve();
  #workerCounter = 0;

  constructor(input: {
    readonly appRoot: string;
    readonly createRunner: DevelopmentWorkerRunnerFactory;
    readonly resolveAdmissionGeneration: (
      workerGeneration: DevelopmentWorkerGeneration,
    ) => DevelopmentWorkerGeneration;
  }) {
    this.#appRoot = input.appRoot;
    this.#createRunner = input.createRunner;
    this.#resolveAdmissionGeneration = input.resolveAdmissionGeneration;
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#controlHandler = handler;
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener {
    if (!this.#accepting) {
      throw new Error("Development worker server is closed.");
    }

    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket as Socket, head);
    });

    let url: string | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Development worker server did not expose a TCP address."));
          return;
        }
        const urlHost = input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname;
        url = `http://${urlHost}:${String(address.port)}/`;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: input.hostname, port: input.port });
    });
    let listenerClosePromise: Promise<void> | undefined;
    const beginClose = (): Promise<void> => {
      listenerClosePromise ??= closeServer(server).finally(() => {
        this.#listeners.delete(listenerState);
      });
      return listenerClosePromise;
    };
    const destroySockets = () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    };
    const listenerState: ListenerState = { beginClose, destroySockets };
    this.#listeners.add(listenerState);

    return {
      async close() {
        const closed = beginClose();
        destroySockets();
        await closed;
      },
      node: { server },
      ready: async () => await ready,
      get url() {
        return url;
      },
    };
  }

  async prepareCandidate(input: {
    readonly entry: string;
    readonly generation: DevelopmentWorkerGeneration;
    readonly workerData: Readonly<Record<string, unknown>>;
  }): Promise<DevelopmentWorkerCandidate> {
    if (!this.#accepting) {
      throw new Error("Development worker server is closed.");
    }

    let slot: WorkerSlot | undefined;
    const workerNumber = this.#workerCounter++;
    const runner = this.#createRunner({
      appRoot: this.#appRoot,
      entry: input.entry,
      name: `eve-dev-${String(workerNumber)}`,
      onClose: (cause) => {
        if (slot !== undefined) {
          void this.#handleWorkerClose(slot, cause);
        }
      },
      transportSecret: this.#transportSecret,
      workerData: input.workerData,
    });
    slot = {
      entry: input.entry,
      generation: input.generation,
      leases: 0,
      runner,
      state: "candidate",
      workerData: input.workerData,
    };
    this.#slots.add(slot);

    try {
      await runner.waitForReady(DEVELOPMENT_WORKER_READY_TIMEOUT_MS);
    } catch (error) {
      await this.#closeSlot(slot, error);
      throw error;
    }

    if (!this.#accepting) {
      await this.#closeSlot(slot);
      throw new Error("Development worker server closed before candidate readiness.");
    }

    return { slot };
  }

  async promote(candidate: DevelopmentWorkerCandidate): Promise<void> {
    const previousPromotion = this.#promotion;
    let finishPromotion: (() => void) | undefined;
    this.#promotion = new Promise<void>((resolve) => {
      finishPromotion = resolve;
    });

    await previousPromotion;
    try {
      if (!this.#accepting) {
        throw new Error("Development worker server is closed.");
      }
      if (candidate.slot.state !== "candidate" || candidate.slot.runner.closed) {
        throw new Error("Development worker candidate is not ready for promotion.");
      }

      const previousSlot = this.#activeSlot;
      candidate.slot.state = "active";
      this.#activeSlot = candidate.slot;
      this.#wakeActiveWaiters();

      if (previousSlot !== undefined && previousSlot !== candidate.slot) {
        previousSlot.state = "retired";
        await this.#closeRetiredSlot(previousSlot);
      }
    } finally {
      finishPromotion?.();
    }
  }

  async discardCandidate(candidate: DevelopmentWorkerCandidate): Promise<void> {
    if (candidate.slot.state !== "candidate") {
      throw new Error("Only an unpromoted development worker candidate can be discarded.");
    }
    await this.#closeSlot(candidate.slot);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#accepting = false;
    this.#wakeActiveWaiters();

    const listeners = [...this.#listeners];
    const listenerClosePromises = listeners.map((listener) => listener.beginClose());

    for (const exchange of this.#activeExchanges) {
      exchange.cancel();
    }

    await Promise.all([...this.#slots].map(async (slot) => await this.#closeSlot(slot)));

    for (const listener of listeners) {
      listener.destroySockets();
    }

    await Promise.all(listenerClosePromises);
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortRequest = (cause?: unknown) => {
      if (!requestAbort.signal.aborted) {
        requestAbort.abort(cause);
      }
    };
    request.once("aborted", abortRequest);
    request.once("error", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) {
        abortRequest();
      }
    });

    let lease: RequestLease | undefined;
    let exchange: ActiveExchange | undefined;
    try {
      const publicRequest = createPublicRequest(request, requestAbort.signal);
      const controlResponse = await this.#controlHandler?.(publicRequest);
      if (controlResponse !== undefined) {
        await writeResponse(response, controlResponse, requestAbort.signal);
        return;
      }

      lease = await this.#admit();
      const workerRequest = createWorkerRequest({
        generation: lease.generation,
        request: publicRequest,
        secret: this.#transportSecret,
        socket: request.socket,
      });
      const admittedLease = lease;
      exchange = {
        cancel() {
          abortRequest(new Error("Development worker request was cancelled."));
          if (!response.destroyed) {
            response.destroy();
          }
          admittedLease.release();
        },
        slot: lease.slot,
      };
      this.#activeExchanges.add(exchange);
      response.once("finish", admittedLease.release);
      response.once("error", admittedLease.release);
      response.once("close", admittedLease.release);
      request.once("aborted", admittedLease.release);

      const workerResponse = await lease.slot.runner.fetch(workerRequest);
      await writeResponse(response, workerResponse, requestAbort.signal);
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        writeRequestError(response, error);
      }
    } finally {
      if (exchange !== undefined) {
        this.#activeExchanges.delete(exchange);
      }
      lease?.release();
      request.off("aborted", abortRequest);
      request.off("error", abortRequest);
    }
  }

  async #handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let lease: RequestLease | undefined;
    let exchange: ActiveExchange | undefined;
    try {
      lease = await this.#admit();
      stampWorkerUpgradeRequest({
        generation: lease.generation,
        request,
        secret: this.#transportSecret,
      });
      const admittedLease = lease;
      exchange = {
        cancel() {
          if (!socket.destroyed) {
            socket.destroy();
          }
          admittedLease.release();
        },
        slot: lease.slot,
      };
      this.#activeExchanges.add(exchange);
      const release = () => {
        admittedLease.release();
        if (exchange !== undefined) {
          this.#activeExchanges.delete(exchange);
          exchange = undefined;
        }
      };
      socket.once("close", release);
      socket.once("error", release);
      await lease.slot.runner.upgrade({ node: { head, req: request, socket } });
    } catch {
      exchange?.cancel();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  async #admit(): Promise<RequestLease> {
    await this.#promotion;
    while (this.#accepting && this.#activeSlot === undefined) {
      await new Promise<void>((resolve) => this.#activeWaiters.add(resolve));
      await this.#promotion;
    }

    const slot = this.#activeSlot;
    if (!this.#accepting || slot === undefined || slot.state !== "active") {
      throw new Error("Development worker is unavailable.");
    }

    const generation = this.#resolveAdmissionGeneration(slot.generation);
    slot.leases += 1;
    let released = false;
    return {
      generation,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        slot.leases -= 1;
        void this.#closeRetiredSlot(slot).catch((error) => {
          console.error(`[eve:dev] failed to close retired worker: ${toErrorMessage(error)}`);
        });
      },
      slot,
    };
  }

  async #handleWorkerClose(slot: WorkerSlot, cause: unknown): Promise<void> {
    if (slot.state !== "active" || !this.#accepting || this.#activeSlot !== slot) {
      return;
    }

    slot.state = "closed";
    this.#slots.delete(slot);
    this.#activeSlot = undefined;
    for (const exchange of this.#activeExchanges) {
      if (exchange.slot === slot) {
        exchange.cancel();
        this.#activeExchanges.delete(exchange);
      }
    }

    try {
      const candidate = await this.prepareCandidate({
        entry: slot.entry,
        generation: slot.generation,
        workerData: slot.workerData,
      });
      await this.promote(candidate);
    } catch (error) {
      console.error(
        `[eve:dev] worker restart failed after ${toErrorMessage(cause)}: ${toErrorMessage(error)}`,
      );
    }
  }

  async #closeRetiredSlot(slot: WorkerSlot): Promise<void> {
    if (slot.state === "retired" && slot.leases === 0) {
      await this.#closeSlot(slot);
    }
  }

  async #closeSlot(slot: WorkerSlot, cause?: unknown): Promise<void> {
    if (slot.state === "closed") {
      return;
    }
    slot.state = "closed";
    this.#slots.delete(slot);
    if (this.#activeSlot === slot) {
      this.#activeSlot = undefined;
    }
    await slot.runner.close(cause);
  }

  #wakeActiveWaiters(): void {
    for (const wake of this.#activeWaiters) {
      wake();
    }
    this.#activeWaiters.clear();
  }
}
