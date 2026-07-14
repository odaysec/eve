import { basename, resolve } from "node:path";

import type { Nitro } from "nitro/types";

import { readActiveDevelopmentRuntimeArtifactsSnapshot } from "#internal/nitro/dev-runtime-artifacts.js";
import {
  createDevelopmentWorkerServer,
  type DevelopmentWorkerCandidate,
  type DevelopmentWorkerGeneration,
  type DevelopmentWorkerListener,
  type DevelopmentWorkerPublication,
  type DevelopmentWorkerServer,
} from "#internal/nitro/host/dev-worker-server.js";
import { createNodeDevelopmentWorkerRunner } from "#internal/nitro/host/dev-worker-runner.js";

const NITRO_CANDIDATE_BUILD_TIMEOUT_MS = 60_000;

interface NitroCandidateHost {
  readonly hooks: Pick<Nitro["hooks"], "hook">;
  readonly options: {
    readonly output: Pick<Nitro["options"]["output"], "dir" | "serverDir">;
  };
}

export class NitroDevelopmentWorkerServer {
  readonly #appRoot: string;
  readonly #server: DevelopmentWorkerServer;

  constructor(input: { readonly appRoot: string }) {
    this.#appRoot = input.appRoot;
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
  }

  listen(input: { readonly hostname: string; readonly port: number }): DevelopmentWorkerListener {
    return this.#server.listen(input);
  }

  setControlHandler(handler: (request: Request) => Promise<Response | undefined>): void {
    this.#server.setControlHandler(handler);
  }

  async buildCandidate(input: {
    readonly dispose: () => Promise<void>;
    readonly generation: DevelopmentWorkerGeneration;
    readonly nitro: NitroCandidateHost;
    readonly trigger: () => Promise<void>;
  }): Promise<DevelopmentWorkerCandidate> {
    let buildError: unknown;
    let candidatePromise: Promise<DevelopmentWorkerCandidate> | undefined;
    let disposePromise: Promise<void> | undefined;
    const candidateSignal = createDeferred();
    const dispose = () => {
      disposePromise ??= input.dispose();
      return disposePromise;
    };
    const removeReloadHook = input.nitro.hooks.hook("dev:reload", async (payload) => {
      if (candidatePromise !== undefined) {
        const error = new Error("Nitro emitted more than one worker candidate for a single build.");
        buildError = error;
        candidateSignal.resolve();
        return;
      }
      candidatePromise = this.#server.prepareCandidate({
        dispose,
        entry: payload?.entry ?? resolveDefaultEntry(input.nitro),
        generation: input.generation,
        workerData: payload?.workerData ?? {},
      });
      try {
        await candidatePromise;
      } catch (error) {
        buildError = error;
      } finally {
        candidateSignal.resolve();
      }
    });
    const removeErrorHook = input.nitro.hooks.hook("dev:error", (error) => {
      buildError = error;
      candidateSignal.resolve();
    });

    try {
      await input.trigger();
      if (buildError !== undefined) {
        throw buildError;
      }
      await waitForCandidateSignal(candidateSignal.promise);
      if (buildError !== undefined) {
        throw buildError;
      }
      if (candidatePromise === undefined) {
        throw new Error("Nitro did not emit a development worker candidate.");
      }
      return await candidatePromise;
    } catch (error) {
      const cleanupError = await cleanupFailedCandidate({
        candidatePromise,
        discardCandidate: async (candidate) => await this.#server.discardCandidate(candidate),
        dispose,
      });
      if (cleanupError !== undefined && cleanupError !== error) {
        throw new AggregateError(
          [error, cleanupError],
          "Development candidate build and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      removeReloadHook();
      removeErrorHook();
    }
  }

  async discardCandidate(candidate: DevelopmentWorkerCandidate): Promise<void> {
    await this.#server.discardCandidate(candidate);
  }

  async promote(candidate: DevelopmentWorkerCandidate): Promise<void> {
    await this.#server.promote(candidate);
  }

  async publishRuntimeGeneration(
    publish: () => Promise<DevelopmentWorkerPublication>,
  ): Promise<void> {
    await this.#server.publishRuntimeGeneration(publish);
  }

  async publishStructuralCandidate(input: {
    readonly candidate: DevelopmentWorkerCandidate;
    readonly publish: () => Promise<DevelopmentWorkerPublication>;
  }): Promise<void> {
    await this.#server.publishStructuralCandidate(input);
  }

  async close(): Promise<void> {
    await this.#server.close();
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

function resolveDefaultEntry(nitro: NitroCandidateHost): string {
  return resolve(nitro.options.output.dir, nitro.options.output.serverDir, "index.mjs");
}

function createDeferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

async function cleanupFailedCandidate(input: {
  readonly candidatePromise: Promise<DevelopmentWorkerCandidate> | undefined;
  readonly discardCandidate: (candidate: DevelopmentWorkerCandidate) => Promise<void>;
  readonly dispose: () => Promise<void>;
}): Promise<unknown | undefined> {
  if (input.candidatePromise === undefined) {
    try {
      await input.dispose();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  let candidate: DevelopmentWorkerCandidate;
  try {
    candidate = await input.candidatePromise;
  } catch (error) {
    return error;
  }

  try {
    await input.discardCandidate(candidate);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function waitForCandidateSignal(signal: Promise<void>): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for Nitro to emit a worker candidate."));
        }, NITRO_CANDIDATE_BUILD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
