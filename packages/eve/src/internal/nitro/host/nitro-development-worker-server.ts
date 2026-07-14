import { basename, resolve } from "node:path";

import type { Nitro } from "nitro/types";

import { readActiveDevelopmentRuntimeArtifactsSnapshot } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  createDevelopmentWorkerServer,
  type DevelopmentWorkerCandidate,
  type DevelopmentWorkerGeneration,
  type DevelopmentWorkerListener,
  type DevelopmentWorkerServer,
} from "#internal/nitro/host/dev-worker-server.js";
import { createNodeDevelopmentWorkerRunner } from "#internal/nitro/host/dev-worker-runner.js";
import { toErrorMessage } from "#shared/errors.js";

interface PendingCandidate {
  readonly generation: DevelopmentWorkerGeneration;
  readonly promise: Promise<DevelopmentWorkerCandidate>;
  reject(error: unknown): void;
  resolve(candidate: DevelopmentWorkerCandidate): void;
}

interface NitroDevelopmentWorkerHost {
  readonly hooks: Pick<Nitro["hooks"], "hook">;
  readonly logger: {
    error(message: unknown, ...details: unknown[]): unknown;
  };
  readonly options: {
    readonly output: Pick<Nitro["options"]["output"], "dir" | "serverDir">;
  };
}

export class NitroDevelopmentWorkerServer {
  readonly #appRoot: string;
  readonly #nitro: NitroDevelopmentWorkerHost;
  #pendingCandidate: PendingCandidate | undefined;
  readonly #server: DevelopmentWorkerServer;

  constructor(input: { readonly appRoot: string; readonly nitro: NitroDevelopmentWorkerHost }) {
    this.#appRoot = input.appRoot;
    this.#nitro = input.nitro;
    this.#server = createDevelopmentWorkerServer({
      appRoot: input.appRoot,
      createRunner: createNodeDevelopmentWorkerRunner,
      resolveAdmissionGeneration: () => {
        const generation = readActiveGeneration(this.#appRoot);
        if (generation === undefined) {
          throw new Error("Development runtime generation is unavailable for request admission.");
        }
        return generation;
      },
    });

    input.nitro.hooks.hook("dev:reload", async (payload) => {
      await this.#handleReload({
        entry: payload?.entry ?? this.#resolveDefaultEntry(),
        workerData: payload?.workerData ?? {},
      });
    });
    input.nitro.hooks.hook("dev:error", (error) => {
      const pending = this.#pendingCandidate;
      if (pending !== undefined) {
        this.#pendingCandidate = undefined;
        pending.reject(error);
      }
    });
    input.nitro.hooks.hook("close", async () => await this.close());
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener {
    return this.#server.listen(input);
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#server.setControlHandler(handler);
  }

  async buildCandidate(input: {
    readonly generation: DevelopmentWorkerGeneration;
    readonly trigger: () => Promise<void>;
  }): Promise<DevelopmentWorkerCandidate> {
    if (this.#pendingCandidate !== undefined) {
      throw new Error("A development worker candidate is already pending.");
    }

    const pending = createPendingCandidate(input.generation);
    void pending.promise.catch(() => undefined);
    this.#pendingCandidate = pending;
    try {
      await input.trigger();
      return await pending.promise;
    } catch (error) {
      if (this.#pendingCandidate === pending) {
        this.#pendingCandidate = undefined;
        pending.reject(error);
      }
      const candidate = await pending.promise.catch(() => undefined);
      if (candidate !== undefined) {
        await this.#server.discardCandidate(candidate);
      }
      throw error;
    }
  }

  async promote(candidate: DevelopmentWorkerCandidate): Promise<void> {
    await this.#server.promote(candidate);
  }

  async close(): Promise<void> {
    const pending = this.#pendingCandidate;
    if (pending !== undefined) {
      this.#pendingCandidate = undefined;
      pending.reject(new Error("Development worker server closed."));
    }
    await this.#server.close();
  }

  async #handleReload(input: {
    readonly entry: string;
    readonly workerData: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const pending = this.#pendingCandidate;
    const generation = pending?.generation ?? readActiveGeneration(this.#appRoot);
    if (generation === undefined) {
      const error = new Error("Nitro produced a worker without an active development generation.");
      if (pending !== undefined) {
        this.#pendingCandidate = undefined;
        pending.reject(error);
        return;
      }
      throw error;
    }

    try {
      const candidate = await this.#server.prepareCandidate({
        entry: input.entry,
        generation,
        workerData: input.workerData,
      });
      if (pending !== undefined && this.#pendingCandidate === pending) {
        this.#pendingCandidate = undefined;
        pending.resolve(candidate);
        return;
      }
      if (pending !== undefined) {
        await this.#server.discardCandidate(candidate);
        return;
      }
      await this.#server.promote(candidate);
    } catch (error) {
      if (pending !== undefined && this.#pendingCandidate === pending) {
        this.#pendingCandidate = undefined;
        pending.reject(error);
        return;
      }
      this.#nitro.logger.error(`[eve:dev] candidate worker failed: ${toErrorMessage(error)}`);
    }
  }

  #resolveDefaultEntry(): string {
    return resolve(
      this.#nitro.options.output.dir,
      this.#nitro.options.output.serverDir,
      "index.mjs",
    );
  }
}

export function toDevelopmentWorkerGeneration(input: {
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
}): DevelopmentWorkerGeneration {
  return {
    id: basename(input.snapshotRoot),
    runtimeAppRoot: input.runtimeAppRoot,
  };
}

function readActiveGeneration(appRoot: string): DevelopmentWorkerGeneration | undefined {
  const snapshot = readActiveDevelopmentRuntimeArtifactsSnapshot(appRoot);
  if (snapshot === undefined) {
    return undefined;
  }
  return toDevelopmentWorkerGeneration(snapshot);
}

function createPendingCandidate(generation: DevelopmentWorkerGeneration): PendingCandidate {
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: ((candidate: DevelopmentWorkerCandidate) => void) | undefined;
  const promise = new Promise<DevelopmentWorkerCandidate>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });

  return {
    generation,
    promise,
    reject(error) {
      rejectPromise?.(error);
    },
    resolve(candidate) {
      resolvePromise?.(candidate);
    },
  };
}
