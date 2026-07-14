import { relative, resolve } from "node:path";

import {
  getDevelopmentEnvironmentFilePaths,
  stageDevelopmentEnvironmentFiles,
  type DevelopmentEnvironmentReload,
} from "#cli/dev/environment.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { createDevelopmentApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { NitroDevelopmentWorkerServer } from "#internal/nitro/host/nitro-development-worker-server.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  activateDevelopmentGenerationTransaction,
  discardDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";

export type DevelopmentRebuildKind = "structural" | "unchanged" | "runtime";

export interface DevelopmentRebuildResult {
  readonly host: PreparedDevelopmentApplicationHost;
  readonly kind: DevelopmentRebuildKind;
}

export interface DevelopmentAuthoredRebuildCoordinator {
  rebuild(input: { readonly changedPaths: readonly string[] }): Promise<DevelopmentRebuildResult>;
}

export async function createDevelopmentAuthoredRebuildCoordinator(input: {
  readonly devServer: NitroDevelopmentWorkerServer;
  readonly initialHost: PreparedDevelopmentApplicationHost;
}): Promise<DevelopmentAuthoredRebuildCoordinator> {
  return new TransactionalDevelopmentAuthoredRebuildCoordinator({
    currentHostFingerprint: await computeDevelopmentHostFingerprint(input.initialHost),
    currentRuntimeFingerprint: input.initialHost.generation.fingerprint,
    devServer: input.devServer,
    initialHost: input.initialHost,
  });
}

class TransactionalDevelopmentAuthoredRebuildCoordinator implements DevelopmentAuthoredRebuildCoordinator {
  #currentHost: PreparedDevelopmentApplicationHost;
  #currentHostFingerprint: string;
  #currentRuntimeFingerprint: string;
  readonly #devServer: NitroDevelopmentWorkerServer;

  constructor(input: {
    readonly currentHostFingerprint: string;
    readonly currentRuntimeFingerprint: string;
    readonly devServer: NitroDevelopmentWorkerServer;
    readonly initialHost: PreparedDevelopmentApplicationHost;
  }) {
    this.#currentHost = input.initialHost;
    this.#currentHostFingerprint = input.currentHostFingerprint;
    this.#currentRuntimeFingerprint = input.currentRuntimeFingerprint;
    this.#devServer = input.devServer;
  }

  async rebuild(input: {
    readonly changedPaths: readonly string[];
  }): Promise<DevelopmentRebuildResult> {
    const previousHost = this.#currentHost;
    const environmentReload = stageEnvironmentReload(previousHost.appRoot, input.changedPaths);
    let nextHost: PreparedDevelopmentApplicationHost | undefined;

    try {
      nextHost = await prepareDevelopmentApplicationHost(previousHost.appRoot);
      const nextHostFingerprint = await computeDevelopmentHostFingerprint(nextHost);
      const nextRuntimeFingerprint = nextHost.generation.fingerprint;
      const hasStructuralChange = nextHostFingerprint !== this.#currentHostFingerprint;
      const hasRuntimeChange = nextRuntimeFingerprint !== this.#currentRuntimeFingerprint;

      if (!hasStructuralChange && !hasRuntimeChange) {
        await discardPreparedHost(nextHost);
        nextHost = undefined;
        environmentReload?.commit();
        return { host: previousHost, kind: "unchanged" };
      }

      if (!hasStructuralChange) {
        await removeDevelopmentHostWorkspace(nextHost.workspace);
        const committedHost = retainActiveHostWorkspace(previousHost, nextHost);
        await this.#devServer.publishRuntimeGeneration(async () => {
          return await activateDevelopmentGenerationTransaction({
            appRoot: committedHost.appRoot,
            generation: committedHost.generation,
          });
        });
        this.#commitState(committedHost, nextHostFingerprint, nextRuntimeFingerprint);
        nextHost = undefined;
        environmentReload?.commit();
        startSandboxPrewarmAfterCommit(committedHost, input.changedPaths);
        return { host: committedHost, kind: "runtime" };
      }

      const result = await this.#commitStructuralHost({
        hasRuntimeChange,
        nextHost,
        nextHostFingerprint,
        nextRuntimeFingerprint,
      });
      nextHost = undefined;
      environmentReload?.commit();
      startSandboxPrewarmAfterCommit(result.host, input.changedPaths);
      return result;
    } catch (error) {
      environmentReload?.rollback();
      if (nextHost === undefined) {
        throw error;
      }
      throw await discardFailedHost(error, nextHost);
    }
  }

  async #commitStructuralHost(input: {
    readonly hasRuntimeChange: boolean;
    readonly nextHost: PreparedDevelopmentApplicationHost;
    readonly nextHostFingerprint: string;
    readonly nextRuntimeFingerprint: string;
  }): Promise<DevelopmentRebuildResult> {
    let committedHost = input.nextHost;

    if (!input.hasRuntimeChange) {
      await discardDevelopmentGeneration(input.nextHost.generation);
      committedHost = {
        ...input.nextHost,
        generation: this.#currentHost.generation,
      };
    }

    const nitro = await createDevelopmentApplicationNitro(committedHost);
    const candidate = await buildDevelopmentHostCandidate({
      devServer: this.#devServer,
      host: committedHost,
      nitro,
    });

    try {
      if (input.hasRuntimeChange) {
        await this.#devServer.publishStructuralCandidate({
          candidate,
          publish: async () => {
            return await activateDevelopmentGenerationTransaction({
              appRoot: committedHost.appRoot,
              generation: committedHost.generation,
            });
          },
        });
      } else {
        await this.#devServer.promote(candidate);
      }
    } catch (error) {
      try {
        await this.#devServer.discardCandidate(candidate);
      } catch (discardError) {
        throw new AggregateError([error, discardError], "Development candidate rollback failed.", {
          cause: error,
        });
      }
      throw error;
    }

    this.#commitState(
      committedHost,
      input.nextHostFingerprint,
      input.hasRuntimeChange ? input.nextRuntimeFingerprint : this.#currentRuntimeFingerprint,
    );
    return { host: committedHost, kind: "structural" };
  }

  #commitState(
    host: PreparedDevelopmentApplicationHost,
    hostFingerprint: string,
    runtimeFingerprint: string,
  ): void {
    this.#currentHost = host;
    this.#currentHostFingerprint = hostFingerprint;
    this.#currentRuntimeFingerprint = runtimeFingerprint;
  }
}

function retainActiveHostWorkspace(
  activeHost: PreparedDevelopmentApplicationHost,
  nextHost: PreparedDevelopmentApplicationHost,
): PreparedDevelopmentApplicationHost {
  return {
    ...nextHost,
    compiledArtifacts: activeHost.compiledArtifacts,
    workflowBuildDir: activeHost.workflowBuildDir,
    workspace: activeHost.workspace,
  };
}

function stageEnvironmentReload(
  appRoot: string,
  changedPaths: readonly string[],
): DevelopmentEnvironmentReload | undefined {
  const environmentPaths = new Set(
    getDevelopmentEnvironmentFilePaths(appRoot).map((path) => resolve(path)),
  );
  if (!changedPaths.some((path) => environmentPaths.has(resolve(path)))) {
    return undefined;
  }
  return stageDevelopmentEnvironmentFiles(appRoot);
}

function startSandboxPrewarmAfterCommit(
  host: PreparedDevelopmentApplicationHost,
  changedPaths: readonly string[],
): void {
  if (!hasSandboxRelatedChange(host.compileResult.project.agentRoot, changedPaths)) {
    return;
  }
  const artifactsConfig = createDevelopmentNitroArtifactsConfig({ appRoot: host.appRoot });
  startDevelopmentSandboxPrewarmInBackground({
    appRoot: host.appRoot,
    compiledArtifactsSource: resolveNitroCompiledArtifactsSource(artifactsConfig),
    log: (message) => console.log(message),
  });
}

function hasSandboxRelatedChange(agentRoot: string, changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => {
    const relativePath = relative(resolve(agentRoot), resolve(path));
    const segments = relativePath.split(/[\\/]/u);
    if (segments[0] === ".." || relativePath === "") {
      return false;
    }
    return (
      segments[0] === "sandbox.ts" ||
      segments[0] === "sandbox" ||
      segments[0] === "workspace" ||
      segments[0] === "skills"
    );
  });
}

async function discardPreparedHost(host: PreparedDevelopmentApplicationHost): Promise<void> {
  const cleanup = await Promise.allSettled([
    discardDevelopmentGeneration(host.generation),
    removeDevelopmentHostWorkspace(host.workspace),
  ]);
  const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to discard development host "${host.workspace.rootDir}".`,
    );
  }
}

async function discardFailedHost(
  cause: unknown,
  host: PreparedDevelopmentApplicationHost,
): Promise<unknown> {
  try {
    await discardPreparedHost(host);
    return cause;
  } catch (cleanupError) {
    return new AggregateError([cause, cleanupError], "Development rebuild rollback failed.", {
      cause,
    });
  }
}
