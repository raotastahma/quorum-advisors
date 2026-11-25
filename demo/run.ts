import { askDemo } from "./runtime.ts";

const result = await askDemo(process.argv.slice(2).join(" ") || "Hello, how should I learn through experiments?");
console.log(JSON.stringify({
  mode: "offline deterministic adapter using the application RagService",
  reply: result.replyText,
  retrieved: result.fragments.map(({ id, similarityScore }) => ({ id, similarityScore }))
}, null, 2));
