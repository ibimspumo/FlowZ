import { describe, expect, it } from "vitest";
import { variantOutputItems } from "./VariantOutputSockets";

describe("variant output sockets", () => {
  it("materializes only deliberately configured media siblings", () => {
    const items = variantOutputItems({ kind:"imageGeneration",label:"Images",status:"fresh",updatePolicy:"manual",fanOutResultIds:["b","a"],history:[
      {id:"a",createdAt:"now",value:"",blobHash:"a".repeat(64),mediaType:"image/png"},
      {id:"b",createdAt:"now",value:"",blobHash:"b".repeat(64),mediaType:"image/png"},
      {id:"text",createdAt:"now",value:"text"},
    ] });
    expect(items.map((item) => item.id)).toEqual(["b","a"]);
  });
});
