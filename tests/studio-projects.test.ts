import { describe, expect, it } from "vitest";

import {
  createEmptyStudioSnapshot,
  createStudioProject,
  initializeProjectStorage,
  LEGACY_PROJECT_ID,
  PROJECT_INDEX_STORAGE_KEY,
  projectStorageKey,
  readStudioProject,
  saveProjectIndex,
  saveStudioProject,
  updateProjectSnapshot,
} from "../lib/studio-projects";
import {
  serializeStudioSnapshot,
  STUDIO_STORAGE_KEY,
  type StudioSnapshot,
} from "../lib/studio-state";

const PROJECT_A = "12345678-1234-4234-8234-123456789012";
const PROJECT_B = "87654321-4321-4321-8321-210987654321";
const NOW = "2026-09-06T12:00:00.000Z";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failWrites = false;
  failRemoval = false;

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    if (this.failRemoval) throw new DOMException("Blocked", "SecurityError");
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException("Full", "QuotaExceededError");
    this.values.set(key, value);
  }
}

function snapshot(prompt: string): StudioSnapshot {
  return {
    ...createEmptyStudioSnapshot(),
    imagePrompt: prompt,
  };
}

describe("project workspaces", () => {
  it("migrates the legacy single workspace exactly once", () => {
    const storage = new MemoryStorage();
    storage.setItem(STUDIO_STORAGE_KEY, serializeStudioSnapshot(snapshot("Legacy prompt")));

    const first = initializeProjectStorage(storage, { id: PROJECT_A, now: NOW });
    const second = initializeProjectStorage(storage, { id: PROJECT_B, now: NOW });

    expect(first.activeProjectId).toBe(LEGACY_PROJECT_ID);
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]).toMatchObject({
      id: LEGACY_PROJECT_ID,
      name: "My first project",
      source: "legacy-studio-v1",
      snapshot: { imagePrompt: "Legacy prompt" },
    });
    expect(second.projects).toHaveLength(1);
    expect(storage.getItem(STUDIO_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(PROJECT_INDEX_STORAGE_KEY)).not.toBeNull();
  });

  it("keeps each project's workspace data isolated and restores the last project", () => {
    const storage = new MemoryStorage();
    const first = createStudioProject("Campaign A", {
      id: PROJECT_A,
      now: NOW,
      snapshot: snapshot("Red portrait"),
    });
    const second = createStudioProject("Campaign B", {
      id: PROJECT_B,
      now: NOW,
      snapshot: snapshot("Blue landscape"),
    });

    expect(saveStudioProject(storage, first)).toBe(true);
    expect(saveStudioProject(storage, second)).toBe(true);
    expect(saveProjectIndex(storage, [first, second], PROJECT_B)).toBe(true);

    const restored = initializeProjectStorage(storage, { now: NOW });

    expect(restored.activeProjectId).toBe(PROJECT_B);
    expect(readStudioProject(storage, PROJECT_A)?.snapshot.imagePrompt).toBe("Red portrait");
    expect(readStudioProject(storage, PROJECT_B)?.snapshot.imagePrompt).toBe("Blue landscape");
  });

  it("updates one snapshot without changing another project", () => {
    const storage = new MemoryStorage();
    const first = createStudioProject("First", { id: PROJECT_A, now: NOW });
    const second = createStudioProject("Second", { id: PROJECT_B, now: NOW });
    saveStudioProject(storage, first);
    saveStudioProject(storage, second);

    saveStudioProject(
      storage,
      updateProjectSnapshot(first, snapshot("Only project A changed"), "2026-09-06T12:01:00.000Z"),
    );

    expect(readStudioProject(storage, PROJECT_A)?.snapshot.imagePrompt).toBe(
      "Only project A changed",
    );
    expect(readStudioProject(storage, PROJECT_B)?.snapshot.imagePrompt).toBe("");
  });

  it("recovers an orphaned project document when the index is missing", () => {
    const storage = new MemoryStorage();
    const project = createStudioProject("Recovered", { id: PROJECT_A, now: NOW });
    saveStudioProject(storage, project);

    const restored = initializeProjectStorage(storage, { id: PROJECT_B, now: NOW });

    expect(restored.projects.map(({ id }) => id)).toEqual([PROJECT_A]);
    expect(restored.activeProjectId).toBe(PROJECT_A);
  });

  it("retains legacy data when storage writes fail", () => {
    const storage = new MemoryStorage();
    storage.setItem(STUDIO_STORAGE_KEY, serializeStudioSnapshot(snapshot("Keep me")));
    storage.failWrites = true;

    const restored = initializeProjectStorage(storage, { id: PROJECT_A, now: NOW });

    expect(storage.getItem(STUDIO_STORAGE_KEY)).not.toBeNull();
    expect(restored.projects).toHaveLength(1);
    expect(restored.projects[0].id).toBe(PROJECT_A);
  });

  it("never builds a storage key from an unsafe project ID", () => {
    expect(() => projectStorageKey("../../credentials.json")).toThrow("Invalid project ID");
  });
});
