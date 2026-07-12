import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, validateArtboardWorkspace, type ArtboardDocument, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { renderArtboardSvg } from "../nodes/brand/artboard-renderer";
import { applyWorkspaceOperations } from "./repository";
import { ungroupLayerTree } from "./operations";

const text={id:"text",type:"text" as const,name:"Text",locked:false,visible:true,version:1,geometry:{x:20,y:20,width:200,height:80,rotation:0},text:"FlowZ",color:"#111111",fontSize:32,align:"left" as const};
const document:ArtboardDocument={schemaVersion:ARTBOARD_DOCUMENT_VERSION,id:"document",name:"Board",format:{preset:"instagram-post",width:1080,height:1080},paint:{kind:"solid",color:"#FFFFFF"},rootLayerIds:["group"],layers:{group:{id:"group",type:"group",name:"Group",locked:false,visible:true,version:1,geometry:{x:0,y:0,width:300,height:200,rotation:15},childIds:["text"]},text},bindings:{},tokenRefs:{}};
const workspace:ArtboardWorkspace={schemaVersion:ARTBOARD_WORKSPACE_VERSION,id:"workspace",name:"Workspace",boards:{board:{id:"board",name:"Board",activeRevisionId:"revision",document,inputSnapshot:{id:"snapshot",createdAt:"2026-07-12T12:00:00.000Z",source:{projectId:"flow",nodeId:"artboard-node",signature:"v2"},ignoredSignatures:["v1"],bindings:{}},ancestry:{branchId:"branch"},createdAt:"2026-07-12T12:00:00.000Z"}},placements:{board:{x:0,y:0}},selectedBoardIds:["board"],activeBoardId:"board",pasteboard:{margin:100,gap:100,grid:10}};

describe("artboard P0 product completion",()=>{
  it("scopes the heavy workspace to the active document surface instead of the native viewport",()=>{
    const css=readFileSync(new URL("./artboard-workspace.css",import.meta.url),"utf8");
    const shell=css.slice(css.indexOf(".awb-shell"),css.indexOf(".awb-shell.has-left"));
    expect(shell).toContain("position: absolute");
    expect(shell).not.toContain("position: fixed");
  });
  it("validates persisted upstream provenance and ignored versions",()=>expect(()=>validateArtboardWorkspace(workspace)).not.toThrow());
  it("keeps group rotation in the canonical renderer",()=>expect(renderArtboardSvg(document,()=>"")).toContain('<g transform="rotate(15 150 100)">'));
  it("deletes group descendants atomically without unreachable layers",()=>{
    const next=applyWorkspaceOperations(workspace,[{type:"delete-layers",boardId:"board",layerIds:["group"]}]);
    expect(next.boards.board.document.layers).toEqual({});expect(next.boards.board.document.rootLayerIds).toEqual([]);
  });
  it("ungroups nested rotated groups without changing child placement or losing inherited state",()=>{
    const nested=structuredClone(workspace);const board=nested.boards.board;
    board.document.rootLayerIds=["outer"];
    board.document.layers.outer={id:"outer",type:"group",name:"Outer",locked:false,visible:true,version:1,geometry:{x:0,y:0,width:400,height:300,rotation:20},childIds:["group"]};
    const tree=ungroupLayerTree(nested,"board","group");
    expect((tree.layers.outer as {childIds:string[]}).childIds).toEqual(["text"]);
    expect(tree.layers.text.geometry.rotation).toBe(15);
    expect(()=>validateArtboardWorkspace({...nested,boards:{board:{...board,document:{...board.document,...tree}}}})).not.toThrow();
  });
  it("reorders children inside their actual group rather than corrupting roots",()=>{
    const nested=structuredClone(workspace);const board=nested.boards.board;
    board.document.layers.second={...text,id:"second",name:"Second",geometry:{...text.geometry,y:120}};
    (board.document.layers.group as {childIds:string[]}).childIds=["text","second"];
    const next=applyWorkspaceOperations(nested,[{type:"reorder-layer",boardId:"board",layerId:"text",direction:"forward"}]);
    expect((next.boards.board.document.layers.group as {childIds:string[]}).childIds).toEqual(["second","text"]);
    expect(next.boards.board.document.rootLayerIds).toEqual(["group"]);
  });
  it("embeds the exact CAS font identity in canonical preview and export SVG",()=>{
    const withFont=structuredClone(document);const layer=withFont.layers.text;if(layer.type!=="text")throw new Error("fixture");
    layer.fontFamily="Inter";layer.fontHash="a".repeat(64);layer.fontWeight=500;layer.fontStyle="italic";layer.fontAxes={wght:500};
    const svg=renderArtboardSvg(withFont,(hash)=>`flowz-media://localhost/${hash}`);
    expect(svg).toContain(`src:url('flowz-media://localhost/${"a".repeat(64)}')`);
    expect(svg).toContain("font-weight:500;font-style:italic");
    expect(svg).toContain("font-variation-settings=\"&apos;wght&apos; 500\"");
    expect(()=>renderArtboardSvg(withFont,()=>"data:font/ttf;base64,AA==")).toThrow(/exakten lokalen CAS/);
  });
  it("requires immutable library provenance to accompany its exact image CAS hash",()=>{
    const value=structuredClone(document);value.rootLayerIds=["image"];value.layers={image:{id:"image",type:"image",name:"Asset",locked:false,visible:true,version:1,geometry:{x:0,y:0,width:100,height:100,rotation:0},casHash:"b".repeat(64),assetVersionId:"version-1",fit:"contain"}};
    expect(()=>validateArtboardWorkspace({...workspace,boards:{board:{...workspace.boards.board,document:value}}})).not.toThrow();
    (value.layers.image as {assetVersionId?:string;casHash?:string}).casHash=undefined;
    expect(()=>validateArtboardWorkspace({...workspace,boards:{board:{...workspace.boards.board,document:value}}})).toThrow(/Bildreferenz|CAS-Hash/);
  });
});
