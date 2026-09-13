"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Circle,
  GripVertical,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  Square,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import {
  type DragEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  clampNumber,
  DEFAULT_LOGO_SRC,
  imageLayerHeight,
  layerHeight,
  MAX_COMPOSITION_LAYERS,
  maximumImageLayerWidth,
  MIN_IMAGE_LAYER_WIDTH,
  positionLayer,
  reorderLayersForVisualDrop,
  type CompositionLayer,
  type FontFamily,
  type FontWeight,
  type ImageLayer,
  type ImageMask,
  type TextAlignment,
  type TextLayer,
} from "@/lib/composition";

type MaybePromise = void | Promise<void>;

export type CompositionEditorProps = {
  /** Paint order from back to front. */
  layers: readonly CompositionLayer[];
  selectedLayerId: string | null;
  disabled?: boolean;
  onSelectLayer: (layerId: string) => void;
  onAddText: () => void;
  onUploadLogo: (file: File) => MaybePromise;
  onRestoreLogo: () => void;
  onUploadImage: (file: File) => MaybePromise;
  onChangeLayer: (layer: CompositionLayer) => void;
  /** Receives the complete next paint order, also back to front. */
  onReorderLayers: (layers: CompositionLayer[]) => void;
  onDeleteLayer: (layerId: string) => void;
};

const FONT_OPTIONS: ReadonlyArray<{ value: FontFamily; label: string }> = [
  { value: "sans", label: "Sans" },
  { value: "display", label: "Display" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];

const WEIGHT_OPTIONS: ReadonlyArray<{ value: FontWeight; label: string }> = [
  { value: 400, label: "Regular" },
  { value: 700, label: "Bold" },
  { value: 900, label: "Heavy" },
];

const ALIGNMENT_OPTIONS: ReadonlyArray<{
  value: TextAlignment;
  label: string;
  icon: typeof AlignLeft;
}> = [
  { value: "left", label: "Align left", icon: AlignLeft },
  { value: "center", label: "Align center", icon: AlignCenter },
  { value: "right", label: "Align right", icon: AlignRight },
];

function percent(value: number) {
  return `${Math.round(value * 1_000) / 10}%`;
}

function layerTypeLabel(layer: CompositionLayer) {
  if (layer.type === "text") return "Text";
  return layer.role === "logo" ? "Logo" : "Image";
}

function LayerIcon({ layer }: { layer: CompositionLayer }) {
  return layer.type === "text" ? (
    <Type aria-hidden="true" size={15} />
  ) : (
    <ImagePlus aria-hidden="true" size={15} />
  );
}

function TextControls({
  disabled,
  layer,
  onChange,
}: {
  disabled: boolean;
  layer: TextLayer;
  onChange: (layer: TextLayer) => void;
}) {
  const fieldId = useId();

  const update = (patch: Partial<TextLayer>) => {
    const next = { ...layer, ...patch };
    onChange(positionLayer(next, next.x, next.y));
  };

  const maximumX = Math.max(0, 1 - layer.width);
  const maximumY = Math.max(0, 1 - layerHeight(layer));

  return (
    <div className="layer-inspector layer-inspector-text">
      <div className="section-title">
        <Type aria-hidden="true" size={16} />
        <strong>Text settings</strong>
      </div>

      <label className="field-label" htmlFor={`${fieldId}-copy`}>
        Copy <span>{layer.text.length}/500</span>
      </label>
      <textarea
        className="small-textarea"
        disabled={disabled}
        id={`${fieldId}-copy`}
        maxLength={500}
        onChange={(event) => update({ text: event.currentTarget.value })}
        rows={3}
        value={layer.text}
      />

      <div className="layer-field-grid">
        <label className="compact-field" htmlFor={`${fieldId}-family`}>
          <span>Font</span>
          <select
            disabled={disabled}
            id={`${fieldId}-family`}
            onChange={(event) => {
              const option = FONT_OPTIONS.find(({ value }) => value === event.currentTarget.value);
              if (option) update({ fontFamily: option.value });
            }}
            value={layer.fontFamily}
          >
            {FONT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="compact-field" htmlFor={`${fieldId}-weight`}>
          <span>Weight</span>
          <select
            disabled={disabled}
            id={`${fieldId}-weight`}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              const option = WEIGHT_OPTIONS.find(({ value: weight }) => weight === value);
              if (option) update({ fontWeight: option.value });
            }}
            value={layer.fontWeight}
          >
            {WEIGHT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="slider-row layer-slider-row">
        <label htmlFor={`${fieldId}-font-size`}>Size</label>
        <input
          disabled={disabled}
          id={`${fieldId}-font-size`}
          max="180"
          min="18"
          onChange={(event) => update({ fontSize: event.currentTarget.valueAsNumber })}
          step="1"
          type="range"
          value={layer.fontSize}
        />
        <output htmlFor={`${fieldId}-font-size`}>{layer.fontSize}px</output>
      </div>

      <div className="slider-row layer-slider-row">
        <label htmlFor={`${fieldId}-text-width`}>Width</label>
        <input
          disabled={disabled}
          id={`${fieldId}-text-width`}
          max="0.96"
          min="0.12"
          onChange={(event) => update({ width: event.currentTarget.valueAsNumber })}
          step="0.01"
          type="range"
          value={layer.width}
        />
        <output htmlFor={`${fieldId}-text-width`}>{percent(layer.width)}</output>
      </div>

      <div className="layer-field-grid color-field-grid">
        <label className="compact-field color-field" htmlFor={`${fieldId}-fill`}>
          <span>Fill</span>
          <span className="color-input-wrap">
            <input
              aria-label="Text fill color"
              disabled={disabled}
              id={`${fieldId}-fill`}
              onChange={(event) => update({ color: event.currentTarget.value })}
              type="color"
              value={layer.color}
            />
            <output htmlFor={`${fieldId}-fill`}>{layer.color.toUpperCase()}</output>
          </span>
        </label>

        <label className="compact-field color-field" htmlFor={`${fieldId}-outline`}>
          <span>Outline</span>
          <span className="color-input-wrap">
            <input
              aria-label="Text outline color"
              disabled={disabled}
              id={`${fieldId}-outline`}
              onChange={(event) => update({ strokeColor: event.currentTarget.value })}
              type="color"
              value={layer.strokeColor}
            />
            <output htmlFor={`${fieldId}-outline`}>{layer.strokeColor.toUpperCase()}</output>
          </span>
        </label>
      </div>

      <div className="slider-row layer-slider-row">
        <label htmlFor={`${fieldId}-outline-width`}>Outline</label>
        <input
          disabled={disabled}
          id={`${fieldId}-outline-width`}
          max="20"
          min="0"
          onChange={(event) => update({ strokeWidth: event.currentTarget.valueAsNumber })}
          step="1"
          type="range"
          value={layer.strokeWidth}
        />
        <output htmlFor={`${fieldId}-outline-width`}>{layer.strokeWidth}px</output>
      </div>

      <fieldset className="layer-choice-field">
        <legend>Alignment</legend>
        <div className="segment-control layer-segment-control">
          {ALIGNMENT_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                aria-label={option.label}
                aria-pressed={layer.textAlign === option.value}
                className={layer.textAlign === option.value ? "is-selected" : ""}
                disabled={disabled}
                key={option.value}
                onClick={() => update({ textAlign: option.value })}
                title={option.label}
                type="button"
              >
                <Icon aria-hidden="true" size={15} />
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="position-controls" role="group" aria-label="Text position">
        <div className="slider-row layer-slider-row">
          <label htmlFor={`${fieldId}-x`}>X</label>
          <input
            disabled={disabled}
            id={`${fieldId}-x`}
            max={maximumX}
            min="0"
            onChange={(event) => update({ x: event.currentTarget.valueAsNumber })}
            step="0.005"
            type="range"
            value={layer.x}
          />
          <output htmlFor={`${fieldId}-x`}>{percent(layer.x)}</output>
        </div>
        <div className="slider-row layer-slider-row">
          <label htmlFor={`${fieldId}-y`}>Y</label>
          <input
            disabled={disabled}
            id={`${fieldId}-y`}
            max={maximumY}
            min="0"
            onChange={(event) => update({ y: event.currentTarget.valueAsNumber })}
            step="0.005"
            type="range"
            value={layer.y}
          />
          <output htmlFor={`${fieldId}-y`}>{percent(layer.y)}</output>
        </div>
      </div>
    </div>
  );
}

function ImageControls({
  disabled,
  layer,
  onChange,
}: {
  disabled: boolean;
  layer: ImageLayer;
  onChange: (layer: ImageLayer) => void;
}) {
  const fieldId = useId();

  const update = (patch: Partial<ImageLayer>) => {
    const next = { ...layer, ...patch };
    const normalized = {
      ...next,
      width: clampNumber(
        next.width,
        MIN_IMAGE_LAYER_WIDTH,
        maximumImageLayerWidth(next),
      ),
    };
    onChange(positionLayer(normalized, normalized.x, normalized.y));
  };

  const maximumWidth = maximumImageLayerWidth(layer);
  const maximumX = Math.max(0, 1 - layer.width);
  const maximumY = Math.max(0, 1 - imageLayerHeight(layer));

  return (
    <div className="layer-inspector layer-inspector-image">
      <div className="section-title">
        <ImagePlus aria-hidden="true" size={16} />
        <strong>{layer.role === "logo" ? "Logo settings" : "Image settings"}</strong>
      </div>

      {layer.role === "overlay" ? (
        <fieldset className="layer-choice-field">
          <legend>Image shape</legend>
          <div className="segment-control layer-segment-control image-mask-control">
            {([
              { value: "none" as const, label: "Rectangle", icon: Square },
              { value: "circle" as const, label: "Circle", icon: Circle },
            ]).map((option) => {
              const Icon = option.icon;
              return (
                <button
                  aria-pressed={layer.mask === option.value}
                  className={layer.mask === option.value ? "is-selected" : ""}
                  disabled={disabled}
                  key={option.value}
                  onClick={() => update({ mask: option.value as ImageMask })}
                  type="button"
                >
                  <Icon aria-hidden="true" size={14} /> {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="slider-row layer-slider-row">
        <label htmlFor={`${fieldId}-image-size`}>Size</label>
        <input
          disabled={disabled}
          id={`${fieldId}-image-size`}
          max={maximumWidth}
          min={MIN_IMAGE_LAYER_WIDTH}
          onChange={(event) => update({ width: event.currentTarget.valueAsNumber })}
          step="0.01"
          type="range"
          value={layer.width}
        />
        <output htmlFor={`${fieldId}-image-size`}>{percent(layer.width)}</output>
      </div>

      <div className="position-controls" role="group" aria-label="Image position">
        <div className="slider-row layer-slider-row">
          <label htmlFor={`${fieldId}-x`}>X</label>
          <input
            disabled={disabled}
            id={`${fieldId}-x`}
            max={maximumX}
            min="0"
            onChange={(event) => update({ x: event.currentTarget.valueAsNumber })}
            step="0.005"
            type="range"
            value={layer.x}
          />
          <output htmlFor={`${fieldId}-x`}>{percent(layer.x)}</output>
        </div>
        <div className="slider-row layer-slider-row">
          <label htmlFor={`${fieldId}-y`}>Y</label>
          <input
            disabled={disabled}
            id={`${fieldId}-y`}
            max={maximumY}
            min="0"
            onChange={(event) => update({ y: event.currentTarget.valueAsNumber })}
            step="0.005"
            type="range"
            value={layer.y}
          />
          <output htmlFor={`${fieldId}-y`}>{percent(layer.y)}</output>
        </div>
      </div>
    </div>
  );
}

export function CompositionEditor({
  layers,
  selectedLayerId,
  disabled = false,
  onSelectLayer,
  onAddText,
  onUploadLogo,
  onRestoreLogo,
  onUploadImage,
  onChangeLayer,
  onReorderLayers,
  onDeleteLayer,
}: CompositionEditorProps) {
  const logoInputId = useId();
  const imageInputId = useId();
  const layerHelpId = useId();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"logo" | "overlay" | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  const logo = layers.find(
    (layer): layer is ImageLayer => layer.type === "image" && layer.role === "logo",
  );
  const selectedLayer = layers.find(({ id }) => id === selectedLayerId) ?? null;
  const visualLayers = useMemo(() => [...layers].reverse(), [layers]);
  const controlsDisabled = disabled || uploading !== null;
  const layerLimitReached = layers.length >= MAX_COMPOSITION_LAYERS;

  const upload = async (kind: "logo" | "overlay", file: File) => {
    setUploadError("");
    setUploading(kind);
    try {
      await (kind === "logo" ? onUploadLogo(file) : onUploadImage(file));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "The image could not be uploaded.");
    } finally {
      setUploading(null);
    }
  };

  const reorderFromVisualList = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const moved = layers.find(({ id }) => id === sourceId);
    if (!moved || !layers.some(({ id }) => id === targetId)) return;
    onReorderLayers(reorderLayersForVisualDrop(layers, sourceId, targetId));
    setAnnouncement(`${moved.name} moved in the layer stack.`);
  };

  const moveOneStep = (layerId: string, direction: "forward" | "backward") => {
    const currentIndex = layers.findIndex(({ id }) => id === layerId);
    const targetIndex = currentIndex + (direction === "forward" ? 1 : -1);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= layers.length) return;
    const next = [...layers];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex]!, next[currentIndex]!];
    onReorderLayers(next);
    const moved = layers[currentIndex]!;
    setAnnouncement(
      `${moved.name} moved ${direction === "forward" ? "forward" : "backward"}.`,
    );
  };

  const dropLayer = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = draggedLayerId || event.dataTransfer.getData("text/plain");
    if (sourceId) reorderFromVisualList(sourceId, targetId);
    setDraggedLayerId(null);
    setDropTargetId(null);
  };

  return (
    <div className="composition-editor">
      <section className="control-section logo-control-section" aria-labelledby={`${logoInputId}-heading`}>
        <div className="section-title" id={`${logoInputId}-heading`}>
          <ImagePlus aria-hidden="true" size={16} />
          <strong>Brand logo</strong>
        </div>
        <div className="logo-control-card">
          {/* The source can be authenticated project media, so it is intentionally not optimized. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Current brand logo" src={logo?.src || DEFAULT_LOGO_SRC} />
          <div className="logo-control-copy">
            <strong>{logo?.src === DEFAULT_LOGO_SRC ? "GoStudy logo" : "Custom logo"}</strong>
            <small>Placed in the top brand area</small>
          </div>
          <div className="logo-control-actions">
            <button
              className="compact-upload-button"
              disabled={controlsDisabled}
              onClick={() => logoInputRef.current?.click()}
              type="button"
            >
              {uploading === "logo" ? (
                <LoaderCircle aria-hidden="true" className="spin" size={14} />
              ) : (
                <Upload aria-hidden="true" size={14} />
              )}
              <span>{uploading === "logo" ? "Uploading…" : "Replace"}</span>
            </button>
            <button
              aria-label="Restore the default GoStudy logo"
              className="icon-button"
              disabled={controlsDisabled || !logo || logo.src === DEFAULT_LOGO_SRC}
              onClick={onRestoreLogo}
              title="Restore default logo"
              type="button"
            >
              <RotateCcw aria-hidden="true" size={14} />
            </button>
          </div>
        </div>
        <input
          accept="image/png,image/jpeg,image/webp,image/avif"
          className="sr-only"
          disabled={controlsDisabled}
          id={logoInputId}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload("logo", file);
          }}
          ref={logoInputRef}
          tabIndex={-1}
          type="file"
        />
      </section>

      <section className="control-section add-layer-section" aria-labelledby={`${imageInputId}-heading`}>
        <div className="section-title" id={`${imageInputId}-heading`}>
          <Type aria-hidden="true" size={16} />
          <strong>Add elements</strong>
        </div>
        <div className="add-layer-actions">
          <button
            className="secondary-button compact-action-button"
            disabled={controlsDisabled || layerLimitReached}
            onClick={onAddText}
            type="button"
          >
            <Type aria-hidden="true" size={15} /> Add text
          </button>
          <button
            className="secondary-button compact-action-button"
            disabled={controlsDisabled || layerLimitReached}
            onClick={() => imageInputRef.current?.click()}
            type="button"
          >
            {uploading === "overlay" ? (
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
            ) : (
              <ImagePlus aria-hidden="true" size={15} />
            )}
            {uploading === "overlay" ? "Uploading…" : "Add image"}
          </button>
        </div>
        <input
          accept="image/png,image/jpeg,image/webp,image/avif"
          className="sr-only"
          disabled={controlsDisabled || layerLimitReached}
          id={imageInputId}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload("overlay", file);
          }}
          ref={imageInputRef}
          tabIndex={-1}
          type="file"
        />
        {layerLimitReached ? (
          <p className="field-help">This composition has the maximum of {MAX_COMPOSITION_LAYERS} layers.</p>
        ) : null}
        {uploadError ? <p className="field-error" role="alert">{uploadError}</p> : null}
      </section>

      {selectedLayer ? (
        <section className="control-section selected-layer-section" aria-label={`Edit ${selectedLayer.name}`}>
          {selectedLayer.type === "text" ? (
            <TextControls
              disabled={controlsDisabled}
              layer={selectedLayer}
              onChange={onChangeLayer}
            />
          ) : (
            <ImageControls
              disabled={controlsDisabled}
              layer={selectedLayer}
              onChange={onChangeLayer}
            />
          )}
        </section>
      ) : (
        <section className="control-section selected-layer-empty" aria-label="Element settings">
          <p>Select an element on the canvas or in the layer list to edit it.</p>
        </section>
      )}

      <section className="control-section layer-stack-section" aria-labelledby={`${layerHelpId}-heading`}>
        <div className="section-title layer-stack-heading">
          <GripVertical aria-hidden="true" size={16} />
          <strong id={`${layerHelpId}-heading`}>Layers</strong>
          <span>{layers.length}/{MAX_COMPOSITION_LAYERS}</span>
        </div>
        <p className="field-help" id={layerHelpId}>
          Front layers appear first. Drag to reorder, or use the arrow buttons.
        </p>
        <ul className="layer-list" aria-describedby={layerHelpId}>
          {visualLayers.map((layer) => {
            const index = layers.findIndex(({ id }) => id === layer.id);
            const isLogo = layer.type === "image" && layer.role === "logo";
            const isSelected = layer.id === selectedLayerId;
            return (
              <li
                className={`layer-list-item ${isSelected ? "is-selected" : ""} ${
                  draggedLayerId === layer.id ? "is-dragging" : ""
                } ${dropTargetId === layer.id ? "is-drop-target" : ""}`}
                draggable={!controlsDisabled}
                key={layer.id}
                onDragEnd={() => {
                  setDraggedLayerId(null);
                  setDropTargetId(null);
                }}
                onDragEnter={() => {
                  if (draggedLayerId && draggedLayerId !== layer.id) setDropTargetId(layer.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDragStart={(event) => {
                  if (controlsDisabled) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", layer.id);
                  setDraggedLayerId(layer.id);
                  onSelectLayer(layer.id);
                }}
                onDrop={(event) => dropLayer(event, layer.id)}
              >
                <span className="layer-drag-handle" aria-hidden="true">
                  <GripVertical size={15} />
                </span>
                <button
                  aria-pressed={isSelected}
                  className="layer-select-button"
                  disabled={controlsDisabled}
                  onClick={() => onSelectLayer(layer.id)}
                  type="button"
                >
                  <span className={`layer-kind layer-kind-${layer.type}`}>
                    <LayerIcon layer={layer} />
                  </span>
                  <span className="layer-name">
                    <strong>{layer.name}</strong>
                    <small>{layerTypeLabel(layer)}</small>
                  </span>
                </button>
                <div className="layer-order-actions">
                  <button
                    aria-label={`Bring ${layer.name} forward`}
                    disabled={controlsDisabled || index === layers.length - 1}
                    onClick={() => moveOneStep(layer.id, "forward")}
                    title="Bring forward"
                    type="button"
                  >
                    <ArrowUp aria-hidden="true" size={13} />
                  </button>
                  <button
                    aria-label={`Send ${layer.name} backward`}
                    disabled={controlsDisabled || index === 0}
                    onClick={() => moveOneStep(layer.id, "backward")}
                    title="Send backward"
                    type="button"
                  >
                    <ArrowDown aria-hidden="true" size={13} />
                  </button>
                  {!isLogo ? (
                    <button
                      aria-label={`Delete ${layer.name}`}
                      className="delete-layer-button"
                      disabled={controlsDisabled}
                      onClick={() => onDeleteLayer(layer.id)}
                      title="Delete layer"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <p aria-live="polite" className="sr-only">{announcement}</p>
      </section>
    </div>
  );
}
