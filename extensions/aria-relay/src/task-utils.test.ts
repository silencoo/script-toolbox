import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  getStatusGroup,
  getTaskEtaSeconds,
  getTaskName,
  getTaskProgress,
  taskMatchesQuery
} from "./task-utils";
import type { AriaTask } from "./types";

describe("task presentation", () => {
  it("prefers a torrent display name", () => {
    const task = makeTask({
      bittorrent: { info: { name: "Ubuntu 26.04" }, mode: "single" },
      files: [
        {
          completedLength: "0",
          index: "1",
          length: "100",
          path: "/downloads/opaque-name.iso",
          selected: "true",
          uris: []
        }
      ]
    });
    expect(getTaskName(task)).toBe("Ubuntu 26.04");
  });

  it("calculates bounded progress and ETA", () => {
    const task = makeTask({
      completedLength: "25000000",
      downloadSpeed: "5000000",
      status: "active",
      totalLength: "100000000"
    });
    expect(getTaskProgress(task)).toBe(25);
    expect(getTaskEtaSeconds(task)).toBe(15);
  });

  it("groups paused and waiting tasks together", () => {
    expect(getStatusGroup(makeTask({ status: "paused" }))).toBe("waiting");
    expect(getStatusGroup(makeTask({ status: "waiting" }))).toBe("waiting");
  });

  it("searches file names, source URLs and GIDs", () => {
    const task = makeTask({});
    expect(taskMatchesQuery(task, "archive.zip")).toBe(true);
    expect(taskMatchesQuery(task, "cdn.example.com")).toBe(true);
    expect(taskMatchesQuery(task, "01234567")).toBe(true);
    expect(taskMatchesQuery(task, "not-here")).toBe(false);
  });

  it("formats transfer values for compact task rows", () => {
    expect(formatBytes(1_500_000)).toBe("1.50 MB");
    expect(formatDuration(65)).toBe("2 分钟");
    expect(formatDuration(undefined)).toBe("—");
  });
});

function makeTask(overrides: Partial<AriaTask>): AriaTask {
  return {
    completedLength: "0",
    dir: "/downloads",
    downloadSpeed: "0",
    files: [
      {
        completedLength: "0",
        index: "1",
        length: "100",
        path: "/downloads/archive.zip",
        selected: "true",
        uris: [{ status: "used", uri: "https://cdn.example.com/archive.zip" }]
      }
    ],
    gid: "0123456789abcdef",
    status: "waiting",
    totalLength: "100",
    uploadLength: "0",
    uploadSpeed: "0",
    ...overrides
  };
}
