import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/nitro/dev-runtime-artifacts.js";
import { readDevelopmentWorkerRequestMetadata } from "#internal/nitro/host/dev-worker-metadata.js";

/**
 * Configuration values needed to resolve the compiled-artifact source for
 * package-owned Nitro routes. Passed explicitly from virtual handlers
 * rather than read from a global runtime configuration store.
 */
export interface DevelopmentNitroArtifactsConfig {
  readonly appRoot: string;
  readonly devRuntimeArtifactsPointerPath: string;
  readonly kind: "development";
  readonly moduleMapLoaderPath: string;
}

export interface ProductionNitroArtifactsConfig {
  readonly kind: "production";
}

export type NitroArtifactsConfig = DevelopmentNitroArtifactsConfig | ProductionNitroArtifactsConfig;

/**
 * Resolves the compiled-artifact source available to package-owned Nitro
 * routes.
 */
export function resolveNitroCompiledArtifactsSource(
  config: NitroArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  if (config.kind === "development") {
    const runtimeAppRoot =
      readDevelopmentRuntimeArtifactsSnapshotRoot(config.devRuntimeArtifactsPointerPath) ??
      config.appRoot;

    return createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot, {
      moduleMapLoaderPath: config.moduleMapLoaderPath,
      sandboxAppRoot: config.appRoot,
    });
  }

  if (readBundledCompiledArtifacts() !== null) {
    return createBundledRuntimeCompiledArtifactsSource();
  }

  throw new Error("eve Nitro production requires bundled artifacts.");
}

/** Resolves the immutable artifact generation stamped on one admitted request. */
export function resolveNitroRequestCompiledArtifactsSource(
  config: NitroArtifactsConfig,
  request: Request,
): RuntimeCompiledArtifactsSource {
  if (config.kind === "production") {
    return resolveNitroCompiledArtifactsSource(config);
  }

  const metadata = readDevelopmentWorkerRequestMetadata(request);
  if (metadata === undefined) {
    throw new Error("Development request is missing its admitted artifact generation.");
  }

  return createDiskRuntimeCompiledArtifactsSource(metadata.runtimeAppRoot, {
    moduleMapLoaderPath: config.moduleMapLoaderPath,
    sandboxAppRoot: config.appRoot,
  });
}
