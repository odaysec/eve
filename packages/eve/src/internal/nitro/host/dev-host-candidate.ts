import { build as buildNitro, prepare } from "nitro/builder";
import type { Nitro } from "nitro/types";

import { removeDevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import {
  NitroDevelopmentWorkerServer,
  toDevelopmentWorkerGeneration,
} from "#internal/nitro/host/nitro-development-worker-server.js";
import type { DevelopmentWorkerCandidate } from "#internal/nitro/host/dev-worker-server.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

export async function buildDevelopmentHostCandidate(input: {
  readonly devServer: NitroDevelopmentWorkerServer;
  readonly host: PreparedDevelopmentApplicationHost;
  readonly nitro: Nitro;
}): Promise<DevelopmentWorkerCandidate> {
  let candidate: DevelopmentWorkerCandidate;
  try {
    candidate = await input.devServer.buildCandidate({
      dispose: async () => {
        await removeDevelopmentHostWorkspace(input.host.workspace);
      },
      generation: toDevelopmentWorkerGeneration(input.host.generation),
      nitro: input.nitro,
      trigger: async () => {
        await prepare(input.nitro);
        await buildNitro(input.nitro);
      },
    });
  } catch (error) {
    try {
      await input.nitro.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Development candidate build cleanup failed.", {
        cause: error,
      });
    }
    throw error;
  }

  try {
    await input.nitro.close();
  } catch (error) {
    try {
      await input.devServer.discardCandidate(candidate);
    } catch (discardError) {
      throw new AggregateError(
        [error, discardError],
        "Development candidate host cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }

  return candidate;
}
