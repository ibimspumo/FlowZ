import { describe, expect, it, vi } from "vitest";
import { pngDataUrlBase64, pngDataUrlBytes, renderBoardExport, resolveArtboardExportFolder } from "./artboard-export";
import { ARTBOARD_DOCUMENT_VERSION, type ArtboardBoard } from "../nodes/brand/artboard-domain";
import { renderArtboardSvg } from "../nodes/brand/artboard-renderer";

const board:ArtboardBoard={id:"b",name:"Campaign",activeRevisionId:"rev",document:{schemaVersion:ARTBOARD_DOCUMENT_VERSION,id:"d",name:"Campaign",format:{preset:"instagram-post",width:1080,height:1080},paint:{kind:"solid",color:"#FFFFFF"},rootLayerIds:[],layers:{},bindings:{},tokenRefs:{}},inputSnapshot:{id:"s",createdAt:"2026-01-01T00:00:00.000Z",bindings:{}},ancestry:{branchId:"branch"},createdAt:"2026-01-01T00:00:00.000Z"};

describe("artboard export rendering", () => {
  it("decodes only PNG data URLs", () => {
    vi.stubGlobal("atob", (value:string)=>Buffer.from(value,"base64").toString("binary"));
    expect([...pngDataUrlBytes("data:image/png;base64,iVBORw0KGgo=")]).toEqual([137,80,78,71,13,10,26,10]);
    expect(pngDataUrlBase64("data:image/png;base64,iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
    expect(()=>pngDataUrlBytes("data:image/jpeg;base64,eA==")).toThrow(/kein PNG/);
    expect(()=>pngDataUrlBase64("data:image/png;base64,eA==")).toThrow(/beschädigt/);
    vi.unstubAllGlobals();
  });

  it("binds the board and immutable board revision to the export payload", async () => {
    vi.stubGlobal("atob",(value:string)=>Buffer.from(value,"base64").toString("binary"));
    const backend=vi.fn(async()=>"data:image/png;base64,iVBORw0KGgo=");
    const result=await renderBoardExport(board,()=>"",backend);
    expect(result).toMatchObject({boardId:"b",boardRevisionId:"rev",name:"Campaign",pngBase64:"iVBORw0KGgo="});
    expect(backend).toHaveBeenCalledWith(renderArtboardSvg(board.document,()=>""),expect.objectContaining({width:1080,height:1080}));
    expect(backend).toHaveBeenCalledOnce();vi.unstubAllGlobals();
  });

  it("continues the first export with the folder selected by the picker", async()=>{
    const choose=vi.fn(async()=>({grantId:"grant-1"}));
    await expect(resolveArtboardExportFolder(undefined,choose)).resolves.toEqual({grantId:"grant-1"});
    expect(choose).toHaveBeenCalledOnce();
    await expect(resolveArtboardExportFolder({grantId:"saved"},choose)).resolves.toEqual({grantId:"saved"});
    expect(choose).toHaveBeenCalledOnce();
  });
});
