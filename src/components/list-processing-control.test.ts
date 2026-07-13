import { describe, expect, it } from "vitest";
import { hasConnectedListInput } from "./ListProcessingControl";

describe("list processing control", () => {
  it("appears only for a real typed list connection", () => {
    expect(hasConnectedListInput("target", [{ id:"e",source:"a",target:"target",sourceHandle:"images",targetHandle:"imageLists",data:{dataType:"imageList"} }] as any)).toBe(true);
    expect(hasConnectedListInput("target", [{ id:"e",source:"a",target:"target",sourceHandle:"image",targetHandle:"image",data:{dataType:"image"} }] as any)).toBe(false);
  });
});
