"use client";

import {
  Check,
  Layers3,
  LayoutTemplate,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { CompositionTemplateSummary } from "@/lib/composition-templates";

export type CompositionTemplateAction = {
  kind: "loading" | "saving" | "applying" | "renaming" | "deleting";
  templateId?: string;
} | null;

type CompositionTemplateLibraryProps = {
  action: CompositionTemplateAction;
  disabled?: boolean;
  error?: string;
  notice?: string;
  templates: readonly CompositionTemplateSummary[];
  onApply: (template: CompositionTemplateSummary) => Promise<boolean>;
  onDelete: (template: CompositionTemplateSummary) => Promise<boolean>;
  onRename: (template: CompositionTemplateSummary, name: string) => Promise<boolean>;
  onSave: (name: string) => Promise<boolean>;
};

function templateDetails(template: CompositionTemplateSummary) {
  const text = `${template.textLayerCount} text`;
  const images = `${template.imageLayerCount} image${template.imageLayerCount === 1 ? "" : "s"}`;
  return `${text} · ${images} · ${template.layerCount} layers`;
}

export function CompositionTemplateLibrary({
  action,
  disabled = false,
  error = "",
  notice = "",
  templates,
  onApply,
  onDelete,
  onRename,
  onSave,
}: CompositionTemplateLibraryProps) {
  const fieldId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const busy = action !== null;

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  const submitTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || busy || disabled) return;
    if (await onSave(normalized)) {
      setName("");
      setCreating(false);
    }
  };

  const submitRename = async (
    event: FormEvent<HTMLFormElement>,
    template: CompositionTemplateSummary,
  ) => {
    event.preventDefault();
    const normalized = renameValue.trim();
    if (!normalized || busy || disabled) return;
    if (await onRename(template, normalized)) {
      setRenamingId("");
      setRenameValue("");
    }
  };

  const apply = async (template: CompositionTemplateSummary) => {
    if (
      busy ||
      disabled ||
      !window.confirm(
        `Apply “${template.name}”? This replaces the current text and image layers. Your video and music stay unchanged.`,
      )
    ) return;
    await onApply(template);
  };

  const remove = async (template: CompositionTemplateSummary) => {
    if (
      busy ||
      disabled ||
      !window.confirm(
        `Delete “${template.name}”? Projects that already use it will not be changed.`,
      )
    ) return;
    await onDelete(template);
  };

  return (
    <section
      aria-busy={busy}
      aria-labelledby={`${fieldId}-title`}
      className="control-section composition-template-library"
    >
      <div className="template-library-heading">
        <div className="section-title">
          <LayoutTemplate aria-hidden="true" size={16} />
          <strong id={`${fieldId}-title`}>Frame templates</strong>
        </div>
        {!creating ? (
          <button
            className="template-save-trigger"
            disabled={disabled || busy}
            onClick={() => {
              setName("");
              setCreating(true);
              setRenamingId("");
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={13} /> Save current
          </button>
        ) : null}
      </div>
      <p className="template-library-help">
        Reuse this text, artwork, and layer arrangement in another project. Video and audio stay project-specific.
      </p>

      {creating ? (
        <form className="template-name-form" onSubmit={submitTemplate}>
          <label htmlFor={`${fieldId}-new-name`}>Template name</label>
          <div>
            <input
              disabled={busy || disabled}
              id={`${fieldId}-new-name`}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Weekly course update"
              ref={nameInputRef}
              required
              value={name}
            />
            <button
              aria-label="Cancel saving template"
              disabled={busy}
              onClick={() => setCreating(false)}
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
            <button disabled={!name.trim() || busy || disabled} type="submit">
              {action?.kind === "saving"
                ? <LoaderCircle aria-hidden="true" className="spin" size={14} />
                : <Save aria-hidden="true" size={14} />}
              Save
            </button>
          </div>
        </form>
      ) : null}

      {action?.kind === "loading" ? (
        <div className="template-library-state">
          <LoaderCircle aria-hidden="true" className="spin" size={15} /> Loading templates…
        </div>
      ) : templates.length === 0 ? (
        <div className="template-library-empty">
          <Layers3 aria-hidden="true" size={17} />
          <span><strong>No saved templates yet</strong><small>Finish your layout, then save it here.</small></span>
        </div>
      ) : (
        <ul className="template-list">
          {templates.map((template) => {
            const active = action?.templateId === template.id;
            const renaming = renamingId === template.id;
            return (
              <li className={active ? "is-busy" : ""} key={template.id}>
                {renaming ? (
                  <form className="template-rename-form" onSubmit={(event) => void submitRename(event, template)}>
                    <label className="sr-only" htmlFor={`${fieldId}-rename-${template.id}`}>
                      Rename {template.name}
                    </label>
                    <input
                      autoFocus
                      disabled={busy || disabled}
                      id={`${fieldId}-rename-${template.id}`}
                      maxLength={80}
                      onChange={(event) => setRenameValue(event.currentTarget.value)}
                      required
                      value={renameValue}
                    />
                    <button aria-label="Cancel rename" disabled={busy} onClick={() => setRenamingId("")} type="button">
                      <X aria-hidden="true" size={13} />
                    </button>
                    <button aria-label="Save template name" disabled={!renameValue.trim() || busy || disabled} type="submit">
                      {active && action?.kind === "renaming"
                        ? <LoaderCircle aria-hidden="true" className="spin" size={13} />
                        : <Check aria-hidden="true" size={13} />}
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="template-list-icon"><LayoutTemplate aria-hidden="true" size={15} /></span>
                    <span className="template-list-copy">
                      <strong>{template.name}</strong>
                      <small>{templateDetails(template)}</small>
                    </span>
                    <span className="template-list-actions">
                      <button
                        className="template-apply-button"
                        disabled={busy || disabled}
                        onClick={() => void apply(template)}
                        type="button"
                      >
                        {active && action?.kind === "applying"
                          ? <LoaderCircle aria-hidden="true" className="spin" size={13} />
                          : null}
                        Apply
                      </button>
                      <button
                        aria-label={`Rename ${template.name}`}
                        disabled={busy || disabled}
                        onClick={() => {
                          setRenamingId(template.id);
                          setRenameValue(template.name);
                          setCreating(false);
                        }}
                        title="Rename template"
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={13} />
                      </button>
                      <button
                        aria-label={`Delete ${template.name}`}
                        className="template-delete-button"
                        disabled={busy || disabled}
                        onClick={() => void remove(template)}
                        title="Delete template"
                        type="button"
                      >
                        {active && action?.kind === "deleting"
                          ? <LoaderCircle aria-hidden="true" className="spin" size={13} />
                          : <Trash2 aria-hidden="true" size={13} />}
                      </button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div aria-live="polite" className="template-library-feedback">
        {error ? <p role="alert">{error}</p> : notice ? <p className="is-success">{notice}</p> : null}
      </div>
    </section>
  );
}
