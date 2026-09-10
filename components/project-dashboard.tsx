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

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth-provider";
import { parseStudioProject, type StudioProject } from "@/lib/studio-projects";

const MAX_PROJECTS = 50;

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
  const { request } = useAuth();
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void request<{ projects: unknown[] }>("/api/projects", {
      signal: controller.signal,
    })
      .then((response) => {
        if (!Array.isArray(response.projects)) {
          throw new Error("The server returned an invalid project list.");
        }
        const parsed = response.projects.map((project) => parseStudioProject(project));
        if (parsed.some((project) => project === null)) {
          throw new Error("The server returned an invalid project.");
        }
        const loaded = parsed as StudioProject[];
        loaded.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        if (!active) return;
        setProjects(loaded);
        setError("");
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "Projects could not be loaded.");
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadVersion, request]);

  const retry = () => {
    setError("");
    setLoading(true);
    setReloadVersion((version) => version + 1);
  };

  const createProject = async () => {
    if (creating || loading || projects.length >= MAX_PROJECTS) return;
    setCreating(true);
    setError("");
    try {
      const response = await request<unknown>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled project" }),
      });
      const project = parseStudioProject(response);
      if (!project) throw new Error("The server returned an invalid project.");
      setProjects((current) => [project, ...current]);
      router.push(`/projects/${project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be created.");
      setCreating(false);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <Link className="brand" href="/" aria-label="OneTake projects">
          <span className="brand-mark"><Film size={19} /></span>
          <span>OneTake</span>
        </Link>
        <div className="dashboard-header-actions">
          <span className="local-workspace-pill">
            <FolderOpen size={14} /> Projects and media stored on backend
          </span>
          <AccountMenu />
        </div>
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
            disabled={creating || loading || projects.length >= MAX_PROJECTS}
            onClick={createProject}
            type="button"
          >
            {creating ? <Clock3 className="spin" size={18} /> : <Plus size={18} />}
            {creating ? "Creating…" : "New project"}
          </button>
        </div>

        {error ? (
          <div className="dashboard-storage-error" role="alert">
            <strong>Projects are unavailable.</strong>
            <span>{error}</span>
            <button onClick={retry} type="button">Retry</button>
          </div>
        ) : null}

        {loading ? (
          <div className="project-grid" aria-busy="true" aria-label="Loading projects">
            {[0, 1, 2].map((item) => (
              <div className="project-card project-card-skeleton" key={item} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="project-grid" aria-label="Projects">
            <section className="project-card">
              <div className="project-card-body">
                <span className="dashboard-eyebrow">EMPTY LIBRARY</span>
                <h2>No projects yet</h2>
                <p>Create a project to generate your first frame and video.</p>
              </div>
            </section>
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
