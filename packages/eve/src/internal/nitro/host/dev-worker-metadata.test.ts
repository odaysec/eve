import { describe, expect, it } from "vitest";

import {
  decodeDevelopmentWorkerMetadata,
  encodeDevelopmentWorkerMetadata,
} from "#internal/nitro/host/dev-worker-metadata.js";

describe("development worker metadata", () => {
  it("accepts metadata signed by the parent transport", () => {
    const metadata = {
      clientAddress: "192.0.2.10",
      generationId: "generation-a",
      runtimeAppRoot: "/app/.eve/dev-runtime/snapshots/generation-a/source/app",
    };
    const header = encodeDevelopmentWorkerMetadata({ metadata, secret: "parent-secret" });

    expect(decodeDevelopmentWorkerMetadata({ header, secret: "parent-secret" })).toEqual(metadata);
  });

  it("rejects metadata that a public caller cannot sign", () => {
    const header = encodeDevelopmentWorkerMetadata({
      metadata: {
        clientAddress: "203.0.113.50",
        generationId: "generation-a",
        runtimeAppRoot: "/app/.eve/dev-runtime/snapshots/generation-a/source/app",
      },
      secret: "public-secret",
    });

    expect(() => decodeDevelopmentWorkerMetadata({ header, secret: "parent-secret" })).toThrow(
      "not trusted",
    );
  });
});
