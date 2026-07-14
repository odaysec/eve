import type { Nitro } from "nitro/types";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  core: {
    close: vi.fn(async () => undefined),
    discardCandidate: vi.fn(async () => undefined),
    listen: vi.fn(),
    prepareCandidate: vi.fn(),
    promote: vi.fn(async () => undefined),
    publishRuntimeGeneration: vi.fn(async () => undefined),
    publishStructuralCandidate: vi.fn(async () => undefined),
    setControlHandler: vi.fn(),
  },
}));

vi.mock("#internal/nitro/host/dev-worker-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/nitro/host/dev-worker-server.js")>();
  return {
    ...actual,
    createDevelopmentWorkerServer: vi.fn(() => mocks.core),
  };
});

vi.mock("#internal/nitro/host/dev-worker-runner.js", () => ({
  createNodeDevelopmentWorkerRunner: vi.fn(),
}));

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe("NitroDevelopmentWorkerServer", () => {
  it("discards a candidate that becomes ready after Nitro rejects its build", async () => {
    const hooks = new Map<string, (...args: never[]) => unknown>();
    const candidateReady = createDeferred<object>();
    const candidate = {};
    mocks.core.prepareCandidate.mockReturnValueOnce(candidateReady.promise);
    const hook = ((name: string, handler: (...args: never[]) => unknown) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    }) as Nitro["hooks"]["hook"];
    const nitro = {
      hooks: {
        hook,
      },
      logger: { error: vi.fn() },
      options: {
        output: { dir: "/tmp/nitro", serverDir: "server" },
      },
    };
    const { NitroDevelopmentWorkerServer } =
      await import("#internal/nitro/host/nitro-development-worker-server.js");
    const server = new NitroDevelopmentWorkerServer({ appRoot: "/tmp/app" });
    const buildError = new Error("Nitro build failed");

    const result = server.buildCandidate({
      dispose: async () => undefined,
      generation: { id: "generation-a", runtimeAppRoot: "/tmp/generation-a" },
      nitro,
      trigger: async () => {
        const reload = hooks.get("dev:reload")?.({
          entry: "/tmp/index.mjs",
          workerData: {},
        } as never);
        hooks.get("dev:error")?.(buildError as never);
        candidateReady.resolve(candidate);
        await reload;
      },
    });

    await expect(result).rejects.toThrow("Nitro build failed");
    expect(mocks.core.discardCandidate).toHaveBeenCalledWith(candidate);
  });

  it("reports both a Nitro failure and failed candidate cleanup", async () => {
    const hooks = new Map<string, (...args: never[]) => unknown>();
    const hook = ((name: string, handler: (...args: never[]) => unknown) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    }) as Nitro["hooks"]["hook"];
    const nitro = {
      hooks: { hook },
      options: {
        output: { dir: "/tmp/nitro", serverDir: "server" },
      },
    };
    const { NitroDevelopmentWorkerServer } =
      await import("#internal/nitro/host/nitro-development-worker-server.js");
    const server = new NitroDevelopmentWorkerServer({ appRoot: "/tmp/app" });
    const buildError = new Error("Nitro build failed");
    const cleanupError = new Error("candidate cleanup failed");

    const result = server.buildCandidate({
      dispose: async () => {
        throw cleanupError;
      },
      generation: { id: "generation-a", runtimeAppRoot: "/tmp/generation-a" },
      nitro,
      trigger: async () => {
        throw buildError;
      },
    });

    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([buildError, cleanupError]);
  });
});
