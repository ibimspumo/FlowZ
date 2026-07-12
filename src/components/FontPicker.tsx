import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Search,
  Variable,
  X,
} from "lucide-react";
import { listBrandFontCache, prepareBrandFont, previewBrandFont } from "../api";
import {
  DISABLED_GOOGLE_FONTS,
  findFont,
  GOOGLE_FONT_CATALOG,
  GOOGLE_FONTS,
  searchFonts,
} from "../nodes/brand/fonts";
import type {FontRecord} from "../nodes/brand/artifacts";
import { browserFontRegistry, fontPreviewLoader, type PreparedFont } from "./font-preview-loader";
import {
  activateSelect,
  closeActiveSelect,
  deactivateSelect,
} from "./select-coordinator";
import { formatNumber, useI18n } from "../i18n";

const ROW = 54,
  VIEW = 270,
  OVERSCAN = 3;
const previewCache = new Map<string, PreparedFont>();
const offlineKeys = new Set<string>();
const loadedPreviewKeys = new Set<string>();
const cachePreview=(key:string,value:PreparedFont)=>{previewCache.delete(key);previewCache.set(key,value);while(previewCache.size>48){const removable=[...previewCache].find(([,item])=>!item.blobHash);if(!removable)break;previewCache.delete(removable[0]);}};
const keyOf = (font: FontRecord) => `${font.family}:${font.variantIndex}`;
const recent = (): string[] => {
  try {
    return JSON.parse(
      localStorage.getItem("flowz:recent-fonts") ?? "[]",
    ) as string[];
  } catch {
    return [];
  }
};
const remember = (family: string) => {
  try {
    localStorage.setItem(
      "flowz:recent-fonts",
      JSON.stringify(
        [family, ...recent().filter((item) => item !== family)].slice(0, 12),
      ),
    );
  } catch {
    /* Private storage may be unavailable. */
  }
};
const axisCss = (font: FontRecord) =>
  font.axisRanges
    .filter((axis) => axis.value != null)
    .map((axis) => `"${axis.tag}" ${axis.value}`)
    .join(", ");

export type FontSelection = {
  family: string;
  variantIndex: number;
  axes: Record<string, number>;
  prepared?: PreparedFont;
  style: string;
  weight: number;
  license: FontRecord["license"];
  subsets: string[];
};
export function FontPicker({
  label,
  value,
  variantIndex = 0,
  axes = {},
  onChange,
  initiallyOpen = false,
}: {
  label: string;
  value: string;
  variantIndex?: number;
  axes?: Record<string, number>;
  onChange: (selection: FontSelection) => void;
  initiallyOpen?: boolean;
}) {
  const { locale, t } = useI18n();
  const id = useId(),
    triggerRef = useRef<HTMLButtonElement>(null),
    searchRef = useRef<HTMLInputElement>(null),
    listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initiallyOpen),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [subset, setSubset] = useState(""),
    [variable, setVariable] = useState(false),
    [loadedOnly, setLoadedOnly] = useState(false),
    [recentOnly, setRecentOnly] = useState(false),
    [preview, setPreview] = useState(()=>t("font.defaultPreview")),
    [scroll, setScroll] = useState(0),
    [active, setActive] = useState(0),
    [position, setPosition] = useState({ left: 8, top: 8, width: 520 }),
    [preparing, setPreparing] = useState(false),
    [error, setError] = useState(""),
    [cacheRevision, refresh] = useState(0);
  const selected = useMemo(
    () => findFont(value, variantIndex, axes),
    [value, variantIndex, axes],
  );
  useEffect(()=>{if(preview==="Deine Marke, klar erzählt."||preview==="Your brand, told clearly.")setPreview(t("font.defaultPreview"));},[locale]);
  const recentFamilies = recent();
  const fonts = useMemo(
    () =>
      searchFonts(query, {
        category: category || undefined,
        subset: subset || undefined,
        variableOnly: variable,
      })
        .filter(
          (font) =>
            (!loadedOnly || offlineKeys.has(keyOf(font))) &&
            (!recentOnly || recentFamilies.includes(font.family)),
        )
        .sort(
          (a, b) =>
            Number(offlineKeys.has(keyOf(b))) -
              Number(offlineKeys.has(keyOf(a))) ||
            (recentFamilies.indexOf(a.family) < 0
              ? 999
              : recentFamilies.indexOf(a.family)) -
              (recentFamilies.indexOf(b.family) < 0
                ? 999
                : recentFamilies.indexOf(b.family)) ||
            a.family.localeCompare(b.family),
        ),
    [query, category, subset, variable, loadedOnly, recentOnly, open,cacheRevision],
  );
  const start = Math.max(0, Math.floor(scroll / ROW) - OVERSCAN),
    end = Math.min(fonts.length, Math.ceil((scroll + VIEW) / ROW) + OVERSCAN),
    visible = fonts.slice(start, end);
  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(520, window.innerWidth - 16);
    const height = 500;
    const top =
      window.innerHeight - rect.bottom > height + 8
        ? rect.bottom + 5
        : Math.max(8, rect.top - height - 5);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top,
      width,
    });
  };
  const show = () => {
    place();
    setQuery("");
    setScroll(0);
    setActive(
      Math.max(
        0,
        fonts.findIndex((font) => font.family === selected.family),
      ),
    );
    setError("");
    setOpen(true);
  };
  const close = (restore = false) => {
    setOpen(false);
    if (restore) queueMicrotask(() => triggerRef.current?.focus());
  };
  const choose = async (font: FontRecord) => {
    setPreparing(true);
    setError("");
    try {
      const prepared = await prepareBrandFont(font);
      cachePreview(keyOf(font), prepared);
      await browserFontRegistry.load(keyOf(font),prepared,font.style,font.weight);
      loadedPreviewKeys.add(keyOf(font));
      offlineKeys.add(keyOf(font));
      remember(font.family);
      onChange({
        family: font.family,
        variantIndex: font.variantIndex,
        axes: Object.fromEntries(
          font.axisRanges.map((axis) => [
            axis.tag,
            axis.value ??
              Math.min(
                axis.max,
                Math.max(
                  axis.min,
                  axis.tag === "wght" ? font.weight : (axis.min + axis.max) / 2,
                ),
              ),
          ]),
        ),
        prepared,
        style:font.style,
        weight:font.weight,
        license:font.license,
        subsets:[...font.subsets],
      });
      close(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreparing(false);
    }
  };
  const move = (next: number) => {
    const index = Math.max(0, Math.min(fonts.length - 1, next));
    setActive(index);
    const top = index * ROW,
      bottom = top + ROW;
    const list = listRef.current;
    if (list) {
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + VIEW) list.scrollTop = bottom - VIEW;
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(fonts.length - 1);
    } else if (event.key === "Enter" && fonts[active]) {
      event.preventDefault();
      void choose(fonts[active]);
    }
  };
  useEffect(() => {
    if (!open) return;
    activateSelect(id, () => setOpen(false));
    queueMicrotask(() => searchRef.current?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !document.getElementById(`${id}-font-popup`)?.contains(target)
      )
        setOpen(false);
    };
    const viewport = () => closeActiveSelect();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("flowz:close-selects", viewport);
    window.addEventListener("resize", viewport);
    return () => {
      deactivateSelect(id);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("flowz:close-selects", viewport);
      window.removeEventListener("resize", viewport);
    };
  }, [id, open]);
  useEffect(() => {
    if (!open) return;
    let activeRequest = true;
    void listBrandFontCache().then((items) => {
      if (!activeRequest) return;
      for (const item of items) {
        const font = GOOGLE_FONTS.find(
          (candidate) =>
            candidate.family === item.family &&
            candidate.variants[item.variantIndex]?.file === item.fontFile,
        );
        if (font) {
          const exact = findFont(font.family, item.variantIndex);
          offlineKeys.add(keyOf(exact));
          cachePreview(keyOf(exact), {
            blobHash: item.blobHash,
            licenseBlobHash: item.licenseBlobHash,
            fontSha256: item.fontSha256,
            mediaUrl: `flowz-media://localhost/${item.blobHash}`,
          });
        }
      }
      refresh((value) => value + 1);
    });
    return () => {
      activeRequest = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    for (const font of visible) {
      const key = keyOf(font);
      if (loadedPreviewKeys.has(key)) continue;
      const cached=previewCache.get(key);
      const prepared=cached?Promise.resolve(cached):fontPreviewLoader.load(font, controller.signal, previewBrandFont).then((result)=>{cachePreview(key,result);return result;});
      prepared.then((result)=>browserFontRegistry.load(key,result,font.style,font.weight)).then(()=>{if(controller.signal.aborted)return;loadedPreviewKeys.add(key);refresh((value)=>value+1);})
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [open, start, end, query, category, subset, variable]);
  const activeVisibleIndex=fonts[active]?visible.findIndex((font)=>font.family===fonts[active].family):-1;
  const activeId=activeVisibleIndex>=0?`${id}-font-${start+activeVisibleIndex}`:undefined;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="font-picker-trigger nodrag nowheel nopan"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-font-list`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (!open && ["Enter", " ", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span>
          <strong>{selected.family}</strong>
          <small>
            {selected.style} · {selected.weight}
            {selected.variants[selected.variantIndex]?.variable
              ? ` · ${t("font.variable")}`
              : ""}
          </small>
        </span>
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
          <div
            id={`${id}-font-popup`}
            className="font-picker-popover nodrag nowheel nopan"
            role="dialog"
            aria-label={t("font.choose",{label})}
            style={position}
          >
            <div className="font-picker-head">
              <label htmlFor={`${id}-search`}>
                <Search size={13} />
                <input
                  ref={searchRef}
                  id={`${id}-search`}
                  role="combobox"
                  aria-label={t("font.searchLabel",{label})}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={`${id}-font-list`}
                  aria-activedescendant={activeId}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setScroll(0);
                    setActive(0);
                  }}
                  onKeyDown={keys}
                  placeholder={t("font.searchSelectable",{count:formatNumber(GOOGLE_FONTS.length)})}
                />
              </label>
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => close(true)}
              >
                <X size={13} />
              </button>
            </div>
            <input
              className="font-preview-input"
              aria-label={t("font.preview")}
              value={preview}
              onChange={(event) => setPreview(event.target.value)}
            />
            <div className="font-variant-row" aria-label={t("font.exactVariant")}>
              {selected.variants.map((variant, index) => (
                <button
                  type="button"
                  key={`${variant.file}-${index}`}
                  className={selected.variantIndex === index ? "active" : ""}
                  onClick={() => void choose(findFont(selected.family,index,axes))}
                >
                  {variant.style} {variant.weight}
                  {variant.variable ? " · VF" : ""}
                </button>
              ))}
            </div>
            {selected.axisRanges.length > 0 && (
              <details className="font-axis-settings">
                <summary>{t("font.axes")}</summary>
                {selected.axisRanges.map((axis) => (
                  <label key={axis.tag}>
                    <span>
                      {axis.tag}
                      <output>
                        {Number(
                          axes[axis.tag] ??
                            axis.value ??
                            (axis.min + axis.max) / 2,
                        ).toFixed(1)}
                      </output>
                    </span>
                    <input
                      type="range"
                      min={axis.min}
                      max={axis.max}
                      step={Math.max(0.01, (axis.max - axis.min) / 100)}
                      value={
                        axes[axis.tag] ??
                        axis.value ??
                        (axis.min + axis.max) / 2
                      }
                      onChange={(event) =>
                        onChange({
                          family: selected.family,
                          variantIndex: selected.variantIndex,
                          axes: {
                            ...axes,
                            [axis.tag]: Number(event.target.value),
                          },
                          prepared: previewCache.get(keyOf(selected)),
                          style:selected.style,
                          weight:selected.weight,
                          license:selected.license,
                          subsets:[...selected.subsets],
                        })
                      }
                    />
                  </label>
                ))}
              </details>
            )}
            <div
              className="font-filter-row"
              aria-label={t("font.filters")}
            >
              {[
                "",
                "sans-serif",
                "serif",
                "display",
                "handwriting",
                "monospace",
              ].map((item) => (
                <button
                  type="button"
                  key={item || "all"}
                  className={category === item ? "active" : ""}
                  onClick={() => {
                    setCategory(item);
                    setScroll(0);
                    setActive(0);
                  }}
                >
                  {item || t("font.all")}
                </button>
              ))}
            </div>
            <div className="font-filter-row secondary-filters">
              {["", "latin", "cyrillic", "greek", "arabic", "devanagari"].map(
                (item) => (
                  <button
                    type="button"
                    key={item || "scripts"}
                    className={subset === item ? "active" : ""}
                    onClick={() => {
                      setSubset(item);
                      setScroll(0);
                      setActive(0);
                    }}
                  >
                    {item || t("font.script")}
                  </button>
                ),
              )}
              <button
                type="button"
                className={variable ? "active" : ""}
                onClick={() => setVariable((value) => !value)}
              >
                <Variable size={10} />
                {t("font.variable")}
              </button>
              <button
                type="button"
                className={loadedOnly ? "active" : ""}
                onClick={() => setLoadedOnly((value) => !value)}
              >
                {t("font.offline")}
              </button>
              <button
                type="button"
                className={recentOnly ? "active" : ""}
                onClick={() => setRecentOnly((value) => !value)}
              >
                {t("font.recent")}
              </button>
            </div>
            <div
              ref={listRef}
              id={`${id}-font-list`}
              className="font-virtual-list"
              role="listbox"
              aria-label={label}
              aria-busy={preparing}
              style={{ height: VIEW }}
              onKeyDown={keys}
              onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
            >
              <div style={{ height: fonts.length * ROW, position: "relative" }}>
                {visible.map((font, index) => {
                  const prepared = previewCache.get(keyOf(font));
                  const family = prepared&&loadedPreviewKeys.has(keyOf(font))
                    ? browserFontRegistry.family(keyOf(font))
                    : undefined;
                  const absolute = start + index;
                  const variation = axisCss(font);
                  return (
                    <div
                      id={`${id}-font-${absolute}`}
                      role="option"
                      aria-selected={font.family === selected.family}
                      className={`font-result ${absolute === active ? "active" : ""}`}
                      key={font.family}
                      style={
                        {
                          position: "absolute",
                          top: absolute * ROW,
                          height: ROW,
                          ...(family
                            ? {
                                fontFamily: family,
                                fontVariationSettings: variation || undefined,
                              }
                            : {}),
                        } as CSSProperties
                      }
                      onPointerMove={() => setActive(absolute)}
                      onClick={() => void choose(font)}
                    >
                      <span>
                        <strong>{preview || font.family}</strong>
                        <small>
                          {font.family} · {font.category} ·{" "}
                          {offlineKeys.has(keyOf(font)) ? "offline · " : ""}
                          {t("font.families", { count: font.variants.length })}
                        </small>
                      </span>
                      {font.family === selected.family ? (
                        <Check size={13} />
                      ) : font.variants.some((item) => item.variable) ? (
                        <Variable size={12} />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            {error && (
              <p className="font-picker-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <span>
                {t("font.stats",{total:formatNumber(GOOGLE_FONT_CATALOG.length),selectable:formatNumber(GOOGLE_FONTS.length),disabled:DISABLED_GOOGLE_FONTS.length})}
              </span>
              {preparing && <LoaderCircle className="spin" size={11} />}
              <span>Commit {awaitCommit}</span>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}

// Kept as a module constant so the UI never performs a network catalog lookup.
const awaitCommit = "ec0464b";
