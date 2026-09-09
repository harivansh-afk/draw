import { describe, expect, it, vi } from "vitest";

import { createBackfill } from "../thumbnails";

import type { BackfillResult } from "../thumbnails";

type Deferred = {
  promise: Promise<BackfillResult>;
  resolve: (value: BackfillResult) => void;
  reject: (error: unknown) => void;
};

const deferred = (): Deferred => {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<BackfillResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBackfill", () => {
  it("runs at most `concurrency` generations at once, in list order", async () => {
    const pending = new Map<string, Deferred>();
    const generate = vi.fn((id: string) => {
      const d = deferred();
      pending.set(id, d);
      return d.promise;
    });
    const onDone = vi.fn();
    const backfill = createBackfill({ generate, onDone, concurrency: 2 });

    backfill.sync(["a", "b", "c", "d"]);
    expect(generate.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);

    pending.get("a")!.resolve("uploaded");
    await flush();
    expect(generate.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(onDone).toHaveBeenCalledWith("a", "uploaded");

    pending.get("b")!.resolve("empty");
    pending.get("c")!.reject(new Error("boom"));
    await flush();
    expect(generate.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
    expect(onDone).toHaveBeenCalledWith("b", "empty");
    expect(onDone).toHaveBeenCalledWith("c", "failed");
  });

  it("never retries an id within the session, even after failure", async () => {
    const generate = vi.fn(async (id: string): Promise<BackfillResult> => {
      if (id === "bad") {
        throw new Error("nope");
      }
      return "uploaded";
    });
    const onDone = vi.fn();
    const backfill = createBackfill({ generate, onDone });

    backfill.sync(["bad", "ok"]);
    await flush();
    backfill.sync(["bad", "ok", "ok"]);
    await flush();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it("drops ids that left the screen before their turn", async () => {
    const pending = new Map<string, Deferred>();
    const generate = vi.fn((id: string) => {
      const d = deferred();
      pending.set(id, d);
      return d.promise;
    });
    const backfill = createBackfill({
      generate,
      onDone: vi.fn(),
      concurrency: 1,
    });

    backfill.sync(["a", "gone", "c"]);
    backfill.sync(["a", "c"]);
    pending.get("a")!.resolve("uploaded");
    await flush();

    expect(generate.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
  });

  it("stops scheduling after stop()", async () => {
    const generate = vi.fn(async (): Promise<BackfillResult> => "uploaded");
    const backfill = createBackfill({
      generate,
      onDone: vi.fn(),
      concurrency: 1,
    });
    backfill.sync(["a", "b"]);
    backfill.stop();
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
