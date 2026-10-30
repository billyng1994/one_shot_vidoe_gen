"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Film,
  LayoutTemplate,
  LoaderCircle,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth-provider";
import {
  parseCompositionTemplateList,
  type CompositionTemplateSummary,
} from "@/lib/composition-templates";
import { parseStudioProject, type StudioProject } from "@/lib/studio-projects";

function updatedLabel(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently updated";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(timestamp);
}

function actionMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function TemplateDashboard() {
  const router = useRouter();
  const { request } = useAuth();
  const [templates, setTemplates] = useState<CompositionTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyTemplateId, setBusyTemplateId] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [partialProject, setPartialProject] = useState<Pick<StudioProject, "id" | "name"> | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void request<unknown>("/api/composition-templates", {
      cache: "no-store",
      signal: controller.signal,
    }).then((response) => {
      const parsed = parseCompositionTemplateList(response);
      if (!parsed) throw new Error("The server returned an invalid template library.");
      setTemplates(parsed);
      setLoading(false);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(actionMessage(cause, "Templates could not be loaded."));
      setLoading(false);
    });

    return () => controller.abort();
  }, [reloadVersion, request]);

  const retry = useCallback(() => {
    setLoading(true);
    setError("");
    setPartialProject(null);
    setReloadVersion((version) => version + 1);
  }, []);

  const createProjectFromTemplate = async (template: CompositionTemplateSummary) => {
    if (busyTemplateId) return;
    setBusyTemplateId(template.id);
    setError("");
    setPartialProject(null);
    let createdProject: StudioProject | null = null;
    try {
      const created = await request<unknown>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${template.name} project`.slice(0, 80) }),
      });
      createdProject = parseStudioProject(created);
      if (!createdProject) throw new Error("The server returned an invalid new project.");

      const applied = await request<unknown>(
        `/api/projects/${encodeURIComponent(createdProject.id)}/composition/apply-template`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId: template.id,
            expectedProjectUpdatedAt: createdProject.updatedAt,
          }),
        },
      );
      const body = applied && typeof applied === "object" && !Array.isArray(applied)
        ? applied as Record<string, unknown>
        : null;
      const project = parseStudioProject(body?.project, createdProject.id);
      if (!project) throw new Error("The server returned an invalid applied project.");
      router.push(`/projects/${project.id}`);
    } catch (cause) {
      setError(actionMessage(cause, "The template could not be used in a new project."));
      if (createdProject) {
        setPartialProject({ id: createdProject.id, name: createdProject.name });
      }
      setBusyTemplateId("");
    }
  };

  return (
    <main className="dashboard-shell template-dashboard-shell">
      <header className="dashboard-header template-dashboard-header">
        <Link className="brand" href="/" aria-label="OneTake projects">
          <span className="brand-mark"><Film size={19} /></span>
          <span>OneTake</span>
        </Link>
        <div className="dashboard-header-actions">
          <Link className="back-button template-back-link" href="/">
            <ArrowLeft size={15} /> Projects
          </Link>
          <AccountMenu />
        </div>
      </header>

      <section className="dashboard-content template-dashboard-content">
        <div className="dashboard-intro template-dashboard-intro">
          <div>
            <span className="dashboard-eyebrow">TEMPLATE LIBRARY</span>
            <h1>Saved frame templates</h1>
            <p>Reuse complete Step 3 layouts, including artwork, logos, text, and positioning.</p>
          </div>
          <Link className="new-project-button template-create-hint" href="/">
            <Plus size={18} /> Save one from a project
          </Link>
        </div>

        {error ? (
          <div className="dashboard-storage-error template-dashboard-error" role="alert">
            <strong>{partialProject ? "The new project was created, but the template was not applied." : "Templates are unavailable."}</strong>
            <span>{error}</span>
            {partialProject ? (
              <Link href={`/projects/${partialProject.id}`}>
                Open {partialProject.name} <ArrowUpRight size={14} />
              </Link>
            ) : (
              <button onClick={retry} type="button">Retry</button>
            )}
          </div>
        ) : null}

        {loading ? (
          <div aria-busy="true" aria-label="Loading templates" className="project-grid template-grid">
            {[0, 1, 2].map((item) => (
              <div className="project-card project-card-skeleton template-card-skeleton" key={item} />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <section className="template-dashboard-empty">
            <LayoutTemplate aria-hidden="true" size={28} />
            <h2>No saved templates yet</h2>
            <p>Open a project, finish its Step 3 layout, then choose Save current.</p>
            <Link className="primary-button" href="/">Browse projects</Link>
          </section>
        ) : (
          <div aria-label="Saved templates" className="project-grid template-grid">
            {templates.map((template) => {
              const busy = busyTemplateId === template.id;
              return (
                <article className="project-card template-dashboard-card" key={template.id}>
                  <Link
                    aria-label={`Edit ${template.name}`}
                    className="template-dashboard-card-link"
                    href={`/templates/${template.id}`}
                    prefetch={false}
                  >
                    <div className="project-thumbnail template-card-thumbnail">
                      <span className="template-card-icon"><LayoutTemplate size={30} /></span>
                      <span className="project-stage">{template.layerCount} LAYERS</span>
                    </div>
                    <div className="project-card-body">
                      <div className="project-card-title">
                        <div>
                          <h2>{template.name}</h2>
                          <span>{template.textLayerCount} text · {template.imageLayerCount} images</span>
                        </div>
                        <span className="project-open-icon"><ArrowUpRight size={17} /></span>
                      </div>
                      <div className="project-card-footer">
                        <span><Clock3 size={12} /> Updated {updatedLabel(template.updatedAt)}</span>
                        <strong>Edit template</strong>
                      </div>
                    </div>
                  </Link>
                  <button
                    className="primary-button template-use-button"
                    disabled={Boolean(busyTemplateId)}
                    onClick={() => void createProjectFromTemplate(template)}
                    type="button"
                  >
                    {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                    {busy ? "Creating project…" : "Use in new project"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
