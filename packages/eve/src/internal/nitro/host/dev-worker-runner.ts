import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { BaseEnvRunner } from "#compiled/env-runner/index.js";
import { resolvePackageCompiledFilePath } from "#internal/application/package.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV,
} from "#internal/nitro/host/dev-worker-metadata.js";
import type {
  DevelopmentWorkerRunner,
  DevelopmentWorkerRunnerFactory,
} from "#internal/nitro/host/dev-worker-server.js";

class NodeDevelopmentWorkerRunner extends BaseEnvRunner implements DevelopmentWorkerRunner {
  #closeCause: unknown;
  readonly #environment: NodeJS.ProcessEnv;
  #worker: Worker | undefined;

  constructor(input: Parameters<DevelopmentWorkerRunnerFactory>[0]) {
    const workerEntry = resolvePackageCompiledFilePath("src/compiled/env-runner/node-worker.js");
    super({
      data: {
        entry: input.entry,
        ...input.workerData,
      },
      hooks: {
        onClose: (_runner, cause) => input.onClose(cause),
      },
      name: input.name,
      workerEntry,
    });
    this.#environment = {
      ...process.env,
      [DEVELOPMENT_WORKER_APP_ROOT_ENV]: input.appRoot,
      [DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV]: input.transportSecret,
    };
    this._initWithVirtualData(() => this.#startWorker());
  }

  override sendMessage(message: unknown): void {
    if (this.#worker === undefined) {
      throw new Error("Development worker is not initialized.");
    }
    this.#worker.postMessage(message);
  }

  override async waitForReady(timeout: number): Promise<void> {
    try {
      await super.waitForReady(timeout);
    } catch (error) {
      if (this.#closeCause === undefined) {
        throw error;
      }
      throw new Error(
        `Development worker failed before readiness: ${this.#closeCause instanceof Error ? this.#closeCause.message : String(this.#closeCause)}`,
        { cause: this.#closeCause },
      );
    }
  }

  protected override _hasRuntime(): boolean {
    return this.#worker !== undefined;
  }

  protected override _runtimeType(): string {
    return "worker";
  }

  protected override async _closeRuntime(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) {
      return;
    }

    this.#worker = undefined;
    worker.removeAllListeners();
    await worker.terminate();
  }

  protected override _handleMessage(message: unknown): void {
    if (isWorkerInitializationError(message)) {
      this.#closeCause = new Error(message.error);
    }
    super._handleMessage(message);
  }

  #startWorker(): void {
    if (!existsSync(this._workerEntry)) {
      void this.close(`Development worker entry not found at "${this._workerEntry}".`);
      return;
    }

    const worker = new Worker(this._workerEntry, {
      env: this.#environment,
      workerData: {
        name: this._name,
        ...this._data,
      },
    });
    this.#worker = worker;
    worker.once("error", (error) => {
      this.#closeCause = error;
      void this.close(error);
    });
    worker.once("exit", (code) => {
      const error = new Error(`Development worker exited with code ${String(code)}.`);
      this.#closeCause ??= error;
      void this.close(error);
    });
    worker.on("message", (message: unknown) => this._handleMessage(message));
  }
}

export const createNodeDevelopmentWorkerRunner: DevelopmentWorkerRunnerFactory = (input) =>
  new NodeDevelopmentWorkerRunner(input);

function isWorkerInitializationError(
  value: unknown,
): value is { readonly error: string; readonly event: "init-error" } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.event === "init-error" && typeof record.error === "string";
}
