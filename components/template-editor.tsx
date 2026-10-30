"use client";

import {
  ArrowLeft,
  Film,
  LayoutTemplate,
  LoaderCircle,
  Save,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountMenu } from "@/components/account-menu";
import { useAuth } from "@/components/auth-provider";
import { CompositionEditor } from "@/components/composition-editor";
import {
  clampNumber,
  createBackgroundLayer,
  createDefaultLogoLayer,
  createTextLayer,
  FONT_FAMILIES,
  imageLayerHeight,
  MAX_COMPOSITION_LAYERS,
  maximumImageLayerWidth,
  minimumImageLayerWidth,
  OUTPUT_SIZE,
  positionLayer,
  wrappedTextLines,
  type CompositionLayer,
  type ImageLayer,
} from "@/lib/composition";
import {
  parseCompositionTemplateAssetUpload,
  parseCompositionTemplateDetail,
  type CompositionTemplateDetail,
} from "@/lib/composition-templates";

function actionMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function fileLayerName(file: File, fallback: string) {
  return file.name.replace(/\.[^.]+$/, "").trim().slice(0, 40) || fallback;
}

function TemplateCanvas({
  layers,
  selectedLayerId,
  onSelectLayer,
}: {
  layers: readonly CompositionLayer[];
  selectedLayerId: string;
  onSelectLayer: (layerId: string) => void;
}) {
  const background = layers.find(
    (layer): layer is ImageLayer => layer.type === "image" && layer.role === "background",
  );

  return (
    <div className="final-canvas template-preview-canvas" aria-label="Template preview">
      {background ? (
        // Template images are authenticated dynamic media.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className="final-background"
          draggable={false}
          src={background.src}
          style={{
            left: `${background.x * 100}%`,
            top: `${background.y * 100}%`,
            width: `${background.width * 100}%`,
            height: `${imageLayerHeight(background) * 100}%`,
          }}
        />
      ) : null}
      <div aria-hidden="true" className="template-preview-video-placeholder">
        <Film aria-hidden="true" size={30} />
        <span>Project video area</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden="true"
        className="frame-overlay"
        src={background ? "/frame-overlay-transparent.svg" : "/frame-overlay.svg"}
      />
      {layers.map((layer, index) => {
        if (layer.type === "image" && layer.role === "background") return null;
        const selected = selectedLayerId === layer.id;

        if (layer.type === "image") {
          return (
            <button
              aria-label={`Select ${layer.name}`}
              aria-pressed={selected}
              className={`canvas-layer canvas-image-layer template-preview-layer ${selected ? "is-selected" : ""}`}
              key={layer.id}
              onClick={() => onSelectLayer(layer.id)}
              style={{
                left: `${layer.x * 100}%`,
                top: `${layer.y * 100}%`,
                width: `${layer.width * 100}%`,
                height: `${imageLayerHeight(layer) * 100}%`,
                zIndex: index + 3,
              }}
              type="button"
            >
              {/* Template images are authenticated dynamic media. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                aria-hidden="true"
                className={layer.mask === "circle" ? "is-circle" : ""}
                draggable={false}
                src={layer.src}
              />
            </button>
          );
        }

        const lines = wrappedTextLines(layer);
        const width = Math.round(clampNumber(layer.width, 0.12, 0.96) * OUTPUT_SIZE.width);
        const fontSize = Math.round(clampNumber(layer.fontSize, 18, 180));
        const lineHeight = Math.round(fontSize * 1.08);
        const height = Math.max(lineHeight, lines.length * lineHeight);
        const textX = layer.textAlign === "center" ? width / 2 : layer.textAlign === "right" ? width : 0;
        const anchor = layer.textAlign === "center" ? "middle" : layer.textAlign === "right" ? "end" : "start";
        return (
          <button
            aria-label={`Select ${layer.name}`}
            aria-pressed={selected}
            className={`canvas-layer canvas-text-layer template-preview-layer ${selected ? "is-selected" : ""}`}
            key={layer.id}
            onClick={() => onSelectLayer(layer.id)}
            style={{
              left: `${layer.x * 100}%`,
              top: `${layer.y * 100}%`,
              width: `${layer.width * 100}%`,
              height: `${height / OUTPUT_SIZE.height * 100}%`,
              zIndex: index + 3,
            }}
            type="button"
          >
            <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`}>
              <text
                dominantBaseline="hanging"
                fill={layer.color}
                fontFamily={FONT_FAMILIES[layer.fontFamily]}
                fontSize={fontSize}
                fontWeight={layer.fontWeight}
                paintOrder="stroke fill"
                stroke={layer.strokeColor}
                strokeLinejoin="round"
                strokeWidth={Math.round(layer.strokeWidth)}
                textAnchor={anchor}
                x={textX}
                y="0"
              >
                {lines.map((line, lineIndex) => (
                  <tspan
                    dy={lineIndex === 0 ? 0 : lineHeight}
                    key={`${layer.id}-${lineIndex}`}
                    x={textX}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </svg>
          </button>
        );
      })}
    </div>
  );
}

export function TemplateEditor({ templateId }: { templateId: string }) {
  const router = useRouter();
  const { request } = useAuth();
  const [template, setTemplate] = useState<CompositionTemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [layers, setLayers] = useState<CompositionLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"saving" | "deleting" | "discarding" | "uploading" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const uploadedAssetIds = useRef(new Set<string>());
  const suppressNextPopRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void request<unknown>(`/api/composition-templates/${encodeURIComponent(templateId)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then((response) => {
      const parsed = parseCompositionTemplateDetail(response);
      if (!parsed || parsed.id !== templateId) {
        throw new Error("The server returned an invalid template.");
      }
      setTemplate(parsed);
      setName(parsed.name);
      setLayers(parsed.layers);
      setSelectedLayerId(
        parsed.layers.findLast((layer) => layer.type === "text")?.id
          ?? parsed.layers.findLast((layer) => layer.type !== "image" || layer.role !== "background")?.id
          ?? parsed.layers[0]?.id
          ?? "",
      );
      setLoading(false);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(actionMessage(cause, "The template could not be loaded."));
      setLoading(false);
    });
    return () => controller.abort();
  }, [reloadVersion, request, templateId]);

  const dirty = useMemo(() => {
    if (!template) return false;
    return name !== template.name || JSON.stringify(layers) !== JSON.stringify(template.layers);
  }, [layers, name, template]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty || busy === "saving") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, dirty]);

  const normalizeLayer = (layer: CompositionLayer): CompositionLayer => {
    if (layer.type === "text") {
      const normalized = {
        ...layer,
        width: clampNumber(layer.width, 0.12, 0.96),
        fontSize: clampNumber(layer.fontSize, 18, 180),
        strokeWidth: clampNumber(layer.strokeWidth, 0, 20),
      };
      return positionLayer(normalized, normalized.x, normalized.y);
    }
    const normalized = {
      ...layer,
      width: clampNumber(
        layer.width,
        minimumImageLayerWidth(layer),
        maximumImageLayerWidth(layer),
      ),
    };
    return positionLayer(normalized, normalized.x, normalized.y);
  };

  const updateLayer = (nextLayer: CompositionLayer) => {
    setLayers((current) => current.map((layer) =>
      layer.id === nextLayer.id ? normalizeLayer(nextLayer) : layer,
    ));
    setNotice("");
  };

  const addText = () => {
    if (layers.length >= MAX_COMPOSITION_LAYERS) return;
    const index = layers.filter(({ type }) => type === "text").length + 1;
    const offset = Math.min(0.18, index * 0.025);
    const layer = positionLayer(
      { ...createTextLayer(`text-${crypto.randomUUID()}`, index), x: 0.08 + offset, y: 0.2 + offset },
      0.08 + offset,
      0.2 + offset,
    );
    setLayers((current) => [...current, layer]);
    setSelectedLayerId(layer.id);
    setNotice("");
  };

  const uploadAsset = async (file: File) => {
    setBusy("uploading");
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      const response = await request<unknown>(
        `/api/composition-templates/${encodeURIComponent(templateId)}/assets`,
        { method: "POST", body: form },
      );
      const uploaded = parseCompositionTemplateAssetUpload(response, templateId);
      if (!uploaded) throw new Error("The server returned an invalid uploaded image.");
      uploadedAssetIds.current.add(uploaded.assetId);
      return uploaded;
    } finally {
      setBusy("");
    }
  };

  const uploadBackground = async (file: File) => {
    const uploaded = await uploadAsset(file);
    const background = createBackgroundLayer(
      uploaded.url,
      uploaded.width / uploaded.height,
      fileLayerName(file, "Background photo"),
    );
    setLayers((current) => [
      background,
      ...current.filter((layer) => layer.type !== "image" || layer.role !== "background"),
    ]);
    setSelectedLayerId(background.id);
  };

  const uploadLogo = async (file: File) => {
    const uploaded = await uploadAsset(file);
    const aspectRatio = uploaded.width / uploaded.height;
    const width = Math.min(
      maximumImageLayerWidth({ aspectRatio, mask: "none", role: "logo" }),
      clampNumber(aspectRatio * 0.09, 0.08, 0.36),
    );
    const logo = positionLayer<ImageLayer>({
      ...createDefaultLogoLayer(),
      src: uploaded.url,
      width,
      aspectRatio,
    }, 0.5 - width / 2, 0.02);
    setLayers((current) => current.map((layer) =>
      layer.type === "image" && layer.role === "logo" ? logo : layer,
    ));
    setSelectedLayerId(logo.id);
  };

  const uploadImage = async (file: File) => {
    if (layers.length >= MAX_COMPOSITION_LAYERS) return;
    const uploaded = await uploadAsset(file);
    const aspectRatio = uploaded.width / uploaded.height;
    const width = Math.min(
      maximumImageLayerWidth({ aspectRatio, mask: "none", role: "overlay" }),
      Math.min(0.32, Math.max(0.1, aspectRatio * 0.25)),
    );
    const layer = positionLayer<ImageLayer>({
      id: `image-${crypto.randomUUID()}`,
      type: "image",
      role: "overlay",
      name: fileLayerName(file, "Image"),
      src: uploaded.url,
      x: 0.5 - width / 2,
      y: 0.34,
      width,
      aspectRatio,
      mask: "none",
    }, 0.5 - width / 2, 0.34);
    setLayers((current) => [...current, layer]);
    setSelectedLayerId(layer.id);
  };

  const restoreLogo = () => {
    const logo = createDefaultLogoLayer();
    setLayers((current) => current.map((layer) =>
      layer.type === "image" && layer.role === "logo" ? logo : layer,
    ));
    setSelectedLayerId(logo.id);
    setNotice("");
  };

  const removeBackground = () => {
    const backgroundId = layers.find(
      (layer) => layer.type === "image" && layer.role === "background",
    )?.id;
    setLayers((current) => current.filter(
      (layer) => layer.type !== "image" || layer.role !== "background",
    ));
    setSelectedLayerId((current) => current === backgroundId ? "brand-logo" : current);
    setNotice("");
  };

  const retry = () => {
    setTemplate(null);
    setLoading(true);
    setError("");
    setNotice("");
    setReloadVersion((value) => value + 1);
  };

  const deleteUploadedAssets = useCallback(async (assetIds: readonly string[]) => {
    const failed = new Set<string>();
    await Promise.all(assetIds.map(async (assetId) => {
      try {
        await request(
          `/api/composition-templates/${encodeURIComponent(templateId)}/assets/${encodeURIComponent(assetId)}`,
          { method: "DELETE" },
        );
      } catch {
        failed.add(assetId);
      }
    }));
    return failed;
  }, [request, templateId]);

  useEffect(() => {
    const guardBrowserBack = () => {
      if (suppressNextPopRef.current) {
        suppressNextPopRef.current = false;
        return;
      }
      if (!dirty || busy === "saving") return;
      if (!window.confirm("Discard your unsaved template changes?")) {
        suppressNextPopRef.current = true;
        window.history.forward();
        return;
      }
      const uploaded = [...uploadedAssetIds.current];
      uploadedAssetIds.current.clear();
      void deleteUploadedAssets(uploaded);
    };
    window.addEventListener("popstate", guardBrowserBack);
    return () => window.removeEventListener("popstate", guardBrowserBack);
  }, [busy, deleteUploadedAssets, dirty]);

  const deleteLayer = (layerId: string) => {
    const layer = layers.find(({ id }) => id === layerId);
    if (!layer || (layer.type === "image" && layer.role !== "overlay")) return;
    const next = layers.filter(({ id }) => id !== layerId);
    setLayers(next);
    setSelectedLayerId(next.findLast(
      (candidate) => candidate.type !== "image" || candidate.role !== "background",
    )?.id ?? "");
    setNotice("");
  };

  const save = async () => {
    const normalizedName = name.trim().replace(/\s+/g, " ");
    if (!template || !dirty || !normalizedName || busy) return;
    setBusy("saving");
    setError("");
    setNotice("");
    try {
      const response = await request<unknown>(
        `/api/composition-templates/${encodeURIComponent(template.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: normalizedName,
            layers,
            expectedTemplateUpdatedAt: template.updatedAt,
          }),
        },
      );
      const saved = parseCompositionTemplateDetail(response);
      if (!saved || saved.id !== template.id) {
        throw new Error("The server returned an invalid saved template.");
      }
      setTemplate(saved);
      setName(saved.name);
      setLayers(saved.layers);
      // The backend commits referenced assets and prunes every unreferenced asset
      // after a successful template update.
      uploadedAssetIds.current.clear();
      setNotice("Template saved.");
    } catch (cause) {
      setError(actionMessage(cause, "The template could not be saved."));
    } finally {
      setBusy("");
    }
  };

  const removeTemplate = async () => {
    if (!template || busy || !window.confirm(`Delete “${template.name}”? This cannot be undone.`)) return;
    setBusy("deleting");
    setError("");
    try {
      await request(`/api/composition-templates/${encodeURIComponent(template.id)}`, {
        method: "DELETE",
      });
      uploadedAssetIds.current.clear();
      router.push("/templates");
    } catch (cause) {
      setError(actionMessage(cause, "The template could not be deleted."));
      setBusy("");
    }
  };

  const goBack = async (destination = "/templates") => {
    if (dirty && !window.confirm("Discard your unsaved template changes?")) return;
    setBusy("discarding");
    await deleteUploadedAssets([...uploadedAssetIds.current]);
    uploadedAssetIds.current.clear();
    router.push(destination);
  };

  if (loading) {
    return (
      <main className="missing-project template-editor-state" aria-busy="true">
        <LoaderCircle className="spin" size={24} />
        <p>Loading template…</p>
      </main>
    );
  }

  if (!template) {
    return (
      <main className="missing-project template-editor-state">
        <LayoutTemplate size={24} />
        <h1>Template unavailable</h1>
        <p>{error || "This template may have been deleted."}</p>
        <button className="primary-button" onClick={retry} type="button">
          Try again
        </button>
        <Link className="secondary-button" href="/templates">Back to templates</Link>
      </main>
    );
  }

  const editingDisabled = Boolean(busy);

  return (
    <main className="app-shell template-editor-shell">
      <header className="app-header template-editor-header">
        <div className="header-start">
          <button
            aria-label="Project dashboard"
            className="brand"
            disabled={editingDisabled}
            onClick={() => void goBack("/")}
            type="button"
          >
            <span className="brand-mark"><Film size={19} /></span>
            <span className="brand-name">OneTake</span>
          </button>
          <span aria-hidden="true" className="header-divider" />
          <button className="back-button" disabled={editingDisabled} onClick={() => void goBack()} type="button">
            <ArrowLeft size={15} /> Templates
          </button>
        </div>
        <div className="template-editor-title">
          <LayoutTemplate aria-hidden="true" size={15} /> Editing template
        </div>
        <div className="header-end">
          <button
            className="secondary-button template-delete-action"
            disabled={editingDisabled}
            onClick={() => void removeTemplate()}
            type="button"
          >
            {busy === "deleting" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
            Delete
          </button>
          <button
            className="primary-button template-save-action"
            disabled={editingDisabled || !dirty || !name.trim()}
            onClick={() => void save()}
            type="button"
          >
            {busy === "saving" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
            {busy === "saving" ? "Saving…" : "Save template"}
          </button>
          <AccountMenu />
        </div>
      </header>

      <section className="studio template-editor-workspace">
        <aside className="control-panel composer-controls template-editor-controls">
          <div className="panel-heading compact-heading">
            <span className="eyebrow">TEMPLATE SETTINGS</span>
            <label className="field-label" htmlFor="template-name">Template name</label>
            <input
              className="template-name-input"
              disabled={editingDisabled}
              id="template-name"
              maxLength={80}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setNotice("");
              }}
              value={name}
            />
          </div>

          {error ? <p className="field-error template-editor-feedback" role="alert">{error}</p> : null}
          {notice ? <p className="template-editor-feedback is-success" role="status">{notice}</p> : null}

          <CompositionEditor
            disabled={editingDisabled}
            layers={layers}
            onAddText={addText}
            onChangeLayer={updateLayer}
            onDeleteLayer={deleteLayer}
            onRemoveBackground={removeBackground}
            onReorderLayers={(next) => {
              setLayers([...next]);
              setNotice("");
            }}
            onRestoreLogo={restoreLogo}
            onSelectLayer={setSelectedLayerId}
            onUploadBackground={uploadBackground}
            onUploadImage={uploadImage}
            onUploadLogo={uploadLogo}
            selectedLayerId={selectedLayerId}
          />
        </aside>

        <section className="preview-panel composer-panel template-editor-preview">
          <div className="preview-toolbar">
            <div>
              <span className="toolbar-kicker">TEMPLATE CANVAS</span>
              <strong>Select a layer, then adjust it in the inspector</strong>
            </div>
            <span className="dimension-pill">1080 × 1350</span>
          </div>
          <div className="final-stage-wrap">
            <TemplateCanvas
              layers={layers}
              onSelectLayer={setSelectedLayerId}
              selectedLayerId={selectedLayerId}
            />
          </div>
        </section>
      </section>
    </main>
  );
}
