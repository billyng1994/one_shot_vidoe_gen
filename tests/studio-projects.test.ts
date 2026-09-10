import { describe, expect, it } from "vitest";

import {
  createEmptyStudioSnapshot,
  isProjectId,
  LEGACY_PROJECT_ID,
  parseStudioProject,
  renameStudioProject,
  updateProjectSnapshot,
  type StudioProject,
} from "../lib/studio-projects";
import type { StudioSnapshot } from "../lib/studio-state";

const PROJECT_A = "12345678-1234-4234-8234-123456789012";
const NOW = "2026-09-06T12:00:00.000Z";

function snapshot(prompt: string): StudioSnapshot {
  return {
    ...createEmptyStudioSnapshot(),
    imagePrompt: prompt,
  };
}

function project(overrides: Partial<StudioProject> = {}): StudioProject {
  return {
    version: 2,
    id: PROJECT_A,
    name: "Campaign A",
    createdAt: NOW,
    updatedAt: NOW,
    snapshot: snapshot("Red portrait"),
    ...overrides,
  };
}

describe("project documents", () => {
  it("parses backend project objects and JSON documents", () => {
    const value = project();

    expect(parseStudioProject(value)).toEqual(value);
    expect(parseStudioProject(JSON.stringify(value))).toEqual(value);
  });

  it("rejects malformed, mismatched, and unsafe project documents", () => {
    const circularSnapshot: Record<string, unknown> = {};
    circularSnapshot.self = circularSnapshot;

    expect(parseStudioProject(null)).toBeNull();
    expect(parseStudioProject("not JSON")).toBeNull();
    expect(parseStudioProject({ ...project(), version: 1 })).toBeNull();
    expect(parseStudioProject({ ...project(), id: "../../credentials.json" })).toBeNull();
    expect(parseStudioProject({ ...project(), snapshot: circularSnapshot })).toBeNull();
    expect(parseStudioProject(project(), "87654321-4321-4321-8321-210987654321")).toBeNull();
  });

  it("normalizes recoverable fields from an untrusted response", () => {
    const parsed = parseStudioProject({
      ...project(),
      name: "   Launch    campaign   ",
      createdAt: "invalid",
      updatedAt: "invalid",
      snapshot: {
        ...snapshot("Prompt"),
        imagePrompt: "x".repeat(4_010),
        musicVolume: 3,
      },
    });

    expect(parsed).toMatchObject({
      name: "Launch campaign",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      snapshot: { musicVolume: 1 },
    });
    expect(parsed?.snapshot.imagePrompt).toHaveLength(4_000);
  });

  it("accepts UUID and legacy project identifiers only", () => {
    expect(isProjectId(PROJECT_A)).toBe(true);
    expect(isProjectId(LEGACY_PROJECT_ID)).toBe(true);
    expect(isProjectId("../../credentials.json")).toBe(false);
    expect(isProjectId("1234")).toBe(false);
  });

  it("creates independent empty snapshots", () => {
    const first = createEmptyStudioSnapshot();
    const second = createEmptyStudioSnapshot();

    first.title.text = "Changed";
    expect(second.title.text).toBe("Your story starts here");
  });

  it("updates a snapshot without mutating the original project", () => {
    const original = project();
    const updated = updateProjectSnapshot(
      original,
      snapshot("Only the new project changed"),
      "2026-09-06T12:01:00.000Z",
    );

    expect(updated.snapshot.imagePrompt).toBe("Only the new project changed");
    expect(updated.updatedAt).toBe("2026-09-06T12:01:00.000Z");
    expect(original.snapshot.imagePrompt).toBe("Red portrait");
    expect(original.updatedAt).toBe(NOW);
  });

  it("normalizes project names and preserves the existing name for blank input", () => {
    const original = project();

    expect(renameStudioProject(original, "  Launch   film  ", NOW).name).toBe("Launch film");
    expect(renameStudioProject(original, "   ", NOW).name).toBe("Campaign A");
    expect(original.name).toBe("Campaign A");
  });
});
