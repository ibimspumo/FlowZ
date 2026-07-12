import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtboardExportPopover } from "./ArtboardExportPopover";

describe("ArtboardExportPopover",()=>{
  it("presents compact typed export controls and an accessible modal boundary",()=>{
    const html=renderToStaticMarkup(<ArtboardExportPopover boardNames={["Post","Story"]} busy={false} progress={0} options={{includeManifest:true,overwrite:"rename"}} onOptions={()=>undefined} onChooseFolder={()=>undefined} onExport={()=>undefined} onReveal={()=>undefined} onClose={()=>undefined}/>);
    expect(html).toContain('role="dialog"');expect(html).toContain('aria-modal="true"');
    expect(html).toContain("2 ausgewählte Artboards");expect(html).toContain("PNG-Composites");expect(html).toContain(".flowz-artboard");expect(html).toContain("Exportordner wählen");
    expect(html).not.toContain("<select");
  });
});
