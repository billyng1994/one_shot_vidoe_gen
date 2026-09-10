"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Move,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth-provider";
import {
  BRAND_LOGO_RECT,
  DEFAULT_TITLE,
  OUTPUT_SIZE,
  type TitlePlacement,
} from "@/lib/composition";
import type {
  BackendHealth,
  GenerationRequest,
  GenerationStatus,
  RenderResponse,
} from "@/lib/api-types";
import {
  type PersistedAsset,
  type StudioSnapshot,
} from "@/lib/studio-state";
import { parseStudioProject, type StudioProject } from "@/lib/studio-projects";

type Step = 1 | 2 | 3;
type JobPhase = "idle" | "submitting" | GenerationStatus | "error";
type JobState = { phase: JobPhase; message?: string };
const IMAGE_IDEAS = [
  "A warm documentary portrait in soft morning light",
  "A joyful family reunion, cinematic natural light",
  "A quiet classroom moment, editorial photography",
];

const MOTION_IDEAS = [
  "A gentle push-in as the subjects breathe and blink naturally",
  "Subtle handheld movement with a soft breeze and natural expressions",
  "Slow cinematic dolly-in; preserve faces, clothing, and composition",
];

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("The request was canceled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function pollGeneration(
  initial: GenerationRequest,
  onStatus: (status: GenerationStatus) => void,
  request: ApiRequest,
  signal?: AbortSignal,
) {
  let result = initial;
  let delay = 2_000;
  const deadline = Date.now() + 12 * 60_000;
  const terminal = new Set<GenerationStatus>([
    "completed",
    "failed",
    "nsfw",
    "canceled",
  ]);

  while (!terminal.has(result.status)) {
    if (Date.now() > deadline) {
      throw new Error(
        "Generation is still running. Please wait a moment and try the status again.",
      );
    }
    await sleep(delay, signal);
    result = await request<GenerationRequest>(
      `/api/generations/${encodeURIComponent(result.request_id)}`,
      { cache: "no-store", signal },
    );
    onStatus(result.status);
    delay = Math.min(Math.round(delay * 1.35), 10_000);
  }

  if (result.status !== "completed") {
    const reason =
      result.status === "nsfw"
        ? "Higgsfield’s safety filter did not approve this generation."
        : result.error || `Generation ended with status “${result.status}”.`;
    throw new Error(reason);
  }

  return result;
}

function StatusDot({ phase }: { phase: JobPhase }) {
  const active = phase === "submitting" || phase === "queued" || phase === "in_progress";
  return active ? (
    <LoaderCircle aria-hidden="true" className="spin" size={16} />
  ) : phase === "completed" ? (
    <Check aria-hidden="true" size={16} />
  ) : (
    <Sparkles aria-hidden="true" size={16} />
  );
}

function WorkflowNav({
  step,
  imageReady,
  videoReady,
  onStep,
}: {
  step: Step;
  imageReady: boolean;
  videoReady: boolean;
  onStep: (step: Step) => void;
}) {
  const items: Array<{ step: Step; eyebrow: string; label: string; enabled: boolean }> = [
    { step: 1, eyebrow: "01", label: "Create still", enabled: true },
    { step: 2, eyebrow: "02", label: "Add motion", enabled: imageReady },
    { step: 3, eyebrow: "03", label: "Finish & export", enabled: videoReady },
  ];

  return (
    <nav className="workflow-nav" aria-label="Video workflow">
      {items.map((item, index) => (
        <div className="workflow-segment" key={item.step}>
          <button
            className={`workflow-step ${step === item.step ? "is-active" : ""} ${
              step > item.step ? "is-done" : ""
            }`}
            disabled={!item.enabled}
            onClick={() => onStep(item.step)}
            type="button"
          >
            <span className="step-index">
              {step > item.step ? (
                <Check size={14} />
              ) : (
                item.eyebrow
              )}
            </span>
            <span>{item.label}</span>
          </button>
          {index < items.length - 1 ? <span className="workflow-line" /> : null}
        </div>
      ))}
    </nav>
  );
}

function ProjectControls({
  projects,
  activeProjectId,
  disabled,
  onCreate,
  onDelete,
  onRename,
  onSelect,
}: {
  projects: StudioProject[];
  activeProjectId: string;
  disabled: boolean;
  onCreate: () => void;
  onDelete: () => void;
  onRename: () => void;
  onSelect: (projectId: string) => void;
}) {
  return (
    <div className="project-controls">
      <FolderOpen aria-hidden="true" size={17} />
      <label className="project-picker">
        <span>PROJECT</span>
        <select
          aria-label="Switch project"
          disabled={disabled || projects.length === 0}
          onChange={(event) => onSelect(event.target.value)}
          value={activeProjectId}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button
        aria-label="Create project"
        disabled={disabled}
        onClick={onCreate}
        title="Create project"
        type="button"
      >
        <Plus size={15} />
      </button>
      <button
        aria-label="Rename project"
        disabled={disabled || !activeProjectId}
        onClick={onRename}
        title="Rename project"
        type="button"
      >
        <Pencil size={14} />
      </button>
      <button
        aria-label="Delete project"
        className="project-delete"
        disabled={disabled || !activeProjectId}
        onClick={onDelete}
        title="Delete project"
        type="button"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function JobMessage({ job }: { job: JobState }) {
  if (job.phase === "idle") return null;
  const isError = job.phase === "error";
  const labels: Partial<Record<JobPhase, string>> = {
    submitting: "Sending your prompt…",
    queued: "Queued at Higgsfield…",
    in_progress: "Generating — this can take a few minutes…",
    completed: "Ready",
    error: job.message ?? "Generation failed.",
  };

  return (
    <div className={`job-message ${isError ? "is-error" : ""}`} role="status">
      <StatusDot phase={job.phase} />
      <span>{labels[job.phase]}</span>
    </div>
  );
}

function CredentialNotice({ health }: { health: BackendHealth | null }) {
  if (!health || health.configured || health.mockMode) return null;

  const message = !health.storage.writable
    ? "Make BACKEND_DATA_DIR writable on the backend host, then restart the service."
    : health.cli.installed
      ? "Run `higgsfield auth login` on the backend host, then restart the backend."
      : "Install the Higgsfield CLI on the backend, authenticate it, then restart the service.";
  const title = health.storage.writable
    ? "Connect Higgsfield to generate"
    : "Backend storage is unavailable";

  return (
    <div className="credential-notice">
      <div className="notice-icon">
        <KeyRound size={18} />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function EmptyArtwork({ kind }: { kind: "image" | "video" }) {
  return (
    <div className="empty-artwork">
      <div className="orb orb-one" />
      <div className="orb orb-two" />
      <div className="empty-icon">
        {kind === "image" ? <ImageIcon size={28} /> : <Film size={28} />}
      </div>
      <p>{kind === "image" ? "Your first frame will appear here" : "Your motion preview will appear here"}</p>
    </div>
  );
}

export function Studio({ initialProjectId }: { initialProjectId: string }) {
  const router = useRouter();
  const { request } = useAuth();
  const [step, setStep] = useState<Step>(1);
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [motionPrompt, setMotionPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageRequestId, setImageRequestId] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoRequestId, setVideoRequestId] = useState("");
  const [duration, setDuration] = useState<5 | 8 | 10>(5);
  const [resolution, setResolution] = useState<"720" | "1080">("720");
  const [cameraFixed, setCameraFixed] = useState(false);
  const [imageJob, setImageJob] = useState<JobState>({ phase: "idle" });
  const [videoJob, setVideoJob] = useState<JobState>({ phase: "idle" });
  const [title, setTitle] = useState<TitlePlacement>(DEFAULT_TITLE);
  const [music, setMusic] = useState<File | null>(null);
  const [musicUrl, setMusicUrl] = useState("");
  const [musicVolume, setMusicVolume] = useState(0.24);
  const [renderJob, setRenderJob] = useState<JobState>({ phase: "idle" });
  const [isPlaying, setIsPlaying] = useState(false);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [hydratedProjectId, setHydratedProjectId] = useState("");
  const [projectMissing, setProjectMissing] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const projectsRef = useRef<StudioProject[]>([]);
  const activeProjectIdRef = useRef("");
  const lastSavedSnapshotRef = useRef("");
  const saveRevisionRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef<{
    projectId: string;
    revision: number;
    serialized: string;
    snapshot: StudioSnapshot;
  } | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);

  const runQueuedSave = useCallback(async () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const operation = (async () => {
      while (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        setSaveStatus("saving");
        try {
          const updated = await request<StudioProject>(
            `/api/projects/${encodeURIComponent(pending.projectId)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ snapshot: pending.snapshot }),
            },
          );
          lastSavedSnapshotRef.current = pending.serialized;
          projectsRef.current = projectsRef.current.map((project) =>
            project.id === pending.projectId
              ? { ...project, name: updated.name, updatedAt: updated.updatedAt }
              : project,
          );
        } catch (error) {
          if (!pendingSaveRef.current) pendingSaveRef.current = pending;
          setSaveStatus("error");
          throw error;
        }
      }
      setSaveStatus("saved");
    })();

    saveInFlightRef.current = operation;
    try {
      await operation;
    } finally {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
    }
  }, [request]);

  useEffect(() => {
    request<BackendHealth>("/api/health", { cache: "no-store" })
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [request]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    activeProjectIdRef.current = "";
    queueMicrotask(() => {
      if (!active) return;
      setActiveProjectId("");
      setHydratedProjectId("");
      setProjectMissing(false);
      setProjectLoadError("");
    });

    const loadProject = async () => {
      try {
        if (pendingSaveRef.current || saveInFlightRef.current) await runQueuedSave();
        const response = await request<{ projects: unknown[] }>("/api/projects", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!Array.isArray(response.projects)) {
          throw new Error("The server returned an invalid project list.");
        }
        const parsed = response.projects.map((project) => parseStudioProject(project));
        if (parsed.some((project) => project === null)) {
          throw new Error("The server returned an invalid project.");
        }
        if (!active) return;
        const loadedProjects = parsed as StudioProject[];
        projectsRef.current = loadedProjects;
        setProjects(loadedProjects);
        const requestedProject = loadedProjects.find(({ id }) => id === initialProjectId);
        if (!requestedProject) {
          setProjectMissing(true);
          return;
        }
        activeProjectIdRef.current = requestedProject.id;
        setActiveProjectId(requestedProject.id);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setProjectLoadError(
          error instanceof Error ? error.message : "The project library could not be loaded.",
        );
      }
    };
    void loadProject();

    return () => {
      active = false;
      controller.abort();
    };
  }, [initialProjectId, request, runQueuedSave]);

  useEffect(() => {
    if (!activeProjectId) return;

    const controller = new AbortController();
    let active = true;
    const workspaceId = activeProjectId;
    const project = projectsRef.current.find((candidate) => candidate.id === workspaceId) ?? null;
    if (!project) return;
    const snapshot = project.snapshot;
    lastSavedSnapshotRef.current = JSON.stringify(snapshot);
    pendingSaveRef.current = null;
    setSaveStatus("idle");

    const restoreAsset = async (kind: "image" | "video", asset: PersistedAsset) => {
      if (!asset.requestId || asset.requestId.startsWith("demo-")) return;
      const setJob = kind === "image" ? setImageJob : setVideoJob;

      try {
        const current = await request<GenerationRequest>(
          `/api/generations/${encodeURIComponent(asset.requestId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!active || activeProjectIdRef.current !== workspaceId) return;
        setJob({ phase: current.status });
        const result = await pollGeneration(
          current,
          (phase) => {
            if (active && activeProjectIdRef.current === workspaceId) setJob({ phase });
          },
          request,
          controller.signal,
        );
        if (!active || activeProjectIdRef.current !== workspaceId) return;

        if (kind === "image") {
          const url = result.images?.[0]?.url;
          if (!url) throw new Error("Higgsfield completed without returning an image URL.");
          setImageUrl(url);
          setImageRequestId(result.request_id);
        } else {
          const url = result.video?.url;
          if (!url) throw new Error("Higgsfield completed without returning a video URL.");
          setVideoUrl(url);
          setVideoRequestId(result.request_id);
        }
        setJob({ phase: "completed" });
      } catch (error) {
        if (
          !active ||
          controller.signal.aborted ||
          activeProjectIdRef.current !== workspaceId
        ) return;
        setJob({
          phase: "error",
          message: error instanceof Error ? error.message : "Saved generation could not be restored.",
        });
      }
    };

    queueMicrotask(() => {
      if (!active || activeProjectIdRef.current !== workspaceId) return;

      setStep(snapshot.step);
      setImagePrompt(snapshot.imagePrompt);
      setMotionPrompt(snapshot.motionPrompt);
      setImageUrl(snapshot.image.url);
      setImageRequestId(snapshot.image.requestId);
      setVideoUrl(snapshot.video.url);
      setVideoRequestId(snapshot.video.requestId);
      setDuration(snapshot.duration);
      setResolution(snapshot.resolution);
      setCameraFixed(snapshot.cameraFixed);
      setTitle(snapshot.title);
      setMusicVolume(snapshot.musicVolume);
      setMusic(null);
      setMusicUrl("");
      setRenderJob({ phase: "idle" });
      setIsPlaying(false);
      setImageJob({
        phase: snapshot.image.url
          ? "completed"
          : snapshot.image.requestId
            ? "queued"
            : "idle",
      });
      setVideoJob({
        phase: snapshot.video.url
          ? "completed"
          : snapshot.video.requestId
            ? "queued"
            : "idle",
      });
      setHydratedProjectId(workspaceId);

      void Promise.all([
        restoreAsset("image", snapshot.image),
        restoreAsset("video", snapshot.video),
      ]);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [activeProjectId, request]);

  useEffect(() => {
    if (!activeProjectId || hydratedProjectId !== activeProjectId) return;

    const snapshot: StudioSnapshot = {
      version: 1,
      step,
      imagePrompt,
      motionPrompt,
      image: { requestId: imageRequestId, url: imageUrl },
      video: { requestId: videoRequestId, url: videoUrl },
      duration,
      resolution,
      cameraFixed,
      title,
      musicVolume,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSavedSnapshotRef.current) return;
    const revision = saveRevisionRef.current + 1;
    saveRevisionRef.current = revision;
    pendingSaveRef.current = { projectId: activeProjectId, revision, serialized, snapshot };
    projectsRef.current = projectsRef.current.map((project) =>
      project.id === activeProjectId ? { ...project, snapshot } : project,
    );
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    setSaveStatus("dirty");
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      void runQueuedSave().catch(() => undefined);
    }, 650);
  }, [
    activeProjectId,
    cameraFixed,
    duration,
    hydratedProjectId,
    imagePrompt,
    imageRequestId,
    imageUrl,
    motionPrompt,
    musicVolume,
    resolution,
    step,
    title,
    videoRequestId,
    videoUrl,
    runQueuedSave,
  ]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingSaveRef.current && !saveInFlightRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [step]);

  useEffect(() => {
    return () => {
      if (musicUrl.startsWith("blob:")) URL.revokeObjectURL(musicUrl);
    };
  }, [musicUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = musicVolume;
  }, [musicUrl, musicVolume]);

  const snapshotCurrentWorkspace = (): StudioSnapshot => ({
    version: 1,
    step,
    imagePrompt,
    motionPrompt,
    image: { requestId: imageRequestId, url: imageUrl },
    video: { requestId: videoRequestId, url: videoUrl },
    duration,
    resolution,
    cameraFixed,
    title,
    musicVolume,
  });

  const persistActiveProject = async () => {
    if (!activeProjectId || hydratedProjectId !== activeProjectId) return;
    const currentProject = projectsRef.current.find(
      (project) => project.id === activeProjectId,
    );
    if (!currentProject) return;

    const snapshot = snapshotCurrentWorkspace();
    const serialized = JSON.stringify(snapshot);
    if (serialized !== lastSavedSnapshotRef.current) {
      const revision = saveRevisionRef.current + 1;
      saveRevisionRef.current = revision;
      pendingSaveRef.current = {
        projectId: activeProjectId,
        revision,
        serialized,
        snapshot,
      };
      projectsRef.current = projectsRef.current.map((project) =>
        project.id === activeProjectId ? { ...project, snapshot } : project,
      );
    }
    await runQueuedSave();
  };

  const selectProject = async (projectId: string) => {
    if (
      projectId === activeProjectId ||
      projectActionBusy ||
      !projectsRef.current.some((project) => project.id === projectId)
    ) return;

    setProjectActionBusy(true);
    try {
      await persistActiveProject();
      activeProjectIdRef.current = projectId;
      setHydratedProjectId("");
      setActiveProjectId(projectId);
      router.push(`/projects/${projectId}`, { scroll: false });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The project could not be saved.");
    } finally {
      setProjectActionBusy(false);
    }
  };

  const createProject = async () => {
    if (projectActionBusy || projectsRef.current.length >= 50) {
      if (projectsRef.current.length >= 50) {
        window.alert("This account already has the maximum of 50 projects.");
      }
      return;
    }
    setProjectActionBusy(true);
    try {
      await persistActiveProject();
      const project = await request<StudioProject>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Project ${projectsRef.current.length + 1}` }),
      });
      const nextProjects = [...projectsRef.current, project];
      projectsRef.current = nextProjects;
      activeProjectIdRef.current = project.id;
      setProjects(nextProjects);
      setHydratedProjectId("");
      setActiveProjectId(project.id);
      router.push(`/projects/${project.id}`, { scroll: false });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "A new project could not be created.");
    } finally {
      setProjectActionBusy(false);
    }
  };

  const renameActiveProject = async () => {
    const project = projectsRef.current.find(({ id }) => id === activeProjectId);
    if (!project || projectActionBusy) return;
    const name = window.prompt("Project name", project.name);
    if (name === null || !name.trim()) return;

    setProjectActionBusy(true);
    try {
      await persistActiveProject();
      const updatedProject = await request<StudioProject>(
        `/api/projects/${encodeURIComponent(activeProjectId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      const nextProjects = projectsRef.current.map((candidate) =>
        candidate.id === activeProjectId ? updatedProject : candidate,
      );
      projectsRef.current = nextProjects;
      lastSavedSnapshotRef.current = JSON.stringify(updatedProject.snapshot);
      setProjects(nextProjects);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "This project could not be renamed.");
    } finally {
      setProjectActionBusy(false);
    }
  };

  const deleteActiveProject = async () => {
    const project = projectsRef.current.find(({ id }) => id === activeProjectId);
    if (!project || projectActionBusy) return;
    if (!window.confirm(`Delete “${project.name}” and all of its generated media? This cannot be undone.`)) {
      return;
    }

    setProjectActionBusy(true);
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    pendingSaveRef.current = null;
    try {
      await saveInFlightRef.current?.catch(() => undefined);
      pendingSaveRef.current = null;
      await request<{ deleted: boolean }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        { method: "DELETE" },
      );
      const nextProjects = projectsRef.current.filter(({ id }) => id !== project.id);
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      setHydratedProjectId("");
      if (nextProjects.length === 0) {
        activeProjectIdRef.current = "";
        setActiveProjectId("");
        router.replace("/");
        return;
      }
      const nextProjectId = nextProjects[0].id;
      activeProjectIdRef.current = nextProjectId;
      setActiveProjectId(nextProjectId);
      router.replace(`/projects/${nextProjectId}`, { scroll: false });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "This project could not be deleted.");
    } finally {
      setProjectActionBusy(false);
    }
  };

  const generateImage = async () => {
    if (imagePrompt.trim().length < 3) {
      setImageJob({ phase: "error", message: "Describe the image you want first." });
      return;
    }

    setImageUrl("");
    setImageRequestId("");
    setVideoUrl("");
    setVideoRequestId("");
    setVideoJob({ phase: "idle" });
    setImageJob({ phase: "submitting" });
    try {
      const initial = await request<GenerationRequest>("/api/generations/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId, prompt: imagePrompt }),
      });
      setImageRequestId(initial.request_id);
      setImageJob({ phase: initial.status });
      const result = await pollGeneration(
        initial,
        (phase) => setImageJob({ phase }),
        request,
      );
      const url = result.images?.[0]?.url;
      if (!url) throw new Error("Higgsfield completed without returning an image URL.");
      setImageUrl(url);
      setImageRequestId(result.request_id);
      setImageJob({ phase: "completed" });
    } catch (error) {
      setImageJob({
        phase: "error",
        message: error instanceof Error ? error.message : "Image generation failed.",
      });
    }
  };

  const generateVideo = async () => {
    if (!imageUrl || !imageRequestId) return;
    if (motionPrompt.trim().length < 3) {
      setVideoJob({ phase: "error", message: "Describe how the scene should move." });
      return;
    }

    setVideoUrl("");
    setVideoRequestId("");
    setVideoJob({ phase: "submitting" });
    try {
      const initial = await request<GenerationRequest>("/api/generations/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          prompt: motionPrompt,
          imageRequestId,
          duration,
          resolution,
          cameraFixed,
        }),
      });
      setVideoRequestId(initial.request_id);
      setVideoJob({ phase: initial.status });
      const result = await pollGeneration(
        initial,
        (phase) => setVideoJob({ phase }),
        request,
      );
      const url = result.video?.url;
      if (!url) throw new Error("Higgsfield completed without returning a video URL.");
      setVideoUrl(url);
      setVideoRequestId(result.request_id);
      setVideoJob({ phase: "completed" });
    } catch (error) {
      setVideoJob({
        phase: "error",
        message: error instanceof Error ? error.message : "Video generation failed.",
      });
    }
  };

  const loadSample = () => {
    setImagePrompt("A hopeful traveler at sunset, warm editorial photography");
    setMotionPrompt("A gentle cinematic push-in with a natural breeze");
    setImageUrl("/media/samples/demo-image.svg");
    setImageRequestId("");
    setVideoUrl("/media/samples/demo-video.mp4");
    setVideoRequestId("");
    setImageJob({ phase: "completed" });
    setVideoJob({ phase: "completed" });
    setTitle({ ...DEFAULT_TITLE, text: "Make one idea\nfeel alive" });
    setStep(3);
  };

  const selectMusic = (file: File | null) => {
    if (musicUrl.startsWith("blob:")) URL.revokeObjectURL(musicUrl);
    setMusic(file);
    setMusicUrl(file ? URL.createObjectURL(file) : "");
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;

    if (video.paused) {
      await video.play();
      if (audio) {
        audio.currentTime = video.currentTime;
        await audio.play().catch(() => undefined);
      }
    } else {
      video.pause();
      audio?.pause();
    }
  };

  const syncMusic = () => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const target = video.currentTime % audio.duration;
    if (Math.abs(audio.currentTime - target) > 0.45) audio.currentTime = target;
  };

  const startTitleDrag = (event: PointerEvent<HTMLDivElement>) => {
    const canvas = event.currentTarget.parentElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: title.x,
      startY: title.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTitle = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextX = drag.startX + (event.clientX - drag.startClientX) / drag.width;
    const nextY = drag.startY + (event.clientY - drag.startClientY) / drag.height;
    setTitle((current) => ({
      ...current,
      x: Math.min(0.82, Math.max(0.02, nextX)),
      y: Math.min(0.84, Math.max(0.13, nextY)),
    }));
  };

  const nudgeTitle = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? 0.02 : 0.005;
    const delta = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    setTitle((current) => ({
      ...current,
      x: Math.min(0.82, Math.max(0.02, current.x + delta[0])),
      y: Math.min(0.84, Math.max(0.13, current.y + delta[1])),
    }));
  };

  const renderVideo = async () => {
    if (!videoUrl) return;
    setRenderJob({ phase: "in_progress" });
    try {
      const form = new FormData();
      form.append("projectId", activeProjectId);
      form.append("videoUrl", videoUrl);
      form.append("title", title.text);
      form.append("titleX", String(title.x));
      form.append("titleY", String(title.y));
      form.append("fontSize", String(title.fontSize));
      form.append("musicVolume", String(musicVolume));
      if (music) form.append("music", music, music.name);

      const result = await request<RenderResponse>("/api/render", {
        method: "POST",
        body: form,
      });
      if (!result.url || !result.filename) {
        throw new Error("The backend did not return a saved render.");
      }
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.filename;
      link.click();
      setRenderJob({ phase: "completed" });
    } catch (error) {
      setRenderJob({
        phase: "error",
        message: error instanceof Error ? error.message : "Render failed.",
      });
    }
  };

  const imageBusy = ["submitting", "queued", "in_progress"].includes(imageJob.phase);
  const videoBusy = ["submitting", "queued", "in_progress"].includes(videoJob.phase);
  const renderBusy = renderJob.phase === "in_progress";
  const workspaceBusy =
    imageBusy ||
    videoBusy ||
    renderBusy ||
    projectActionBusy ||
    !activeProjectId ||
    hydratedProjectId !== activeProjectId;

  if (projectMissing) {
    return (
      <main className="missing-project">
        <span className="brand-mark"><Film size={19} /></span>
        <span className="dashboard-eyebrow">PROJECT NOT FOUND</span>
        <h1 className="sr-only">This project is unavailable.</h1>
        <p>It may have been deleted, or it may belong to another account.</p>
        <Link className="primary-button" href="/">
          <ArrowLeft size={17} /> Back to projects
        </Link>
      </main>
    );
  }

  if (projectLoadError) {
    return (
      <main className="missing-project">
        <span className="brand-mark"><Film size={19} /></span>
        <span className="dashboard-eyebrow">PROJECT UNAVAILABLE</span>
        <p>{projectLoadError}</p>
        <button className="primary-button" onClick={() => window.location.reload()} type="button">
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-start">
          <Link className="brand" href="/" aria-label="Project dashboard">
            <span className="brand-mark"><Film size={19} /></span>
            <span className="brand-name">OneTake</span>
          </Link>
          <span aria-hidden="true" className="header-divider" />
          <ProjectControls
            activeProjectId={activeProjectId}
            disabled={workspaceBusy}
            onCreate={createProject}
            onDelete={deleteActiveProject}
            onRename={renameActiveProject}
            onSelect={selectProject}
            projects={projects}
          />
        </div>
        <WorkflowNav
          step={step}
          imageReady={Boolean(imageUrl)}
          videoReady={Boolean(videoUrl)}
          onStep={setStep}
        />
        <div className="header-end">
          <button
            className={`save-status save-status-${saveStatus}`}
            disabled={saveStatus !== "error"}
            onClick={() => { void runQueuedSave().catch(() => undefined); }}
            title={saveStatus === "error" ? "Retry saving this project" : "Project save status"}
            type="button"
          >
            {saveStatus === "dirty" || saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "error"
                ? "Save failed · Retry"
                : saveStatus === "saved"
                  ? "Saved"
                  : ""}
          </button>
          <div
            className={`api-status ${
              health?.configured || health?.mockMode ? "is-connected" : ""
            }`}
            title="Higgsfield CLI connection"
          >
            <span className="status-light" />
            {health?.mockMode
              ? "Demo API"
              : health?.configured
                ? "Higgsfield CLI ready"
                : health && !health.storage.writable
                  ? "Storage unavailable"
                : health
                  ? "CLI login needed"
                  : "Checking CLI"}
          </div>
          <AccountMenu />
        </div>
      </header>

      <section className="studio" id="top">
        {step === 1 ? (
          <>
            <aside className="control-panel">
              <div className="panel-heading">
                <span className="eyebrow">01 · FIRST FRAME</span>
                <h1 className="sr-only">Turn an idea into an image.</h1>
                <p>
                  {health?.models.image ?? "GPT Image 2"} creates the square source
                  frame that anchors your video.
                </p>
              </div>

              <CredentialNotice health={health} />

              <label className="field-label" htmlFor="image-prompt">
                Image prompt
                <span>{imagePrompt.length}/4,000</span>
              </label>
              <div className="prompt-field">
                <textarea
                  id="image-prompt"
                  maxLength={4_000}
                  onChange={(event) => setImagePrompt(event.target.value)}
                  placeholder="Describe the subject, setting, light, mood, and camera style…"
                  rows={7}
                  value={imagePrompt}
                />
                <Sparkles aria-hidden="true" className="prompt-sparkle" size={17} />
              </div>

              <div className="idea-list" aria-label="Image prompt ideas">
                {IMAGE_IDEAS.map((idea) => (
                  <button key={idea} onClick={() => setImagePrompt(idea)} type="button">
                    {idea}
                  </button>
                ))}
              </div>

              <div className="setting-grid">
                <div className="setting-card">
                  <span>Model</span>
                  <strong>{health?.models.image ?? "GPT Image 2"}</strong>
                </div>
                <div className="setting-card">
                  <span>Format</span>
                  <strong>1:1 · PNG</strong>
                </div>
              </div>

              <JobMessage job={imageJob} />

              <div className="panel-actions">
                <button
                  className="primary-button"
                  disabled={imageBusy}
                  onClick={generateImage}
                  type="button"
                >
                  {imageBusy ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
                  {imageUrl ? "Generate another" : "Generate first frame"}
                </button>
                {imageUrl ? (
                  <button className="secondary-button" onClick={() => setStep(2)} type="button">
                    Use this image <ArrowRight size={17} />
                  </button>
                ) : null}
              </div>

              {!health?.configured && !health?.mockMode ? (
                <button className="sample-link" onClick={loadSample} type="button">
                  Or open a sample project <ArrowRight size={15} />
                </button>
              ) : null}
            </aside>

            <section className="preview-panel">
              <div className="preview-toolbar">
                <div>
                  <span className="toolbar-kicker">CANVAS</span>
                  <strong>Square first frame</strong>
                </div>
                <span className="dimension-pill">1080 × 1080</span>
              </div>
              <div className="image-stage">
                {imageUrl ? (
                  // Backend media URLs are dynamic, so a native image element is intentional here.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="Generated first frame" src={imageUrl} />
                ) : imageBusy ? (
                  <div className="generating-artwork">
                    <div className="generation-rings"><span /><span /><span /></div>
                    <strong>Creating your first frame</strong>
                    <p>
                      {health?.models.image ?? "GPT Image 2"} is translating your
                      direction into a finished still.
                    </p>
                  </div>
                ) : (
                  <EmptyArtwork kind="image" />
                )}
              </div>
              <div className="preview-footnote">
                <LockKeyhole size={14} /> This image is only sent to Seedance after you approve it.
              </div>
            </section>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <aside className="control-panel">
              <button className="back-button" onClick={() => setStep(1)} type="button">
                <ArrowLeft size={15} /> Back to still
              </button>
              <div className="panel-heading compact-heading">
                <span className="eyebrow">02 · MOTION</span>
                <h1 className="sr-only">Bring the frame to life.</h1>
                <p>
                  {health?.models.video ?? "Seedance 2.0"} keeps your approved image
                  as frame one, then adds motion.
                </p>
              </div>

              <div className="first-frame-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="Locked first frame" src={imageUrl} />
                <div>
                  <span><LockKeyhole size={12} /> FIRST FRAME</span>
                  <strong>Locked and ready</strong>
                </div>
                <Check size={17} />
              </div>

              <label className="field-label" htmlFor="motion-prompt">
                Motion prompt
                <span>{motionPrompt.length}/4,000</span>
              </label>
              <div className="prompt-field">
                <textarea
                  id="motion-prompt"
                  maxLength={4_000}
                  onChange={(event) => setMotionPrompt(event.target.value)}
                  placeholder="Describe camera movement, subject motion, and pacing…"
                  rows={6}
                  value={motionPrompt}
                />
                <Film aria-hidden="true" className="prompt-sparkle" size={17} />
              </div>

              <div className="idea-list compact-ideas" aria-label="Motion prompt ideas">
                {MOTION_IDEAS.map((idea) => (
                  <button key={idea} onClick={() => setMotionPrompt(idea)} type="button">
                    {idea}
                  </button>
                ))}
              </div>

              <div className="settings-section">
                <div className="inline-setting">
                  <span>Duration</span>
                  <div className="segment-control">
                    {([5, 8, 10] as const).map((value) => (
                      <button
                        className={duration === value ? "is-selected" : ""}
                        key={value}
                        onClick={() => setDuration(value)}
                        type="button"
                      >
                        {value}s
                      </button>
                    ))}
                  </div>
                </div>
                <div className="inline-setting">
                  <span>Resolution</span>
                  <div className="segment-control">
                    {(["720", "1080"] as const).map((value) => (
                      <button
                        className={resolution === value ? "is-selected" : ""}
                        key={value}
                        onClick={() => setResolution(value)}
                        type="button"
                      >
                        {value}p
                      </button>
                    ))}
                  </div>
                </div>
                <label className="toggle-row">
                  <span>
                    <strong>Fixed camera</strong>
                    <small>Keep framing stable while subjects move</small>
                  </span>
                  <input
                    checked={cameraFixed}
                    onChange={(event) => setCameraFixed(event.target.checked)}
                    type="checkbox"
                  />
                  <i aria-hidden="true" />
                </label>
              </div>

              <JobMessage job={videoJob} />
              <div className="panel-actions">
                <button
                  className="primary-button"
                  disabled={videoBusy}
                  onClick={generateVideo}
                  type="button"
                >
                  {videoBusy ? <LoaderCircle className="spin" size={18} /> : <Film size={18} />}
                  {videoUrl ? "Generate another" : "Generate video"}
                </button>
                {videoUrl ? (
                  <button className="secondary-button" onClick={() => setStep(3)} type="button">
                    Open composer <ArrowRight size={17} />
                  </button>
                ) : null}
              </div>
            </aside>

            <section className="preview-panel">
              <div className="preview-toolbar">
                <div>
                  <span className="toolbar-kicker">PREVIEW</span>
                  <strong>{health?.models.video ?? "Seedance 2.0"} motion</strong>
                </div>
                <span className="dimension-pill">{duration}s · {resolution}p · 1:1</span>
              </div>
              <div className="image-stage video-stage-square">
                {videoUrl ? (
                  <video autoPlay controls loop playsInline poster={imageUrl} src={videoUrl} />
                ) : videoBusy ? (
                  <div className="motion-generating">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="First frame being animated" src={imageUrl} />
                    <div className="motion-wash" />
                    <div className="motion-status">
                      <LoaderCircle className="spin" size={20} />
                      <span>Animating your frame</span>
                    </div>
                  </div>
                ) : (
                  <div className="still-awaiting-motion">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="First frame awaiting motion" src={imageUrl} />
                    <div className="play-ghost"><Play fill="currentColor" size={24} /></div>
                  </div>
                )}
              </div>
              <div className="preview-footnote">
                <LockKeyhole size={14} /> Model: {health?.models.video ?? "Seedance 2.0"}
              </div>
            </section>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <aside className="control-panel composer-controls">
              <button className="back-button" onClick={() => setStep(2)} type="button">
                <ArrowLeft size={15} /> Back to motion
              </button>
              <div className="panel-heading compact-heading">
                <span className="eyebrow">03 · COMPOSE</span>
                <h1 className="sr-only">Make it unmistakably yours.</h1>
                <p>Add the branded frame, position your title, mix music, and export.</p>
              </div>

              <section className="control-section">
                <div className="section-title"><Type size={16} /><strong>Title</strong></div>
                <label className="field-label" htmlFor="title-text">
                  Copy <span>{title.text.length}/180</span>
                </label>
                <textarea
                  className="small-textarea"
                  id="title-text"
                  maxLength={180}
                  onChange={(event) =>
                    setTitle((current) => ({ ...current, text: event.target.value }))
                  }
                  rows={3}
                  value={title.text}
                />
                <div className="slider-row">
                  <label htmlFor="font-size">Size</label>
                  <input
                    id="font-size"
                    max="132"
                    min="48"
                    onChange={(event) =>
                      setTitle((current) => ({
                        ...current,
                        fontSize: Number(event.target.value),
                      }))
                    }
                    type="range"
                    value={title.fontSize}
                  />
                  <output>{title.fontSize}px</output>
                </div>
                <button
                  className="text-button"
                  onClick={() => setTitle((current) => ({ ...DEFAULT_TITLE, text: current.text }))}
                  type="button"
                >
                  <RotateCcw size={14} /> Reset title position
                </button>
              </section>

              <section className="control-section">
                <div className="section-title"><Music2 size={16} /><strong>Background music</strong></div>
                {!music ? (
                  <label className="upload-zone" htmlFor="music-upload">
                    <span><Upload size={18} /></span>
                    <strong>Choose an audio file</strong>
                    <small>MP3, WAV, M4A · up to 40 MB</small>
                  </label>
                ) : (
                  <div className="audio-file">
                    <span><Music2 size={18} /></span>
                    <div><strong>{music.name}</strong><small>{(music.size / 1024 / 1024).toFixed(1)} MB</small></div>
                    <button aria-label="Remove music" onClick={() => selectMusic(null)} type="button"><X size={16} /></button>
                  </div>
                )}
                <input
                  accept="audio/*,.mp3,.wav,.m4a,.aac"
                  className="sr-only"
                  id="music-upload"
                  onChange={(event) => selectMusic(event.target.files?.[0] ?? null)}
                  type="file"
                />
                {music ? (
                  <div className="slider-row volume-row">
                    <Volume2 size={15} />
                    <input
                      aria-label="Music volume"
                      max="1"
                      min="0"
                      onChange={(event) => setMusicVolume(Number(event.target.value))}
                      step="0.01"
                      type="range"
                      value={musicVolume}
                    />
                    <output>{Math.round(musicVolume * 100)}%</output>
                  </div>
                ) : null}
              </section>

              <section className="template-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="GoStudy frame reference" src="/reference/gostudy-reference.png" />
                <div>
                  <span>TEMPLATE</span>
                  <strong>GoStudy Orange</strong>
                  <a href="/reference/gostudy-reference.png" rel="noreferrer" target="_blank">
                    View reference <ExternalLink size={11} />
                  </a>
                </div>
                <Check size={16} />
              </section>

              <JobMessage job={renderJob} />
              <button
                className="primary-button export-button"
                disabled={renderBusy}
                onClick={renderVideo}
                type="button"
              >
                {renderBusy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
                {renderBusy ? "Rendering MP4…" : "Render & download MP4"}
              </button>
            </aside>

            <section className="preview-panel composer-panel">
              <div className="preview-toolbar">
                <div>
                  <span className="toolbar-kicker">FINAL CANVAS</span>
                  <strong>Drag the title to position it</strong>
                </div>
                <div className="toolbar-actions">
                  <span className="dimension-pill">1080 × 1350</span>
                  <button onClick={togglePlayback} type="button">
                    {isPlaying ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
                    {isPlaying ? "Pause" : "Preview"}
                  </button>
                </div>
              </div>

              <div className="final-stage-wrap">
                <div className="final-canvas">
                  <video
                    loop
                    muted={Boolean(music)}
                    onPause={() => setIsPlaying(false)}
                    onPlay={() => setIsPlaying(true)}
                    onTimeUpdate={syncMusic}
                    playsInline
                    poster={imageUrl}
                    ref={videoRef}
                    src={videoUrl}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt="" aria-hidden="true" className="frame-overlay" src="/frame-overlay.svg" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt="GoStudy.hk"
                    className="canvas-brand-logo"
                    src="/gostudy-logo.svg"
                    style={{
                      left: `${(BRAND_LOGO_RECT.x / OUTPUT_SIZE.width) * 100}%`,
                      top: `${(BRAND_LOGO_RECT.y / OUTPUT_SIZE.height) * 100}%`,
                      width: `${(BRAND_LOGO_RECT.width / OUTPUT_SIZE.width) * 100}%`,
                      height: `${(BRAND_LOGO_RECT.height / OUTPUT_SIZE.height) * 100}%`,
                    }}
                  />
                  <div
                    aria-label="Draggable video title. Use arrow keys to move."
                    className="draggable-title"
                    onKeyDown={nudgeTitle}
                    onPointerCancel={() => { dragRef.current = null; }}
                    onPointerDown={startTitleDrag}
                    onPointerMove={moveTitle}
                    onPointerUp={() => { dragRef.current = null; }}
                    role="button"
                    style={
                      {
                        left: `${title.x * 100}%`,
                        top: `${title.y * 100}%`,
                        maxWidth: `${Math.max(12, (0.95 - title.x) * 100)}%`,
                        fontSize: `${title.fontSize / 10.8}cqw`,
                      } as CSSProperties
                    }
                    tabIndex={0}
                  >
                    {title.text || "Add a title"}
                    <span className="drag-handle"><Move size={11} /></span>
                  </div>
                  <button
                    aria-label={isPlaying ? "Pause video preview" : "Play video preview"}
                    className={`canvas-play ${isPlaying ? "is-playing" : ""}`}
                    onClick={togglePlayback}
                    type="button"
                  >
                    {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
                  </button>
                </div>
                <div className="canvas-caption">
                  <span><Move size={14} /> Drag or use arrow keys to move the title</span>
                  <span>4:5 social · H.264 MP4</span>
                </div>
              </div>
              {musicUrl ? (
                <audio loop ref={audioRef} src={musicUrl} />
              ) : null}
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
