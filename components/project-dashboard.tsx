"use client";

import {
  ArrowUpRight,
  Clock3,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  createStudioProject,
  initializeProjectStorage,
  readStudioProject,
  saveProjectIndex,
  saveStudioProject,
  type StudioProject,
} from "@/lib/studio-projects";

function projectStage(project: StudioProject) {
  if (project.snapshot.video.url) return { step: 3, label: "Ready to compose" };
  if (project.snapshot.video.requestId) return { step: 2, label: "Video generating" };
  if (project.snapshot.image.url) return { step: 2, label: "First frame ready" };
  if (project.snapshot.image.requestId) return { step: 1, label: "Image generating" };
  return { step: 1, label: "Draft" };
}

function updatedLabel(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently updated";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) return `Updated ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `Updated ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: new Date(timestamp).getFullYear() === new Date().getFullYear()
      ? undefined
      : "numeric",
  }).format(timestamp)}`;
}

export function ProjectDashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    let loaded: StudioProject[] = [];
    let unavailable = false;
    try {
      loaded = initializeProjectStorage(window.localStorage).projects;
      unavailable = loaded.some(
        (project) => !readStudioProject(window.localStorage, project.id),
      );
    } catch {
      unavailable = true;
    }

    loaded.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    queueMicrotask(() => {
      setProjects(loaded);
      setStorageError(unavailable);
      setReady(true);
    });
  }, []);

  const openProject = (projectId: string) => {
    try {
      saveProjectIndex(window.localStorage, projects, projectId);
    } catch {
      // Navigation still works for this browser session.
    }
  };

  const createProject = () => {
    if (storageError || projects.length >= 50) return;
    const project = createStudioProject("Untitled project");
    const nextProjects = [project, ...projects];
    let saved = false;
    try {
      saved = saveStudioProject(window.localStorage, project);
      if (saved) saveProjectIndex(window.localStorage, nextProjects, project.id);
    } catch {
      saved = false;
    }
    if (!saved) {
      setStorageError(true);
      window.alert("A new project could not be saved. Check this browser's storage settings.");
      return;
    }
    setProjects(nextProjects);
    router.push(`/projects/${project.id}`);
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <Link className="brand" href="/" aria-label="OneTake projects">
          <span className="brand-mark"><Film size={19} /></span>
          <span>OneTake</span>
        </Link>
        <span className="local-workspace-pill">
          <FolderOpen size={14} /> Media stored on backend
        </span>
      </header>

      <section className="dashboard-content">
        <div className="dashboard-intro">
          <div>
            <span className="dashboard-eyebrow">PROJECT LIBRARY</span>
            <h1 className="sr-only">Your videos, one workspace at a time.</h1>
            <p>
              Open a project to continue from its saved image, motion, and composition.
            </p>
          </div>
          <button
            className="new-project-button"
            disabled={storageError || projects.length >= 50}
            onClick={createProject}
            type="button"
          >
            <Plus size={18} /> New project
          </button>
        </div>

        {storageError ? (
          <div className="dashboard-storage-error" role="alert">
            <strong>Browser storage is unavailable.</strong>
            <span>Allow local storage for this site to create and reopen projects.</span>
          </div>
        ) : null}

        {!ready ? (
          <div className="project-grid" aria-busy="true" aria-label="Loading projects">
            {[0, 1, 2].map((item) => (
              <div className="project-card project-card-skeleton" key={item} />
            ))}
          </div>
        ) : (
          <div className="project-grid" aria-label="Projects">
            {projects.map((project) => {
              const stage = projectStage(project);
              const summary =
                project.snapshot.motionPrompt ||
                project.snapshot.imagePrompt ||
                "Start with a prompt and create your first frame.";

              return (
                <Link
                  className="project-card"
                  href={`/projects/${project.id}`}
                  key={project.id}
                  onClick={() => openProject(project.id)}
                  prefetch={false}
                >
                  <div className="project-thumbnail">
                    <div className="project-placeholder">
                      <span><ImageIcon size={24} /></span>
                      <Sparkles aria-hidden="true" size={15} />
                    </div>
                    {project.snapshot.image.url ? (
                      // Backend media URLs are dynamic, so a native image element is intentional.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        onError={(event) => { event.currentTarget.hidden = true; }}
                        src={project.snapshot.image.url}
                      />
                    ) : null}
                    <span className="project-stage">STEP {stage.step} OF 3</span>
                  </div>
                  <div className="project-card-body">
                    <div className="project-card-title">
                      <div>
                        <h2>{project.name}</h2>
                        <span>{stage.label}</span>
                      </div>
                      <span className="project-open-icon"><ArrowUpRight size={17} /></span>
                    </div>
                    <p>{summary}</p>
                    <div className="project-card-footer">
                      <span>
                        <Clock3 size={12} />
                        <time dateTime={project.updatedAt}>{updatedLabel(project.updatedAt)}</time>
                      </span>
                      <strong>Open workspace</strong>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
